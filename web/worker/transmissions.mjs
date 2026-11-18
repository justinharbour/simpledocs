import { formatDocumentNumber, formatEnvelopeNumber, MAX_DOCUMENT_BYTES, MAX_DOCUMENTS } from '../shared/envelope.mjs';
import { buildCoverPage, prependCover, DEFAULT_FROM_NUMBER, DEFAULT_SENDER_NAME } from './cover-page.mjs';
import { enqueue, isTerminal, mailReviewHash, mark, refreshDelivery, sha256Hex, UUID } from './deliveries.mjs';
import { assembleEnvelope } from './envelope-pdf.mjs';
import { contact, mailApiKey } from './mail-send.mjs';
import { normalizePhone } from './phone.mjs';
import { createEmailDelivery, portalAvailable, portalMutationOriginOK, validatePortalRecipient } from './email-portal.mjs';
import { importPortalKey } from './portal-crypto.mjs';

const MAX_FAX_RECIPIENTS = 10;
const headers = { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' };
const reply = (body, status = 200) => Response.json(body, { status, headers });
const sameOrigin = request => request.headers.get('origin') === new URL(request.url).origin;
const str = (value, max) => (typeof value === 'string' ? value.trim().slice(0, max) : '');
const isoTime = value => (typeof value === 'string' && /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(value) ? `${value.replace(' ', 'T')}Z` : value ?? null);

// Recipient history is derived from the actor's existing sends, not a shared
// address book. Never expose return addresses or another actor's dispatches.
export async function listRecipients(request, env, actor) {
  if (request.method !== 'GET') return reply({ error: 'Method not allowed' }, 405);
  if (!env.DB) return reply({ error: 'Storage unavailable' }, 503);
  const rows = await env.DB.prepare("SELECT d.channel, d.recipient, d.options_json FROM dispatches d JOIN transmissions t ON t.id = d.transmission_id WHERE t.actor_id = ? AND d.channel IN ('fax', 'mail') ORDER BY d.created_at DESC LIMIT 200").bind(actor).all();
  // Portal deliveries are persisted at the provider's no-retry boundary; pending,
  // preparing and failed attempts are not evidence of an email submission.
  // Include older portal deliveries that predate email_attempts.
  const emailRows = await env.DB.prepare("SELECT recipient FROM portal_deliveries WHERE actor_id = ? AND send_status IN ('unknown', 'accepted') ORDER BY created_at DESC LIMIT 200").bind(actor).all();
  const fax = [], mail = [], seenFax = new Set(), seenMail = new Set();
  for (const row of rows.results ?? []) {
    if (row.channel === 'fax') {
      const number = normalizePhone(row.recipient);
      if (number && !seenFax.has(number)) { seenFax.add(number); fax.push(number); }
    } else {
      try {
        const address = contact(JSON.parse(row.options_json).to);
        const key = JSON.stringify(address).toLowerCase();
        if (!seenMail.has(key)) { seenMail.add(key); mail.push(address); }
      } catch { /* Ignore malformed or older dispatches. */ }
    }
  }
  const email = [], seenEmail = new Set();
  for (const row of emailRows.results ?? []) {
    const address = typeof row.recipient === 'string' ? row.recipient.trim() : '';
    const key = address.toLowerCase();
    if (address.length <= 254 && /^[^\s@<>\r\n]+@[^\s@<>\r\n]+\.[^\s@<>\r\n]+$/.test(address) && !seenEmail.has(key)) { seenEmail.add(key); email.push(address); }
  }
  return reply({ fax, mail, email });
}

async function readBounded(request) {
  const reader = request.body?.getReader();
  if (!reader) throw new Error('missing');
  const chunks = []; let size = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_DOCUMENT_BYTES + 65536) { await reader.cancel(); throw new Error('large'); }
    chunks.push(value);
  }
  return new Blob(chunks);
}

export async function getSettings(db) {
  const rows = await db.prepare('SELECT key, value FROM settings').bind().all();
  const map = Object.fromEntries((rows.results ?? []).map(r => [r.key, r.value]));
  let mailFrom = null;
  try { mailFrom = map.mail_from ? JSON.parse(map.mail_from) : null; } catch { /* ignore a bad stored value */ }
  return { senderName: map.sender_name || DEFAULT_SENDER_NAME, mailFrom };
}

