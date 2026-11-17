// Local review describes exact provider input, not a PostGrid-rendered proof.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const reply = (body, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
const text = (v, max) => typeof v === 'string' && v.trim().length > 0 && v.length <= max;
const escape = s => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');

function contact(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('Invalid address');
  const fields = ['firstName', 'lastName', 'addressLine1', 'addressLine2', 'city', 'provinceOrState', 'postalOrZip', 'countryCode'];
  if (Object.keys(value).some(k => !fields.includes(k)) || !['firstName', 'addressLine1', 'city', 'provinceOrState', 'postalOrZip'].every(k => text(value[k], 150)) || value.countryCode !== 'US' || fields.some(k => value[k] !== undefined && !text(value[k], 150))) throw Error('Invalid address');
  return Object.fromEntries(fields.filter(k => value[k] !== undefined).map(k => [k, value[k]]));
}

export function letterPayload(content, id) {
  if (!content || typeof content !== 'object' || Array.isArray(content) || Object.keys(content).some(k => !['to', 'from', 'text', 'color', 'doubleSided', 'mailingClass'].includes(k)) || !text(content.text, 40000) || typeof content.color !== 'boolean' || typeof content.doubleSided !== 'boolean' || !['first_class', 'standard_class'].includes(content.mailingClass)) throw Error('Invalid letter');
  // Reject braces and ampersands (including encoded/nested entity forms) until
  // provider template parsing and its decode order are verified.
  if (/[{}&]/u.test(content.text)) throw Error('Template delimiters unsupported');
  // No arbitrary HTML, templates, external assets, or provider contact IDs.
  const html = `<!doctype html><html><body><div style="white-space: pre-wrap">${escape(content.text)}</div></body></html>`;
  return { to: contact(content.to), from: contact(content.from), html, color: content.color, doubleSided: content.doubleSided, mailingClass: content.mailingClass, size: 'us_letter', paper: 'standard', envelope: 'standard', addressPlacement: 'insert_blank_page', metadata: { simpledocsDraftId: id } };
}

export async function listUnresolvedMail(request, env, actor) {
  if (request.method !== 'GET') return reply({ error: 'Method not allowed' }, 405);
  if (!env.DB) return reply({ error: 'Mail storage unavailable' }, 503);
  const result = await env.DB.prepare("SELECT draft_id, revision, status, confirmed_at, updated_at FROM mail_intents WHERE actor_id = ? AND status IN ('submitting', 'unknown') ORDER BY confirmed_at DESC LIMIT 100").bind(actor).all();
  return reply({ orders: result.results });
}

async function digest(s) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('');
}

async function readJson(request) {
  if (request.headers.get('origin') !== new URL(request.url).origin || request.headers.get('content-type') !== 'application/json') throw Error('origin');
  if (!request.body) throw Error('body');
  const reader = request.body.getReader(); const chunks = []; let size = 0;
  for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > 2048) { await reader.cancel(); throw Error('body'); } chunks.push(value); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
}

export async function handleMail(request, env, actor, id, action, fetcher = fetch) {
  if (!UUID.test(id)) return reply({ error: 'Invalid draft ID' }, 400);
  if (!env.DB) return reply({ error: 'Mail storage unavailable' }, 503);
  if (action === 'status' && request.method === 'GET') {
    const row = await env.DB.prepare('SELECT revision, status, provider_id, confirmed_at, updated_at FROM mail_intents WHERE draft_id = ? AND actor_id = ?').bind(id, actor).first();
    return row ? reply(row) : reply({ error: 'Not found' }, 404);
  }
  if (action === 'review' && request.method === 'GET') {
    const row = await env.DB.prepare('SELECT revision, content_json FROM mail_drafts WHERE id = ? AND actor_id = ?').bind(id, actor).first();
    if (!row) return reply({ error: 'Not found' }, 404);
    try {
      const payload = letterPayload(JSON.parse(row.content_json), id);
      const reviewHash = await digest(JSON.stringify({ id, revision: row.revision, payload }));
      return reply({ revision: row.revision, reviewHash, payload, notice: 'Local content review only; final PostGrid rendering and postal delivery may differ. Sending creates a paid order.' });
    } catch { return reply({ error: 'Draft is not a supported letter; remove braces and ampersands from letter text and check required fields' }, 400); }
  }
  if (action !== 'send' || request.method !== 'POST') return reply({ error: 'Method not allowed' }, 405);
  if (env.MAIL_ENABLED !== 'true' || typeof env.POSTGRID_API_KEY !== 'string' || !env.POSTGRID_API_KEY.trim()) return reply({ error: 'Mail sending unavailable' }, 503);
  let body;
  try { body = await readJson(request); } catch { return reply({ error: 'Invalid request' }, 400); }
  if (!body || Object.keys(body).sort().join(',') !== 'confirmed,reviewHash,revision' || body.confirmed !== true || !Number.isSafeInteger(body.revision) || body.revision < 1 || !/^[a-f0-9]{64}$/.test(body.reviewHash ?? '')) return reply({ error: 'Explicit confirmation of reviewed content required' }, 400);
  const row = await env.DB.prepare('SELECT revision, content_json FROM mail_drafts WHERE id = ? AND actor_id = ?').bind(id, actor).first();
  if (!row || row.revision !== body.revision) return reply({ error: 'Draft changed or not found' }, 409);
  let payload;
  try { payload = letterPayload(JSON.parse(row.content_json), id); } catch { return reply({ error: 'Draft is not a supported letter' }, 400); }
  const payloadJson = JSON.stringify(payload);
  if (await digest(JSON.stringify({ id, revision: row.revision, payload })) !== body.reviewHash) return reply({ error: 'Review does not match' }, 409);
  const now = new Date().toISOString();
  // A single atomic insert both checks the exact draft and consumes its only claim.
  const claim = await env.DB.prepare("INSERT INTO mail_intents (draft_id, actor_id, revision, review_hash, payload_json, status, confirmed_at, updated_at) SELECT id, actor_id, revision, ?, ?, 'submitting', ?, ? FROM mail_drafts WHERE id = ? AND actor_id = ? AND revision = ? AND content_json = ? ON CONFLICT DO NOTHING").bind(body.reviewHash, payloadJson, now, now, id, actor, row.revision, row.content_json).run();
  if (claim.meta.changes !== 1) return reply({ error: 'Draft changed, already claimed, or an unresolved order exists; check unresolved orders' }, 409);
  let status = 'unknown'; let providerId = null;
  try {
    const response = await fetcher('https://api.postgrid.com/print-mail/v1/letters', { method: 'POST', headers: { 'X-API-Key': env.POSTGRID_API_KEY, 'Content-Type': 'application/json' }, body: payloadJson, redirect: 'error' });
    if (response.status === 201) {
      const result = await response.json();
      if (result?.object === 'letter' && typeof result.id === 'string' && /^letter_[a-zA-Z0-9]+$/.test(result.id)) { status = 'accepted'; providerId = result.id; }
    }
  } catch { /* Any failure after claim may have created an order. */ }
  await env.DB.prepare("UPDATE mail_intents SET status = ?, provider_id = ?, updated_at = ? WHERE draft_id = ? AND actor_id = ? AND status = 'submitting'").bind(status, providerId, new Date().toISOString(), id, actor).run();
  return reply({ id, status, providerId }, status === 'accepted' ? 202 : 200);
}
