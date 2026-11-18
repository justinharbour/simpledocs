import { bounded, verify } from './voice-webhook.mjs';
import { normalizePhone } from './phone.mjs';

const MAX_BODY = 64 * 1024;
const MAX_TEXT = 1600;
const E164 = /^\+[1-9]\d{1,14}$/;
const headers = { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' };
const json = (value, status = 200) => Response.json(value, { status, headers });
const reply = (status, message) => new Response(message, { status, headers });

// Telnyx reports sending_failed and delivery_failed separately; both are "failed" here with the carrier error kept.
// Delivered and failed are final. Telnyx may reorder events, so a status only ever moves forward.
const STATUS = { queued: 'queued', sending: 'sending', sent: 'sent', delivered: 'delivered', delivery_unconfirmed: 'unconfirmed', sending_failed: 'failed', delivery_failed: 'failed' };
const RANK = { queued: 0, sending: 1, sent: 2, unconfirmed: 3, delivered: 4, failed: 4 };

const iso = value => { const t = Date.parse(value); return Number.isFinite(t) ? new Date(t).toISOString() : new Date().toISOString(); };
const view = r => ({ id: r.id, direction: r.direction, peer: r.peer, body: r.body, status: r.status, errorCode: r.error_code, errorText: r.error_text, createdAt: r.created_at, statusAt: r.status_at, readAt: r.read_at });
const COLUMNS = 'id, direction, peer, body, status, error_code, error_text, created_at, status_at, read_at';
const firstError = errors => {
  const e = Array.isArray(errors) ? errors[0] : null;
  if (!e) return { code: null, text: null };
  const text = [e.title, e.detail].filter(s => typeof s === 'string' && s).join(': ').slice(0, 300);
  return { code: e.code === undefined ? null : String(e.code).slice(0, 20), text: text || null };
};

async function advance(db, providerId, status, errors, at) {
  const row = await db.prepare('SELECT status FROM sms_messages WHERE provider_id = ? AND direction = ?').bind(providerId, 'outbound').first();
  if (!row || row.status === 'delivered' || row.status === 'failed' || RANK[status] <= RANK[row.status]) return;
  const err = status === 'failed' ? firstError(errors) : { code: null, text: null };
  await db.prepare('UPDATE sms_messages SET status = ?, error_code = ?, error_text = ?, status_at = ? WHERE provider_id = ? AND status = ?')
    .bind(status, err.code, err.text, at, providerId, row.status).run();
}

export async function handleSmsWebhook(request, env, now = Date.now()) {
  if (request.method !== 'POST') return reply(405, 'Method not allowed');
  if (!env.DB || !env.TELNYX_PUBLIC_KEY || !E164.test(env.SMS_NUMBER ?? '')) return reply(503, 'Unavailable');
  let bytes;
  try { bytes = await bounded(request.body, MAX_BODY); } catch { return reply(413, 'Invalid body'); }
  if (!await verify(bytes, request, env.TELNYX_PUBLIC_KEY, now)) return reply(401, 'Unauthorized');
  let data, payload;
  try { data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)).data; payload = data.payload; } catch { return reply(400, 'Invalid event'); }
  if (!data || !payload || typeof payload.id !== 'string' || !payload.id || payload.id.length > 128) return reply(400, 'Invalid event');
  if (!['message.received', 'message.sent', 'message.finalized'].includes(data.event_type)) return reply(200, 'Ignored');
  const at = iso(data.occurred_at ?? payload.received_at);
  const text = typeof payload.text === 'string' && payload.text ? payload.text.slice(0, 4000) : '(media message not shown)';
  try {
    if (data.event_type === 'message.received') {
      const from = payload.from?.phone_number;
      const toUs = Array.isArray(payload.to) && payload.to.some(t => t?.phone_number === env.SMS_NUMBER);
      if (!toUs || !E164.test(from ?? '') || from === env.SMS_NUMBER) return reply(200, 'Ignored');
      // A STOP is monotonic locally: an out-of-order START or replay must not
      // silently restore permission. Provider-side re-subscription alone is not
      // evidence of consent to a particular conversation.
      const keyword = typeof payload.text === 'string' ? payload.text.trim().toUpperCase().replace(/\s+/g, ' ') : '';
      if (payload.autoresponse_type === 'STOP' || ['STOP', 'STOPALL', 'STOP ALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT'].includes(keyword)) {
        await env.DB.prepare('INSERT INTO sms_opt_outs (peer, opted_out_at) VALUES (?, ?) ON CONFLICT(peer) DO UPDATE SET opted_out_at = MAX(opted_out_at, excluded.opted_out_at)').bind(from, at).run();
      }
      await env.DB.prepare("INSERT OR IGNORE INTO sms_messages (id, provider_id, direction, peer, body, status, created_at, status_at) VALUES (?, ?, 'inbound', ?, ?, 'received', ?, ?)")
        .bind(crypto.randomUUID(), payload.id, from, text, at, at).run();
      return reply(200, 'Accepted');
    }
    if (payload.from?.phone_number !== env.SMS_NUMBER) return reply(200, 'Ignored');
    const to = Array.isArray(payload.to) ? payload.to[0] : null;
    const status = STATUS[to?.status];
    if (!status || !E164.test(to?.phone_number ?? '')) return reply(200, 'Ignored');
    // A status can arrive before the send request stores its provider id, or for a message sent elsewhere.
    await env.DB.prepare("INSERT OR IGNORE INTO sms_messages (id, provider_id, direction, peer, body, status, created_at, status_at) VALUES (?, ?, 'outbound', ?, ?, 'queued', ?, ?)")
      .bind(crypto.randomUUID(), payload.id, to.phone_number, text, at, at).run();
    await advance(env.DB, payload.id, status, payload.errors, at);
    return reply(200, 'Accepted');
  } catch { return reply(503, 'Temporarily unavailable'); }
}