export async function handleSettings(request, env, actor) {
  if (!env.DB) return reply({ error: 'Storage unavailable' }, 503);
  if (request.method === 'GET') {
    const raw = env.FAX_ESTIMATE_USD_PER_PAGE;
    const rate = typeof raw === 'string' && /^(?:0|[1-9]\d{0,2})(?:\.\d{1,6})?$/.test(raw) ? Number(raw) : null;
    return reply({ ...(await getSettings(env.DB)), faxFrom: env.TELNYX_FAX_FROM || DEFAULT_FROM_NUMBER, faxEstimate: rate === null ? { rate: 0.007, source: 'Telnyx published list rate, checked November 2026', url: 'https://telnyx.com/pricing/fax' } : { rate, source: 'Instance-configured page rate; verify with your provider', url: null } });
  }
  if (request.method !== 'PUT') return reply({ error: 'Method not allowed' }, 405);
  if (!sameOrigin(request)) return reply({ error: 'Invalid origin' }, 403);
  let body;
  try { body = await request.json(); } catch { return reply({ error: 'Invalid JSON' }, 400); }
  const now = new Date().toISOString();
  const put = (key, value) => env.DB.prepare('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at').bind(key, value, now).run();
  if (body?.senderName !== undefined) {
    const name = str(body.senderName, 120);
    if (!name) return reply({ error: 'Enter a sender name' }, 400);
    await put('sender_name', name);
  }
  if (body?.mailFrom !== undefined) {
    let from;
    try { from = contact(body.mailFrom); } catch { return reply({ error: 'Check the return address' }, 400); }
    await put('mail_from', JSON.stringify(from));
  }
  void actor;
  return reply(await getSettings(env.DB));
}

async function coverFields(env, settings, cover, title, recipient, pages) {
  return {
    to: str(cover?.to, 120), toNumber: recipient,
    from: str(cover?.from, 120) || settings.senderName, fromNumber: env.TELNYX_FAX_FROM || DEFAULT_FROM_NUMBER,
    subject: str(cover?.subject, 200) || title, message: str(cover?.message, 2000),
    date: str(cover?.date, 60) || new Date().toISOString().slice(0, 10), pages,
  };
}

// Preview only: nothing is stored or sent.
export async function handleCoverPreview(request, env) {
  if (request.method !== 'POST') return reply({ error: 'Method not allowed' }, 405);
  if (!sameOrigin(request)) return reply({ error: 'Invalid origin' }, 403);
  let body;
  try { body = await request.json(); } catch { return reply({ error: 'Invalid JSON' }, 400); }
  const settings = env.DB ? await getSettings(env.DB) : { senderName: DEFAULT_SENDER_NAME };
  const pages = Number.isSafeInteger(body?.pages) && body.pages > 0 ? body.pages : 0;
  const recipient = normalizePhone(body?.recipient) ?? '';
  const bytes = await buildCoverPage(await coverFields(env, settings, body, str(body?.title, 200), recipient, pages));
  return new Response(bytes, { headers: { ...headers, 'Content-Type': 'application/pdf', 'Content-Disposition': 'inline; filename="cover.pdf"' } });
}

function parseSpec(form) {
  let spec;
  try { spec = JSON.parse(form.get('spec')); } catch { throw new Error('Invalid request'); }
  if (!spec || typeof spec !== 'object') throw new Error('Invalid request');
  return spec;
}

