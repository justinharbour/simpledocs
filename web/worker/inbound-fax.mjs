// The public route is independent of Access, and must fail closed before any
// storage or network operation. Never log payloads, URLs or provider errors.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TYPES = new Set(['fax.receiving.started', 'fax.media.processing.started', 'fax.received', 'fax.failed']);
const MAX_EVENT = 64 * 1024;
const MAX_PDF = 20 * 1024 * 1024;

function response(status) {
  return new Response(status === 200 ? 'OK' : 'Unavailable', { status, headers: { 'Cache-Control': 'no-store' } });
}
function base64(value, size) {
  if (typeof value !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw new Error();
  const bytes = Uint8Array.from(atob(value), c => c.charCodeAt(0));
  if (bytes.length !== size) throw new Error();
  return bytes;
}
async function bounded(stream, max) {
  if (!stream) throw new Error();
  const reader = stream.getReader();
  const chunks = []; let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > max) { await reader.cancel(); throw new Error(); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const result = new Uint8Array(length); let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
  return result;
}
async function verified(bytes, headers, publicKey, now) {
  try {
    const timestamp = headers.get('telnyx-timestamp');
    if (!timestamp || !/^\d{1,12}$/.test(timestamp) || Math.abs(Math.floor(now / 1000) - Number(timestamp)) > 300) return false;
    const key = await crypto.subtle.importKey('raw', base64(publicKey, 32), 'Ed25519', false, ['verify']);
    const prefix = new TextEncoder().encode(`${timestamp}|`);
    const message = new Uint8Array(prefix.length + bytes.length);
    message.set(prefix); message.set(bytes, prefix.length);
    return await crypto.subtle.verify('Ed25519', key, base64(headers.get('telnyx-signature-ed25519'), 64), message);
  } catch { return false; }
}

// Only the precise AWS S3 origin documented in Telnyx's inbound fax example is
// accepted. No redirects, credentials, custom ports, or generic host suffixes.
function mediaURL(value) {
  if (typeof value !== 'string' || value.length > 8192) throw new Error();
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.hostname !== 's3.amazonaws.com' || url.port || url.username || url.password || url.hash || !/^\/faxes-prod\/[A-Za-z0-9_/-]+\.pdf$/.test(url.pathname) || !url.search) throw new Error();
  return url.toString();
}

async function archiveMedia(env, eventId, faxId, value, fetcher) {
  const media = await fetcher(mediaURL(value), { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(15000) });
  if (!media.ok || !/^application\/pdf(?:\s*;|\s*$)/i.test(media.headers.get('content-type') ?? '')) throw new Error();
  const pdf = await bounded(media.body, MAX_PDF);
  if (pdf.length < 5 || new TextDecoder().decode(pdf.subarray(0, 5)) !== '%PDF-') throw new Error();
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', pdf)), byte => byte.toString(16).padStart(2, '0')).join('');
  const key = `inbound-fax/${faxId.toLowerCase()}/${eventId.toLowerCase()}/${hash}.pdf`;
  await env.FAX_MEDIA.put(key, pdf, { httpMetadata: { contentType: 'application/pdf' } });
  return key;
}

