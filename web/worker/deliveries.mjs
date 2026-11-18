import { applyFaxDeliveryEvent } from './fax-intents.mjs';
import { mailApiKey } from './mail-send.mjs';
import { pushLater } from './push.mjs';

// 'completed' is PostGrid's own estimate for mail. It is never shown as delivered.
export const TERMINAL = ['delivered', 'completed', 'failed'];
export const isTerminal = status => TERMINAL.includes(status);
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function sha256Hex(input) {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input;
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2, '0')).join('');
}

// What the owner approves: the exact recipient, return address, print options,
// document digest and the test/live mode. Any change invalidates the approval.
export const mailReviewHash = ({ id, revision, mode, summary, pdfSha256 }) => sha256Hex(JSON.stringify({ id, revision, mode, summary, pdfSha256 }));

// One message per channel. A failed send is not fatal: the cron re-enqueues
// rows that stay 'queued'.
export async function enqueue(env, transmissionId, channel, deliveryId) {
  try { await env.DELIVERIES.send({ transmissionId, channel, deliveryId }); return true; } catch { return false; }
}

const safe = value => (typeof value === 'string' && /^[A-Za-z0-9_. :-]{1,80}$/.test(value) ? value : null);

// Single place that changes a delivery. Terminal rows never change again, and
// every real change appends to the per-channel timeline.
export async function mark(env, id, status, { providerId = null, providerStatus = null, error = null } = {}) {
  const db = env.DB;
  const row = await db.prepare('SELECT status, provider_status, provider_id, error, transmission_id, channel FROM dispatches WHERE id = ?').bind(id).first();
  if (!row || isTerminal(row.status)) return false;
  const nextProvider = providerStatus ?? row.provider_status;
  if (row.status === status && nextProvider === row.provider_status && (!providerId || providerId === row.provider_id) && (!error || error === row.error)) return false;
  const now = new Date().toISOString();
  const finished = isTerminal(status) ? now : null;
  const changed = await db.prepare("UPDATE dispatches SET status = ?, provider_id = COALESCE(?, provider_id), provider_status = COALESCE(?, provider_status), error = COALESCE(?, error), updated_at = ?, submitted_at = CASE WHEN submitted_at IS NULL AND ? IN ('accepted', 'unknown', 'delivered', 'completed') THEN ? ELSE submitted_at END, finished_at = COALESCE(?, finished_at) WHERE id = ? AND status NOT IN ('delivered', 'completed', 'failed')")
    .bind(status, providerId, providerStatus, error, now, status, now, finished, id).run();
  if (changed.meta.changes !== 1) return false;
  await db.prepare('UPDATE transmissions SET updated_at = ? WHERE id = ?').bind(now, row.transmission_id).run();
  await db.prepare('INSERT INTO timeline (delivery_id, at, status, detail) VALUES (?, ?, ?, ?)').bind(id, now, status, error ?? providerStatus ?? null).run();
  if (status === 'failed') pushLater(env, { kind: row.channel === 'mail' ? 'mail-failed' : 'fax-failed', id });
  return true;
}

export async function reflectFax(env, row, intent) {
  switch (intent?.status) {
    case undefined: case 'prepared': if (row.status === 'submitting') await mark(env, row.id, 'queued'); return;
    case 'submitting': await mark(env, row.id, 'submitting'); return;
    case 'accepted': await mark(env, row.id, 'accepted', { providerId: intent.provider_id }); return;
    case 'rejected': await mark(env, row.id, 'failed', { error: 'Telnyx rejected the fax' }); return;
    case 'unknown': await mark(env, row.id, 'unknown', { error: 'Telnyx did not confirm this fax. Check Telnyx before sending again.' }); return;
    case 'delivered': await mark(env, row.id, 'delivered', { providerStatus: 'delivered' }); return;
    case 'failed': await mark(env, row.id, 'failed', { error: 'The fax failed' }); return;
  }
}