export async function createTransmission(request, env, actor) {
  if (request.method !== 'POST') return reply({ error: 'Method not allowed' }, 405);
  if (!sameOrigin(request)) return reply({ error: 'Invalid origin' }, 403);
  if (!env.DB || !env.FILES) return reply({ error: 'Storage unavailable' }, 503);
  let form;
  try { form = await new Response(await readBounded(request), { headers: { 'Content-Type': request.headers.get('content-type') || '' } }).formData(); }
  catch { return reply({ error: 'Upload PDFs totaling up to 5 MB' }, 400); }
  // The plural field is intentionally distinct so old Workers reject a new
  // multi-file request rather than silently sending only its first file.
  const legacy = form.getAll('document'), ordered = form.getAll('documents'), numbered = form.getAll('numberedDocuments'), prepared = form.getAll('preparedDocuments'), preparedNumbered = form.getAll('preparedNumberedDocuments');
  const email = form.getAll('emailDocuments'), numberedEmail = form.getAll('numberedEmailDocuments');
  if (legacy.length > 1 || [legacy, ordered, numbered, email, numberedEmail, prepared, preparedNumbered].filter(parts => parts.length).length > 1) return reply({ error: 'Use only one document upload field' }, 400);
  const isPrepared = !!(prepared.length || preparedNumbered.length);
  const files = [preparedNumbered, prepared, numberedEmail, email, numbered, ordered, legacy].find(parts => parts.length) ?? [];
  if (!files.length || files.length > MAX_DOCUMENTS || files.some(file => !(file instanceof File) || !file.size) || files.reduce((size, file) => size + file.size, 0) > MAX_DOCUMENT_BYTES) {
    return reply({ error: `Upload 1 to ${MAX_DOCUMENTS} nonempty PDFs totaling up to 5 MB` }, 400);
  }
  let spec;
  try { spec = parseSpec(form); } catch { return reply({ error: 'Invalid request' }, 400); }
  if (!isPrepared && !!spec.email !== !!(email.length || numberedEmail.length)) return reply({ error: 'Use the email document field only with email delivery' }, 400);
  if (spec.email) {
    if (!portalMutationOriginOK(request, env)) return reply({ error: 'Email requires a same-origin request' }, 403);
    if (!portalAvailable(env)) return reply({ error: 'Email portal requires an encryption key, sender address, and email binding.' }, 503);
    try { await importPortalKey(env.PORTAL_KEY); } catch { return reply({ error: 'Email portal encryption key is invalid.' }, 503); }
    const invalid = validatePortalRecipient(spec.email, env);
    if (invalid) return reply({ error: invalid.error }, invalid.status);
  }

  const faxNumbers = [];
  if (spec.fax) {
    const list = Array.isArray(spec.fax.recipients) ? spec.fax.recipients : [];
    for (const raw of list) {
      const number = normalizePhone(raw);
      if (!number) return reply({ error: `"${str(raw, 40)}" is not a valid fax number` }, 400);
      if (!faxNumbers.includes(number)) faxNumbers.push(number);
    }
    if (!faxNumbers.length || faxNumbers.length > MAX_FAX_RECIPIENTS) return reply({ error: `Enter 1 to ${MAX_FAX_RECIPIENTS} fax numbers` }, 400);
    if (env.FAX_ENABLED !== 'true' || !env.TELNYX_API_TOKEN || !env.TELNYX_FAX_CONNECTION_ID || !env.DELIVERIES) return reply({ error: 'Fax sending is not configured' }, 503);
  }
  let mail = null;
  if (spec.mail) {
    try {
      mail = { to: contact(spec.mail.to), from: contact(spec.mail.from) };
    } catch { return reply({ error: 'Check the mailing and return addresses (US addresses only)' }, 400); }
    mail.color = spec.mail.color === true;
    mail.doubleSided = spec.mail.doubleSided === true;
    mail.mailingClass = spec.mail.mailingClass === 'standard_class' ? 'standard_class' : 'first_class';
  }
  if (!faxNumbers.length && !mail && !spec.email) return reply({ error: 'Choose at least one way to send' }, 400);

  let assembled;
  try { assembled = await assembleEnvelope(files, faxNumbers.length > 0 && spec.fax.cover?.enabled !== false, numbered.length > 0 || numberedEmail.length > 0 || preparedNumbered.length > 0); }
  catch (error) { return reply({ error: error instanceof Error ? error.message : 'The PDFs could not be read' }, 400); }
  const { pages, documents } = assembled;
  const title = str(spec.title, 200) || documents[0].name.replace(/\.pdf$/i, '') || 'Untitled document';

  const id = crypto.randomUUID();
  const allocation = await env.DB.prepare("INSERT INTO envelope_numbers (transmission_id) SELECT ? WHERE COALESCE((SELECT seq FROM sqlite_sequence WHERE name = 'envelope_numbers'), 0) < 999999 RETURNING number").bind(id).first();
  if (!allocation) return reply({ error: 'Envelope numbering is exhausted. Contact the instance administrator.' }, 503);
  const envelopeNumber = formatEnvelopeNumber(allocation.number);
  const manifest = documents.map((document, i) => ({ ...document, position: i + 1, number: formatDocumentNumber(envelopeNumber, i + 1) }));
  let bytes = assembled.bytes;
  if (assembled.stamp) {
    try { bytes = await assembled.stamp(envelopeNumber); }
    catch (error) { return reply({ error: error.message }, 400); }
  }
  if (spec.email && bytes.byteLength > MAX_DOCUMENT_BYTES) return reply({ error: 'The assembled email PDF exceeds 5 MB.' }, 400);
  const now = new Date().toISOString();
  const settings = await getSettings(env.DB);
  const sourceKey = `outbound/${id}/document.pdf`;
  await env.FILES.put(sourceKey, bytes, { httpMetadata: { contentType: 'application/pdf' } });
  const statements = [env.DB.prepare('INSERT INTO transmissions (id, actor_id, title, source_key, page_count, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(id, actor, title, sourceKey, pages, now, now)];
  if (spec.email) statements.push(env.DB.prepare("INSERT INTO email_attempts (transmission_id, actor_id, recipient, status, created_at) VALUES (?, ?, ?, 'pending', ?)").bind(id, actor, typeof spec.email.email === 'string' ? spec.email.email.slice(0, 254) : '', Date.now()));
  if (spec.email && isPrepared) statements.push(env.DB.prepare('INSERT INTO email_reviews (transmission_id, actor_id, options_json, pdf_sha256) VALUES (?, ?, ?, ?)').bind(id, actor, JSON.stringify({ email: spec.email.email, pinChannel: spec.email.pinChannel, phone: spec.email.pinChannel === 'none' ? null : normalizePhone(spec.email.phone) }), await sha256Hex(bytes)));
  for (const doc of manifest) statements.push(env.DB.prepare('INSERT INTO envelope_documents (transmission_id, position, name, page_count) VALUES (?, ?, ?, ?)').bind(id, doc.position, doc.name, doc.pageCount));
  const addDelivery = (deliveryId, channel, recipient, options, status) => {
    statements.push(env.DB.prepare('INSERT INTO dispatches (id, transmission_id, channel, recipient, options_json, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').bind(deliveryId, id, channel, recipient, JSON.stringify(options), status, now, now));
    statements.push(env.DB.prepare('INSERT INTO timeline (delivery_id, at, status, detail) VALUES (?, ?, ?, ?)').bind(deliveryId, now, status, status === 'awaiting_approval' ? 'Waiting for your review' : null));
  };
  const created = [];
  for (const number of faxNumbers) {
    const deliveryId = crypto.randomUUID();
    const options = {};
    let packet = bytes;
    if (spec.fax.cover?.enabled !== false) {
      const coverKey = `covers/${id}/${deliveryId}.pdf`;
      const fields = await coverFields(env, settings, spec.fax.cover, title, number, pages);
      if (spec.fax.cover?.includeNumbers === true) fields.numbering = { envelopeNumber, documentNumbers: manifest.map(d => d.number) };
      const cover = await buildCoverPage(fields);
      await env.FILES.put(coverKey, cover, { httpMetadata: { contentType: 'application/pdf' } });
      options.coverKey = coverKey;
      packet = await prependCover(cover, bytes);
    }
    options.packetKey = `outbound/${id}/fax/${deliveryId}.pdf`;
    options.packetSha256 = await sha256Hex(packet);
    options.from = env.TELNYX_FAX_FROM;
    await env.FILES.put(options.packetKey, packet, { httpMetadata: { contentType: 'application/pdf' } });
    const status = isPrepared ? 'awaiting_approval' : 'queued';
    addDelivery(deliveryId, 'fax', number, options, status);
    created.push({ id: deliveryId, channel: 'fax', status });
  }
  if (mail) {
    const deliveryId = crypto.randomUUID();
    const content = { ...mail, transmissionId: id, pdfSha256: await sha256Hex(bytes) };
    statements.push(env.DB.prepare('INSERT INTO mail_drafts (id, actor_id, revision, content_json, created_at, updated_at) VALUES (?, ?, 1, ?, ?, ?)').bind(deliveryId, actor, JSON.stringify(content), now, now));
    addDelivery(deliveryId, 'mail', `${mail.to.firstName}${mail.to.lastName ? ` ${mail.to.lastName}` : ''}, ${mail.to.city} ${mail.to.provinceOrState}`, mail, 'awaiting_approval');
    created.push({ id: deliveryId, channel: 'mail', status: 'awaiting_approval' });
  }
  await env.DB.batch(statements);
  if (!isPrepared) for (const item of created) if (item.channel === 'fax') await enqueue(env, id, 'fax', item.id);
  if (spec.email && isPrepared) created.push({ id, channel: 'email', status: 'awaiting_approval' });
  if (spec.email && !isPrepared) {
    try {
      const origin = new URL(request.url).origin;
      const { email, pinChannel, phone } = spec.email;
      const emailRequest = new Request(`${origin}/api/transmissions/${id}/email`, { method: 'POST', headers: { origin: request.headers.get('origin'), 'content-type': 'application/json' }, body: JSON.stringify({ email, pinChannel, phone: pinChannel === 'none' ? undefined : phone }) });
      const response = await createEmailDelivery(emailRequest, env, actor, id, true);
      const result = await response.json();
      if (!response.ok) created.push({ channel: 'email', status: 'failed', error: result.error || 'Email could not be sent.' });
      else created.push({ id: result.id, channel: 'email', status: result.status });
    } catch { created.push({ channel: 'email', status: 'unknown', error: 'Email outcome is unknown. Check Records before trying again.' }); }
  }
  return reply({ id, envelopeNumber, documents: manifest, deliveries: created }, 202);
}

const deliveryView = (row, transmissionId, timeline) => ({
  id: row.id, channel: row.channel, recipient: row.recipient, status: row.status, providerStatus: row.provider_status, error: row.error,
  createdAt: row.created_at, updatedAt: row.updated_at, submittedAt: row.submitted_at, finishedAt: row.finished_at,
  needsApproval: row.status === 'awaiting_approval',
  coverUrl: row.channel === 'fax' && JSON.parse(row.options_json).coverKey ? `/api/transmissions/${transmissionId}/cover/${row.id}` : null,
  packetUrl: row.channel === 'fax' && JSON.parse(row.options_json).packetKey ? `/api/transmissions/${transmissionId}/packet/${row.id}` : null,
  timeline,
});

export async function listTransmissions(env, actor) {
  if (!env.DB) return reply({ error: 'Storage unavailable' }, 503);
  const rows = await env.DB.prepare('SELECT t.id, t.title, t.page_count, t.created_at, t.updated_at, n.number FROM transmissions t LEFT JOIN envelope_numbers n ON n.transmission_id = t.id WHERE t.actor_id = ? ORDER BY t.created_at DESC, t.id DESC LIMIT 100').bind(actor).all();
  const deliveries = await env.DB.prepare('SELECT transmission_id, id, channel, status FROM dispatches WHERE transmission_id IN (SELECT id FROM transmissions WHERE actor_id = ? ORDER BY created_at DESC, id DESC LIMIT 100)').bind(actor).all();
  const emails = await env.DB.prepare('SELECT a.transmission_id, a.delivery_id, a.status, p.revoked_at FROM email_attempts a LEFT JOIN portal_deliveries p ON p.id = a.delivery_id WHERE a.actor_id = ? AND a.transmission_id IN (SELECT id FROM transmissions WHERE actor_id = ? ORDER BY created_at DESC, id DESC LIMIT 100)').bind(actor, actor).all();
  const by = new Map();
  for (const d of deliveries.results ?? []) by.set(d.transmission_id, [...(by.get(d.transmission_id) ?? []), { id: d.id, channel: d.channel, status: d.status }]);
  for (const d of emails.results ?? []) by.set(d.transmission_id, [...(by.get(d.transmission_id) ?? []), { id: d.delivery_id ?? d.transmission_id, channel: 'email', status: d.revoked_at ? 'revoked' : ['preparing', 'pending'].includes(d.status) ? 'unknown' : d.status }]);
  return reply({ transmissions: (rows.results ?? []).map(r => ({ id: r.id, title: r.title, envelopeNumber: r.number == null ? null : formatEnvelopeNumber(r.number), pageCount: r.page_count, createdAt: r.created_at, updatedAt: r.updated_at, channels: by.get(r.id) ?? [] })) });
}

export async function getTransmission(env, actor, id, fetcher = fetch) {
  if (!env.DB) return reply({ error: 'Storage unavailable' }, 503);
  if (!UUID.test(id)) return reply({ error: 'Not found' }, 404);
  const tx = await env.DB.prepare('SELECT t.id, t.title, t.page_count, t.created_at, t.updated_at, n.number FROM transmissions t LEFT JOIN envelope_numbers n ON n.transmission_id = t.id WHERE t.id = ? AND t.actor_id = ?').bind(id, actor).first();
  if (!tx) return reply({ error: 'Not found' }, 404);
  const envelopeNumber = tx.number == null ? null : formatEnvelopeNumber(tx.number);
  const documents = envelopeNumber ? ((await env.DB.prepare('SELECT position, name, page_count FROM envelope_documents WHERE transmission_id = ? ORDER BY position').bind(id).all()).results ?? []).map(doc => ({ position: doc.position, name: doc.name, pageCount: doc.page_count, number: formatDocumentNumber(envelopeNumber, doc.position) })) : [];
  let rows = (await env.DB.prepare('SELECT * FROM dispatches WHERE transmission_id = ? ORDER BY created_at, id').bind(id).all()).results ?? [];
  const open = rows.filter(r => ['submitting', 'accepted'].includes(r.status));
  if (open.length) {
    // Polling the detail also reconciles with the provider's own status.
    for (const row of open) await refreshDelivery(env, row, fetcher);
    rows = (await env.DB.prepare('SELECT * FROM dispatches WHERE transmission_id = ? ORDER BY created_at, id').bind(id).all()).results ?? [];
  }
  const deliveries = [];
  for (const row of rows) {
    const timeline = (await env.DB.prepare('SELECT at, status, detail FROM timeline WHERE delivery_id = ? ORDER BY id').bind(row.id).all()).results ?? [];
    deliveries.push(deliveryView(row, id, timeline));
  }
  const emails = await env.DB.prepare('SELECT a.delivery_id, a.recipient, a.status, a.error, a.created_at, p.revoked_at, p.expires_at FROM email_attempts a LEFT JOIN portal_deliveries p ON p.id = a.delivery_id WHERE a.transmission_id = ? AND a.actor_id = ?').bind(id, actor).all();
  for (const email of emails.results ?? []) deliveries.push({ id: email.delivery_id ?? id, channel: 'email', recipient: email.recipient, status: email.revoked_at ? 'revoked' : ['preparing', 'pending'].includes(email.status) ? 'unknown' : email.status, canRevoke: !!(email.delivery_id && !email.revoked_at && email.expires_at > Date.now()), providerStatus: null, error: email.error, createdAt: new Date(email.created_at).toISOString(), updatedAt: new Date(email.created_at).toISOString(), submittedAt: null, finishedAt: null, needsApproval: false, coverUrl: null, timeline: [] });
  // Email exposes submission acceptance, not a provider delivery status feed.
  const settled = deliveries.every(d => d.channel === 'email' || isTerminal(d.status));
  const refreshed = await env.DB.prepare('SELECT updated_at FROM transmissions WHERE id = ?').bind(id).first();
  return reply({ id, envelopeNumber, documents, title: tx.title, pageCount: tx.page_count, createdAt: tx.created_at, updatedAt: refreshed?.updated_at ?? tx.updated_at, documentUrl: `/api/transmissions/${id}/document`, settled, deliveries });
}

async function pdfResponse(env, key, name) {
  const object = await env.FILES.get(key);
  if (!object) return reply({ error: 'Not found' }, 404);
  return new Response(object.body ?? await object.arrayBuffer(), { headers: { ...headers, 'Content-Type': 'application/pdf', 'Content-Disposition': `inline; filename="${name}"` } });
}

export async function getTransmissionFile(env, actor, id, kind, deliveryId) {
  if (!env.DB || !env.FILES) return reply({ error: 'Storage unavailable' }, 503);
  if (!UUID.test(id)) return reply({ error: 'Not found' }, 404);
  const tx = await env.DB.prepare('SELECT source_key FROM transmissions WHERE id = ? AND actor_id = ?').bind(id, actor).first();
  if (!tx) return reply({ error: 'Not found' }, 404);
  if (kind === 'document') return pdfResponse(env, tx.source_key, 'document.pdf');
  if (!UUID.test(deliveryId ?? '')) return reply({ error: 'Not found' }, 404);
  const row = await env.DB.prepare("SELECT options_json FROM dispatches WHERE id = ? AND transmission_id = ? AND channel = 'fax'").bind(deliveryId, id).first();
  const key = row ? JSON.parse(row.options_json)[kind === 'packet' ? 'packetKey' : 'coverKey'] : null;
  return key ? pdfResponse(env, key, kind === 'packet' ? 'fax-packet.pdf' : 'cover.pdf') : reply({ error: 'Not found' }, 404);
}

async function faxContext(env, actor, id, deliveryId) {
  if (!UUID.test(id) || !UUID.test(deliveryId)) return null;
  const row = await env.DB.prepare("SELECT d.* FROM dispatches d JOIN transmissions t ON t.id = d.transmission_id WHERE d.id = ? AND d.transmission_id = ? AND t.actor_id = ? AND d.channel = 'fax'").bind(deliveryId, id, actor).first();
  if (!row) return null;
  const options = JSON.parse(row.options_json);
  if (!options.packetKey || !options.packetSha256 || !options.from) return null;
  const object = await env.FILES.get(options.packetKey);
  if (!object || await sha256Hex(new Uint8Array(await object.arrayBuffer())) !== options.packetSha256) return null;
  const reviewHash = await sha256Hex(JSON.stringify({ id, deliveryId, recipient: row.recipient, from: options.from, packetSha256: options.packetSha256 }));
  return { row, options, reviewHash };
}

export async function reviewFax(request, env, actor, id, deliveryId) {
  if (request.method !== 'GET') return reply({ error: 'Method not allowed' }, 405);
  if (!env.DB || !env.FILES) return reply({ error: 'Storage unavailable' }, 503);
  const ctx = await faxContext(env, actor, id, deliveryId);
  if (!ctx) return reply({ error: 'Fax proof unavailable' }, 404);
  return reply({ recipient: ctx.row.recipient, from: ctx.options.from, status: ctx.row.status, reviewHash: ctx.reviewHash, packetSha256: ctx.options.packetSha256, packetUrl: `/api/transmissions/${id}/packet/${deliveryId}` });
}

export async function approveFax(request, env, actor, id, deliveryId) {
  if (request.method !== 'POST') return reply({ error: 'Method not allowed' }, 405);
  if (!sameOrigin(request)) return reply({ error: 'Invalid origin' }, 403);
  if (!env.DB || !env.FILES || !env.DELIVERIES) return reply({ error: 'Storage unavailable' }, 503);
  let body; try { body = await request.json(); } catch { return reply({ error: 'Invalid request' }, 400); }
  if (!body || Object.keys(body).sort().join(',') !== 'confirmed,reviewHash' || body.confirmed !== true || !/^[a-f0-9]{64}$/.test(body.reviewHash ?? '')) return reply({ error: 'Review and confirm the fax' }, 400);
  const ctx = await faxContext(env, actor, id, deliveryId);
  if (!ctx) return reply({ error: 'Fax proof unavailable' }, 404);
  if (ctx.row.status !== 'awaiting_approval' || ctx.reviewHash !== body.reviewHash) return reply({ error: 'Fax review no longer matches' }, 409);
  if (env.FAX_ENABLED !== 'true' || !env.TELNYX_API_TOKEN || !env.TELNYX_FAX_CONNECTION_ID || env.TELNYX_FAX_FROM !== ctx.options.from) return reply({ error: 'Fax configuration changed or is unavailable; prepare a new fax' }, 503);
  const now = new Date().toISOString();
  const changed = await env.DB.prepare("UPDATE dispatches SET status = 'queued', updated_at = ? WHERE id = ? AND transmission_id = ? AND channel = 'fax' AND recipient = ? AND status = 'awaiting_approval' AND options_json = ?").bind(now, deliveryId, id, ctx.row.recipient, ctx.row.options_json).run();
  if (changed.meta.changes !== 1) return reply({ error: 'Fax already approved or changed' }, 409);
  try { await env.DB.prepare("INSERT INTO timeline (delivery_id, at, status, detail) VALUES (?, ?, 'queued', 'Fax proof approved')").bind(deliveryId, now).run(); } catch { /* The queue backstop still recovers an approved delivery. */ }
  await enqueue(env, id, 'fax', deliveryId);
  return reply({ status: 'queued' });
}

async function emailReviewContext(env, actor, id) {
  if (!UUID.test(id)) return null;
  const row = await env.DB.prepare('SELECT r.options_json, r.pdf_sha256, t.source_key, a.status FROM email_reviews r JOIN transmissions t ON t.id = r.transmission_id AND t.actor_id = r.actor_id JOIN email_attempts a ON a.transmission_id = r.transmission_id AND a.actor_id = r.actor_id WHERE r.transmission_id = ? AND r.actor_id = ?').bind(id, actor).first();
  if (!row) return null;
  const object = await env.FILES.get(row.source_key);
  if (!object || await sha256Hex(new Uint8Array(await object.arrayBuffer())) !== row.pdf_sha256) return null;
  const options = JSON.parse(row.options_json);
  return { row, options, reviewHash: await sha256Hex(JSON.stringify({ transmissionId: id, options, pdfSha256: row.pdf_sha256 })) };
}

export async function reviewEmail(request, env, actor, id) {
  if (request.method !== 'GET') return reply({ error: 'Method not allowed' }, 405);
  if (!env.DB || !env.FILES) return reply({ error: 'Storage unavailable' }, 503);
  const ctx = await emailReviewContext(env, actor, id);
  if (!ctx) return reply({ error: 'Email proof unavailable' }, 404);
  return reply({ ...ctx.options, status: ctx.row.status, reviewHash: ctx.reviewHash, pdfSha256: ctx.row.pdf_sha256, packetUrl: `/api/transmissions/${id}/document` });
}

export async function approveEmail(request, env, actor, id) {
  if (request.method !== 'POST') return reply({ error: 'Method not allowed' }, 405);
  if (!portalMutationOriginOK(request, env)) return reply({ error: 'Invalid origin' }, 403);
  if (!env.DB || !env.FILES) return reply({ error: 'Storage unavailable' }, 503);
  let body; try { body = await request.json(); } catch { return reply({ error: 'Invalid request' }, 400); }
  if (!body || Object.keys(body).sort().join(',') !== 'confirmed,reviewHash' || body.confirmed !== true || !/^[a-f0-9]{64}$/.test(body.reviewHash ?? '')) return reply({ error: 'Review and confirm the email' }, 400);
  const ctx = await emailReviewContext(env, actor, id);
  if (!ctx) return reply({ error: 'Email proof unavailable' }, 404);
  if (ctx.row.status !== 'pending' || body.reviewHash !== ctx.reviewHash) return reply({ error: 'Email review no longer matches' }, 409);
  const origin = new URL(request.url).origin;
  const send = new Request(`${origin}/api/transmissions/${id}/email`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(ctx.options) });
  return createEmailDelivery(send, env, actor, id, true, ctx.reviewHash);
}

async function mailContext(env, actor, id, deliveryId) {
  if (!UUID.test(id) || !UUID.test(deliveryId)) return null;
  const row = await env.DB.prepare("SELECT d.status, d.options_json, t.source_key, t.page_count FROM dispatches d JOIN transmissions t ON t.id = d.transmission_id WHERE d.id = ? AND d.transmission_id = ? AND t.actor_id = ? AND d.channel = 'mail'").bind(deliveryId, id, actor).first();
  if (!row) return null;
  const object = await env.FILES.get(row.source_key);
  if (!object) return null;
  const options = JSON.parse(row.options_json);
  const summary = { to: options.to, from: options.from, color: options.color, doubleSided: options.doubleSided, mailingClass: options.mailingClass };
  return { row, options, summary, pdfSha256: await sha256Hex(new Uint8Array(await object.arrayBuffer())) };
}

export async function reviewMail(request, env, actor, id, deliveryId) {
  if (request.method !== 'GET') return reply({ error: 'Method not allowed' }, 405);
  if (!env.DB || !env.FILES) return reply({ error: 'Storage unavailable' }, 503);
  const mode = new URL(request.url).searchParams.get('mode');
  if (!['test', 'live'].includes(mode)) return reply({ error: 'Select test or live mode' }, 400);
  const ctx = await mailContext(env, actor, id, deliveryId);
  if (!ctx) return reply({ error: 'Not found' }, 404);
  const reviewHash = await mailReviewHash({ id: deliveryId, revision: 1, mode, summary: ctx.summary, pdfSha256: ctx.pdfSha256 });
  return reply({ mode, reviewHash, pageCount: ctx.row.page_count, summary: ctx.summary, status: ctx.row.status, available: !!mailApiKey(env, mode) && env.MAIL_ENABLED === 'true', notice: 'Local review of the exact addresses, options and PDF. PostGrid renders and prints the final letter.' });
}

export async function approveMail(request, env, actor, id, deliveryId) {
  if (request.method !== 'POST') return reply({ error: 'Method not allowed' }, 405);
  if (!sameOrigin(request)) return reply({ error: 'Invalid origin' }, 403);
  if (!env.DB || !env.FILES || !env.DELIVERIES) return reply({ error: 'Storage unavailable' }, 503);
  if (env.MAIL_ENABLED !== 'true') return reply({ error: 'Mail sending unavailable' }, 503);
  let body;
  try { body = await request.json(); } catch { return reply({ error: 'Invalid request' }, 400); }
  if (!body || Object.keys(body).sort().join(',') !== 'confirmed,mode,reviewHash' || body.confirmed !== true || !['test', 'live'].includes(body.mode) || !/^[a-f0-9]{64}$/.test(body.reviewHash ?? '')) return reply({ error: 'Review the letter and confirm to send' }, 400);
  if (!mailApiKey(env, body.mode)) return reply({ error: 'Selected mail mode is unavailable' }, 503);
  const ctx = await mailContext(env, actor, id, deliveryId);
  if (!ctx) return reply({ error: 'Not found' }, 404);
  if (ctx.row.status !== 'awaiting_approval') return reply({ error: 'This letter was already approved' }, 409);
  if (await mailReviewHash({ id: deliveryId, revision: 1, mode: body.mode, summary: ctx.summary, pdfSha256: ctx.pdfSha256 }) !== body.reviewHash) return reply({ error: 'Review does not match' }, 409);
  const options = { ...ctx.options, approval: { mode: body.mode, reviewHash: body.reviewHash, approvedAt: new Date().toISOString() } };
  const changed = await env.DB.prepare("UPDATE dispatches SET options_json = ? WHERE id = ? AND status = 'awaiting_approval'").bind(JSON.stringify(options), deliveryId).run();
  if (changed.meta.changes !== 1) return reply({ error: 'This letter was already approved' }, 409);
  // Only an approved row is ever put on the queue.
  await mark(env, deliveryId, 'queued', { providerStatus: body.mode === 'test' ? 'test mode' : 'live mode' });
  await enqueue(env, id, 'mail', deliveryId);
  return reply({ id: deliveryId, status: 'queued' }, 202);
}

export async function listRecords(env, actor, { inboundAllowed, voiceAllowed }) {
  if (!env.DB) return reply({ error: 'Storage unavailable' }, 503);
  const items = [];
  const sent = await (await listTransmissions(env, actor)).json();
  for (const t of sent.transmissions) items.push({ type: 'transmission', id: t.id, title: t.title, envelopeNumber: t.envelopeNumber, createdAt: t.createdAt, updatedAt: t.updatedAt, channels: t.channels, pageCount: t.pageCount, previewUrl: `/api/transmissions/${t.id}/document`, previewType: 'pdf' });
  if (inboundAllowed) {
    const faxes = await env.DB.prepare("SELECT event_id, fax_id, received_at FROM inbound_fax_events WHERE event_type = 'fax.received' AND object_key IS NOT NULL ORDER BY received_at DESC, event_id DESC LIMIT 100").bind().all();
    for (const f of faxes.results ?? []) items.push({ type: 'inbound_fax', id: f.event_id, title: 'Inbound fax', createdAt: f.received_at, updatedAt: f.received_at, channels: [{ channel: 'fax', status: 'received' }], previewUrl: `/api/inbound-faxes/${f.event_id}/pdf?inline=1`, previewType: 'pdf' });
  }
  if (voiceAllowed) {
    const recs = await env.DB.prepare('SELECT recording_id, archived_at, kind, direction, from_number, to_number, duration_secs, heard_at, transcript FROM voice_recordings ORDER BY archived_at DESC, recording_id DESC LIMIT 100').bind().all();
    for (const r of recs.results ?? []) {
      const at = isoTime(r.archived_at);
      items.push({ type: 'recording', id: r.recording_id, title: r.kind === 'voicemail' ? 'Voicemail' : 'Call recording', createdAt: at, updatedAt: r.heard_at ? isoTime(r.heard_at) : at, channels: [{ channel: 'voice', status: r.heard_at ? 'heard' : 'unheard' }], kind: r.kind, direction: r.direction, fromNumber: r.from_number, toNumber: r.to_number, durationSecs: r.duration_secs, transcript: r.transcript, previewUrl: `/api/voice/recordings/${r.recording_id}`, previewType: 'audio' });
    }
  }
  items.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  return reply({ records: items.slice(0, 200) });
}