export async function markThreadRead(db, peer, read = true) {
  if (read) await db.prepare("UPDATE sms_messages SET read_at = ? WHERE peer = ? AND direction = 'inbound' AND read_at IS NULL").bind(new Date().toISOString(), peer).run();
  // Unread is set on the latest inbound message only, so the thread counts as one unread item.
  else await db.prepare("UPDATE sms_messages SET read_at = NULL WHERE id = (SELECT id FROM sms_messages WHERE peer = ? AND direction = 'inbound' ORDER BY created_at DESC, id DESC LIMIT 1)").bind(peer).run();
}

async function send(request, env, fetcher) {
  if (request.headers.get('origin') !== new URL(request.url).origin) return json({ error: 'Invalid origin' }, 403);
  let input;
  try { input = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await bounded(request.body, MAX_BODY))); } catch { return json({ error: 'Invalid request' }, 400); }
  const to = normalizePhone(input?.to), text = input?.text;
  if (!to) return json({ error: 'Enter a valid phone number.' }, 400);
  if (typeof text !== 'string' || !text.trim() || text.length > MAX_TEXT) return json({ error: `Message must be 1 to ${MAX_TEXT} characters.` }, 400);
  if (!env.DB || !E164.test(env.SMS_NUMBER ?? '') || typeof env.TELNYX_API_TOKEN !== 'string' || !env.TELNYX_API_TOKEN.trim()) return json({ error: 'Messaging unavailable' }, 503);
  if (to === env.SMS_NUMBER) return json({ error: 'You cannot text your own number.' }, 400);
  const id = crypto.randomUUID(), now = new Date().toISOString();
  try {
    const result = await env.DB.prepare("INSERT INTO sms_messages (id, direction, peer, body, status, created_at, status_at) SELECT ?, 'outbound', ?, ?, 'queued', ?, ? WHERE NOT EXISTS (SELECT 1 FROM sms_opt_outs WHERE peer = ?)").bind(id, to, text, now, now, to).run();
    if ((result.meta?.changes ?? result.changes) !== 1) return json({ error: 'This recipient has opted out of SMS.' }, 403);
  } catch { return json({ error: 'Messaging unavailable' }, 503); }
  const fail = async (code, reason) => {
    await env.DB.prepare("UPDATE sms_messages SET status = 'failed', error_code = ?, error_text = ?, status_at = ? WHERE id = ?").bind(code, reason, new Date().toISOString(), id).run();
    return json({ message: view(await env.DB.prepare(`SELECT ${COLUMNS} FROM sms_messages WHERE id = ?`).bind(id).first()), error: reason }, 502);
  };
  try {
    const response = await fetcher('https://api.telnyx.com/v2/messages', {
      method: 'POST', redirect: 'manual',
      headers: { Authorization: `Bearer ${env.TELNYX_API_TOKEN}`, 'Content-Type': 'application/json', 'Idempotency-Key': id },
      body: JSON.stringify({ from: env.SMS_NUMBER, to, text }),
    });
    let body = null;
    try { body = await response.json(); } catch { /* not JSON */ }
    if (!response.ok) {
      const err = firstError(body?.errors);
      return await fail(err.code, err.text ?? 'The provider rejected the message.');
    }
    const providerId = body?.data?.id;
    if (typeof providerId !== 'string' || !providerId) return await fail(null, 'The provider gave an unexpected reply.');
    try {
      // 'sending' means accepted for sending, never delivered. A webhook may already have moved it on.
      await env.DB.prepare("UPDATE sms_messages SET provider_id = ?, status = 'sending', status_at = ? WHERE id = ? AND status = 'queued'").bind(providerId, new Date().toISOString(), id).run();
    } catch {
      // The status webhook beat us and created the row for this provider id; keep that one.
      await env.DB.prepare('DELETE FROM sms_messages WHERE id = ?').bind(id).run();
      const existing = await env.DB.prepare(`SELECT ${COLUMNS} FROM sms_messages WHERE provider_id = ?`).bind(providerId).first();
      return json({ message: view(existing) });
    }
    return json({ message: view(await env.DB.prepare(`SELECT ${COLUMNS} FROM sms_messages WHERE id = ?`).bind(id).first()) });
  } catch {
    // The request may or may not have reached the provider. Say so; never claim it was sent.
    return await fail(null, 'Could not reach the provider. The message may not have been sent.');
  }
}