async function reflectMail(env, row, intent, fetcher) {
  if (!intent) { if (row.status === 'submitting') await mark(env, row.id, 'queued'); return; }
  if (intent.status === 'submitting') { await mark(env, row.id, 'submitting'); return; }
  if (intent.status === 'unknown') { await mark(env, row.id, 'unknown', { error: 'PostGrid did not confirm this letter. Check PostGrid before sending again.' }); return; }
  await mark(env, row.id, 'accepted', { providerId: intent.provider_id });
  const apiKey = mailApiKey(env, intent.provider_mode);
  if (!apiKey || !/^letter_[a-zA-Z0-9]+$/.test(intent.provider_id ?? '')) return;
  try {
    const response = await fetcher(`https://api.postgrid.com/print-mail/v1/letters/${intent.provider_id}`, { headers: { 'X-API-Key': apiKey }, redirect: 'manual' });
    if (!response.ok) return;
    const letter = await response.json();
    const status = safe(letter?.status);
    if (letter?.id !== intent.provider_id || !status) return;
    if (status === 'completed') await mark(env, row.id, 'completed', { providerStatus: status });
    else if (status === 'cancelled') await mark(env, row.id, 'failed', { providerStatus: status, error: 'The letter was cancelled at PostGrid' });
    else await mark(env, row.id, 'accepted', { providerStatus: status });
  } catch { /* Keep the last known status; the next poll reconciles it. */ }
}

// Pull the Simpledocs row up to date from the intent tables and, for accepted
// jobs, from the provider's own API. Failed lookups never change a status.
export async function refreshDelivery(env, row, fetcher = fetch) {
  const db = env.DB;
  if (isTerminal(row.status) || row.status === 'awaiting_approval') return;
  if (row.channel === 'fax') {
    let intent = await db.prepare('SELECT status, provider_id FROM fax_intents WHERE id = ?').bind(row.id).first();
    if (intent?.status === 'accepted' && intent.provider_id && env.TELNYX_API_TOKEN) {
      try {
        const response = await fetcher(`https://api.telnyx.com/v2/faxes/${encodeURIComponent(intent.provider_id)}`, { headers: { Authorization: `Bearer ${env.TELNYX_API_TOKEN}`, Accept: 'application/json' }, redirect: 'manual' });
        const data = response.ok ? (await response.json())?.data : null;
        if (data?.id === intent.provider_id) {
          if (['delivered', 'failed'].includes(data.status)) await applyFaxDeliveryEvent(db, { providerId: intent.provider_id, status: data.status });
          else if (safe(data.status)) await mark(env, row.id, 'accepted', { providerStatus: data.status });
          intent = await db.prepare('SELECT status, provider_id FROM fax_intents WHERE id = ?').bind(row.id).first();
          if (intent.status === 'failed' && safe(data.failure_reason)) await mark(env, row.id, 'failed', { providerStatus: 'failed', error: `The fax failed: ${data.failure_reason}` });
        }
      } catch { /* Keep the last known status. */ }
    }
    await reflectFax(env, row, intent);
    return;
  }
  const intent = await db.prepare('SELECT status, provider_id, provider_mode FROM mail_intents WHERE draft_id = ?').bind(row.id).first();
  await reflectMail(env, row, intent, fetcher);
}

// Outbound Telnyx fax webhook, already signature-verified by the caller.
export async function applyOutboundFaxEvent(env, eventType, faxId) {
  const db = env.DB;
  const status = { 'fax.delivered': 'delivered', 'fax.failed': 'failed' }[eventType];
  if (status) await applyFaxDeliveryEvent(db, { providerId: faxId, status });
  const row = await db.prepare("SELECT d.id, d.status, d.channel FROM dispatches d JOIN fax_intents f ON f.id = d.id WHERE f.provider_id = ?").bind(faxId).first();
  if (!row) return;
  const intent = await db.prepare('SELECT status, provider_id FROM fax_intents WHERE id = ?').bind(row.id).first();
  if (!status) {
    const provider = eventType.replace(/^fax\./, '');
    if (safe(provider)) await mark(env, row.id, 'accepted', { providerStatus: provider });
    return;
  }
  await reflectFax(env, row, intent);
}
