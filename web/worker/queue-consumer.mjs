import { prependCover } from './cover-page.mjs';
import { enqueue, isTerminal, mailReviewHash, mark, reflectFax, refreshDelivery, sha256Hex, UUID } from './deliveries.mjs';
import { prepareFax, sendPreparedFax } from './fax-intents.mjs';
import { mailApiKey } from './mail-send.mjs';
import { submitFax } from './telnyx-fax.mjs';

const MAX_RETRIES = 5;
const RETRY_SECONDS = 30;
const STALE_QUEUED_MS = 3 * 60 * 1000;
const GIVE_UP_MS = 24 * 60 * 60 * 1000;
const E164 = /^\+[1-9]\d{1,14}$/;

// Transient: try again later. Permanent: mark failed with a reason that is safe
// to show, then acknowledge so the message is never retried.
class Transient extends Error {}
class Permanent extends Error {}
class Waiting extends Error {}

const transientStatus = status => status >= 500 || [408, 409, 425, 429].includes(status);

async function loadRow(env, body) {
  if (!body || !UUID.test(body.deliveryId ?? '') || !UUID.test(body.transmissionId ?? '') || !['fax', 'mail'].includes(body.channel)) return null;
  return env.DB.prepare('SELECT d.*, t.actor_id, t.source_key FROM dispatches d JOIN transmissions t ON t.id = d.transmission_id WHERE d.id = ? AND d.transmission_id = ? AND d.channel = ?').bind(body.deliveryId, body.transmissionId, body.channel).first();
}

async function readObject(env, key) {
  let object;
  try { object = await env.FILES.get(key); } catch { throw new Transient('storage'); }
  if (!object) throw new Permanent('The stored document is missing');
  return new Uint8Array(await object.arrayBuffer());
}

async function sendFax(env, row, fetcher) {
  const existing = await env.DB.prepare('SELECT status FROM fax_intents WHERE id = ?').bind(row.id).first();
  // Redelivery after a provider submission: never submit again.
  if (existing && existing.status !== 'prepared') { await reflectFax(env.DB, row, await env.DB.prepare('SELECT status, provider_id FROM fax_intents WHERE id = ?').bind(row.id).first()); return; }
  const config = { enabled: env.FAX_ENABLED === 'true', token: env.TELNYX_API_TOKEN, connectionId: env.TELNYX_FAX_CONNECTION_ID, from: env.TELNYX_FAX_FROM };
  if (!config.enabled || !config.token || !config.connectionId || !E164.test(config.from ?? '')) throw new Permanent('Fax sending is not configured');
  const options = JSON.parse(row.options_json);
  const source = await readObject(env, row.source_key);
  let bytes = source;
  if (options.coverKey) {
    try { bytes = await prependCover(await readObject(env, options.coverKey), source); }
    catch (error) { if (error instanceof Transient || error instanceof Permanent) throw error; throw new Permanent('The document could not be combined with the cover page'); }
  }
  const mediaName = `simpledocs-${row.id}.pdf`;
  if (!existing) await prepareFax(env.DB, { id: row.id, actor: row.actor_id, destination: row.recipient, mediaName });
  const upload = new FormData();
  upload.set('media', new Blob([bytes], { type: 'application/pdf' }), 'document.pdf');
  upload.set('media_name', mediaName);
  upload.set('ttl_secs', '172800');
  let response;
  try { response = await fetcher('https://api.telnyx.com/v2/media', { method: 'POST', headers: { Authorization: `Bearer ${config.token}` }, body: upload, redirect: 'manual' }); }
  catch { throw new Transient('upload'); }
  // A retry after a successful upload finds the media name already taken.
  const alreadyUploaded = !!existing && [409, 422].includes(response.status);
  if (!response.ok && !alreadyUploaded) {
    if (transientStatus(response.status)) throw new Transient('upload');
    throw new Permanent('Telnyx did not accept the document; no fax was sent');
  }
  const result = await sendPreparedFax(env.DB, { id: row.id, actor: row.actor_id, config, confirmed: true }, input => submitFax(input, fetcher));
  if (result.outcome === 'unavailable') throw new Permanent('Fax sending is not configured');
  if (result.outcome === 'not_claimed') throw new Waiting('Waiting for the previous fax to finish');
  await reflectFax(env.DB, row, await env.DB.prepare('SELECT status, provider_id FROM fax_intents WHERE id = ?').bind(row.id).first());
}

function letterForm(options, pdf, row) {
  const form = new FormData();
  for (const side of ['to', 'from']) for (const [key, value] of Object.entries(options[side])) form.set(`${side}[${key}]`, value);
  form.set('pdf', new Blob([pdf], { type: 'application/pdf' }), 'document.pdf');
  form.set('color', String(options.color === true));
  form.set('doubleSided', String(options.doubleSided === true));
  form.set('mailingClass', options.mailingClass);
  form.set('size', 'us_letter');
  form.set('addressPlacement', 'insert_blank_page');
  form.set('metadata[simpledocsDraftId]', row.id);
  form.set('metadata[simpledocsTransmissionId]', row.transmission_id);
  return form;
}