export async function handleSms(request, env, fetcher = fetch) {
  if (!env.DB) return json({ error: 'Storage unavailable' }, 503);
  const url = new URL(request.url);
  const path = url.pathname;
  try {
    if (path === '/api/sms/threads') {
      if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405);
      const rows = await env.DB.prepare(`SELECT m.peer, m.body, m.direction, m.status, m.created_at,
        (SELECT COUNT(*) FROM sms_messages u WHERE u.peer = m.peer AND u.direction = 'inbound' AND u.read_at IS NULL) AS unread
        FROM sms_messages m WHERE m.id = (SELECT x.id FROM sms_messages x WHERE x.peer = m.peer ORDER BY x.created_at DESC, x.id DESC LIMIT 1)
        ORDER BY m.created_at DESC LIMIT 100`).all();
      return json({ threads: (rows.results ?? []).map(r => ({ peer: r.peer, body: r.body, direction: r.direction, status: r.status, at: r.created_at, unread: r.unread })) });
    }
    if (path === '/api/sms/messages') {
      if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
      return await send(request, env, fetcher);
    }
    const match = /^\/api\/sms\/threads\/([^/]+)(\/read)?$/.exec(path);
    if (!match) return json({ error: 'Not found' }, 404);
    let peer;
    try { peer = decodeURIComponent(match[1]); } catch { return json({ error: 'Not found' }, 404); }
    if (!E164.test(peer)) return json({ error: 'Not found' }, 404);
    if (match[2]) {
      if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
      if (request.headers.get('origin') !== url.origin) return json({ error: 'Invalid origin' }, 403);
      await markThreadRead(env.DB, peer, true);
      return json({ peer, read: true });
    }
    if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405);
    const rows = await env.DB.prepare(`SELECT ${COLUMNS} FROM (SELECT ${COLUMNS} FROM sms_messages WHERE peer = ? ORDER BY created_at DESC, id DESC LIMIT 200) ORDER BY created_at ASC, id ASC`).bind(peer).all();
    return json({ peer, messages: (rows.results ?? []).map(view) });
  } catch { return json({ error: 'Messaging unavailable' }, 503); }
}