// Internal only: no route or scheduler invokes this until deployment and
// account-specific refresh behavior have been reviewed and verified.
export async function recoverInboundFax(env, eventId, { fetcher = fetch, now = Date.now() } = {}) {
  if (env.TELNYX_FAX_RECOVERY_ENABLED !== 'true' || env.TELNYX_INBOUND_FAX_ENABLED !== 'true' || !env.TELNYX_API_TOKEN || !env.TELNYX_FAX_CONNECTION_ID || !env.TELNYX_FAX_NUMBER || !env.DB || !env.FAX_MEDIA || typeof eventId !== 'string' || !UUID.test(eventId)) return false;
  try {
    const receipt = await env.DB.prepare('SELECT event_id, fax_id, occurred_at FROM inbound_fax_unarchived WHERE event_id = ?').bind(eventId).first();
    if (!receipt || receipt.event_id !== eventId || typeof receipt.fax_id !== 'string' || !UUID.test(receipt.fax_id)) return false;
    const endpoint = `https://api.telnyx.com/v2/faxes/${receipt.fax_id}`;
    const options = { headers: { Authorization: `Bearer ${env.TELNYX_API_TOKEN}`, Accept: 'application/json' }, redirect: 'manual', signal: AbortSignal.timeout(15000) };
    const refresh = await fetcher(`${endpoint}/actions/refresh`, { ...options, method: 'POST' });
    if (!refresh.ok) return false;
    const refreshBody = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await bounded(refresh.body, MAX_EVENT)));
    if (refreshBody?.data?.result !== 'ok') return false;
    const result = await fetcher(endpoint, { ...options, method: 'GET', signal: AbortSignal.timeout(15000) });
    if (!result.ok) return false;
    const fax = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await bounded(result.body, MAX_EVENT)))?.data;
    if (fax?.record_type !== 'fax' || fax.id !== receipt.fax_id || fax.direction !== 'inbound' || fax.connection_id !== env.TELNYX_FAX_CONNECTION_ID || fax.to !== env.TELNYX_FAX_NUMBER || fax.status !== 'received') return false;
    const objectKey = await archiveMedia(env, eventId, receipt.fax_id, fax.media_url, fetcher);
    const saved = await env.DB.prepare("INSERT INTO inbound_fax_events (event_id, fax_id, event_type, occurred_at, received_at, object_key) VALUES (?, ?, 'fax.received', ?, ?, ?) ON CONFLICT(event_id) DO NOTHING")
      .bind(eventId, receipt.fax_id, receipt.occurred_at, new Date(now).toISOString(), objectKey).run();
    if (!saved.success) return false;
    const archived = await env.DB.prepare("SELECT event_id FROM inbound_fax_events WHERE event_id = ? AND fax_id = ? AND event_type = 'fax.received' AND object_key IS NOT NULL").bind(eventId, receipt.fax_id).first();
    return !!archived;
  } catch { return false; }
}

export async function handleInboundFax(request, env, { fetcher = fetch, now = Date.now() } = {}) {
  if (request.method !== 'POST') return response(405);
  if (env.TELNYX_INBOUND_FAX_ENABLED !== 'true' || !env.TELNYX_PUBLIC_KEY || !env.TELNYX_FAX_CONNECTION_ID || !env.TELNYX_FAX_NUMBER || !env.DB || !env.FAX_MEDIA) return response(503);
  let bytes;
  try { bytes = await bounded(request.body, MAX_EVENT); } catch { return response(413); }
  if (!await verified(bytes, request.headers, env.TELNYX_PUBLIC_KEY, now)) return response(401);
  let data, payload;
  try {
    data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)).data;
    payload = data.payload;
    if (!UUID.test(data.id) || !UUID.test(payload.fax_id) || !TYPES.has(data.event_type) || payload.direction !== 'inbound' || payload.connection_id !== env.TELNYX_FAX_CONNECTION_ID || payload.to !== env.TELNYX_FAX_NUMBER || typeof data.occurred_at !== 'string' || data.occurred_at.length > 64 || !Number.isFinite(Date.parse(data.occurred_at))) throw new Error();
  } catch { return response(400); }
  try {
    const existing = await env.DB.prepare('SELECT event_id FROM inbound_fax_events WHERE event_id = ?').bind(data.id).first();
    if (existing) return response(200);
    let objectKey = null;
    if (data.event_type === 'fax.received') {
      // Persist only verified identifiers before attempting the expiring URL.
      // An archived event resolves this receipt; it must never itself suppress a retry.
      const pending = await env.DB.prepare('INSERT INTO inbound_fax_pending (event_id, fax_id, occurred_at, received_at) VALUES (?, ?, ?, ?) ON CONFLICT(event_id) DO NOTHING')
        .bind(data.id, payload.fax_id, data.occurred_at, new Date(now).toISOString()).run();
      if (!pending.success) throw new Error();
      const receipt = await env.DB.prepare('SELECT fax_id, occurred_at FROM inbound_fax_pending WHERE event_id = ?').bind(data.id).first();
      if (!receipt || receipt.fax_id !== payload.fax_id || receipt.occurred_at !== data.occurred_at) throw new Error();
      objectKey = await archiveMedia(env, data.id, payload.fax_id, payload.media_url, fetcher);
    }
    const result = await env.DB.prepare('INSERT INTO inbound_fax_events (event_id, fax_id, event_type, occurred_at, received_at, object_key) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(event_id) DO NOTHING')
      .bind(data.id, payload.fax_id, data.event_type, data.occurred_at, new Date(now).toISOString(), objectKey).run();
    if (!result.success) throw new Error();
    return response(200);
  } catch { return response(503); }
}