async function sendMail(env, row, fetcher) {
  const intent = await env.DB.prepare('SELECT status, provider_id, provider_mode FROM mail_intents WHERE draft_id = ?').bind(row.id).first();
  // The claim was already consumed. Redelivery only reflects it, never resubmits.
  if (intent) { await refreshDelivery(env, row, fetcher); return; }
  const options = JSON.parse(row.options_json);
  const approval = options.approval;
  // Defense in depth: only an approved row is ever on the queue.
  if (!approval || !['test', 'live'].includes(approval.mode) || !/^[a-f0-9]{64}$/.test(approval.reviewHash ?? '')) throw new Permanent('This letter was not approved');
  const apiKey = mailApiKey(env, approval.mode);
  if (env.MAIL_ENABLED !== 'true' || !apiKey) throw new Permanent('The selected mail mode is unavailable');
  const pdf = await readObject(env, row.source_key);
  const summary = { to: options.to, from: options.from, color: options.color, doubleSided: options.doubleSided, mailingClass: options.mailingClass };
  const expected = await mailReviewHash({ id: row.id, revision: 1, mode: approval.mode, summary, pdfSha256: await sha256Hex(pdf) });
  if (expected !== approval.reviewHash) throw new Permanent('The letter changed after it was approved');
  const draft = await env.DB.prepare('SELECT revision, content_json FROM mail_drafts WHERE id = ? AND actor_id = ?').bind(row.id, row.actor_id).first();
  if (!draft) throw new Permanent('The letter draft is missing');
  const now = new Date().toISOString();
  const claim = await env.DB.prepare("INSERT INTO mail_intents (draft_id, actor_id, revision, review_hash, payload_json, status, confirmed_at, updated_at, provider_mode) SELECT id, actor_id, revision, ?, ?, 'submitting', ?, ?, ? FROM mail_drafts WHERE id = ? AND actor_id = ? AND revision = ? ON CONFLICT DO NOTHING")
    .bind(approval.reviewHash, JSON.stringify(summary), now, now, approval.mode, row.id, row.actor_id, draft.revision).run();
  if (claim.meta.changes !== 1) throw new Waiting('Waiting for another letter order to be acknowledged');
  await mark(env.DB, row.id, 'submitting');
  let status = 'unknown'; let providerId = null; let rejected = false;
  try {
    const response = await fetcher('https://api.postgrid.com/print-mail/v1/letters', { method: 'POST', headers: { 'X-API-Key': apiKey }, body: letterForm(options, pdf, row), redirect: 'manual' });
    if (response.status === 201) {
      const result = await response.json();
      if (result?.object === 'letter' && typeof result.id === 'string' && /^letter_[a-zA-Z0-9]+$/.test(result.id)) { status = 'accepted'; providerId = result.id; }
    } else if (response.status >= 400 && response.status < 500 && !transientStatus(response.status)) rejected = true;
  } catch { /* Any failure after the claim may have created an order. */ }
  if (rejected) {
    // A definitive client error means no order exists, so the claim is released.
    await env.DB.prepare("DELETE FROM mail_intents WHERE draft_id = ? AND status = 'submitting'").bind(row.id).run();
    await mark(env.DB, row.id, 'failed', { error: 'PostGrid rejected the letter; nothing was mailed' });
    return;
  }
  await env.DB.prepare("UPDATE mail_intents SET status = ?, provider_id = ?, updated_at = ? WHERE draft_id = ? AND status = 'submitting'").bind(status, providerId, new Date().toISOString(), row.id).run();
  if (status === 'accepted') await mark(env.DB, row.id, 'accepted', { providerId, providerStatus: 'accepted' });
  else await mark(env.DB, row.id, 'unknown', { error: 'PostGrid did not confirm this letter. Check PostGrid before sending again.' });
}

// Returns what the queue should do with the message: 'ack' or { retry: seconds }.
export async function processDelivery(env, body, attempts = 1, fetcher = fetch) {
  const row = await loadRow(env, body);
  if (!row) return 'ack';
  // At-least-once delivery: only a queued row is ever worked on.
  if (row.status !== 'queued' || isTerminal(row.status)) return 'ack';
  try {
    if (row.channel === 'fax') await sendFax(env, row, fetcher);
    else await sendMail(env, row, fetcher);
    return 'ack';
  } catch (error) {
    if (error instanceof Permanent) { await mark(env.DB, row.id, 'failed', { error: error.message }); return 'ack'; }
    if (error instanceof Waiting) return attempts <= MAX_RETRIES ? { retry: 60 } : 'ack';
    if (attempts > MAX_RETRIES) { await mark(env.DB, row.id, 'failed', { error: 'Could not reach the provider after several tries; nothing was sent' }); return 'ack'; }
    return { retry: RETRY_SECONDS * attempts };
  }
}

export async function handleQueue(batch, env, fetcher = fetch) {
  for (const message of batch.messages) {
    let result = { retry: RETRY_SECONDS };
    try { result = await processDelivery(env, message.body, message.attempts ?? 1, fetcher); } catch { /* Unexpected: retry. */ }
    if (result === 'ack') message.ack(); else message.retry({ delaySeconds: result.retry });
  }
}

// Cron backstop: re-poll open deliveries and re-enqueue rows never submitted.
export async function reconcileDeliveries(env, fetcher = fetch, now = Date.now()) {
  if (!env.DB) return;
  const cutoff = new Date(now - STALE_QUEUED_MS).toISOString();
  const open = await env.DB.prepare("SELECT * FROM dispatches WHERE status IN ('submitting', 'accepted') AND updated_at < ? ORDER BY updated_at LIMIT 25").bind(cutoff).all();
  for (const row of open.results ?? []) await refreshDelivery(env, row, fetcher);
  if (!env.DELIVERIES) return;
  const queued = await env.DB.prepare("SELECT id, transmission_id, channel, created_at FROM dispatches WHERE status = 'queued' AND updated_at < ? ORDER BY updated_at LIMIT 25").bind(cutoff).all();
  for (const row of queued.results ?? []) {
    if (now - Date.parse(row.created_at) > GIVE_UP_MS) { await mark(env.DB, row.id, 'failed', { error: 'Could not be submitted within a day; nothing was sent' }); continue; }
    await enqueue(env, row.transmission_id, row.channel, row.id);
  }
}
