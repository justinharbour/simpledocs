import { sha256Hex, UUID } from './deliveries.mjs';

// Apple TV pairing. Only hashes are stored. A device code is redeemed once by an
// atomic status change, so a racing second poll cannot mint a second token.
const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
const reply = (body, status = 200) => Response.json(body, { status, headers });
const TTL_MS = 10 * 60 * 1000;
const INTERVAL_MS = 5000;
const USER_ALPHABET = 'BCDFGHJKLMNPQRSTVWXZ23456789';
const DEVICE_CODE = /^[A-Za-z0-9_-]{43}$/;
const BEARER = /^Bearer ([A-Za-z0-9_-]{43})$/;
const hex = bytes => Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('');
const randomToken = () => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const sameOrigin = request => request.headers.get('origin') === new URL(request.url).origin;

// Rejection sampling keeps the 8-character code uniform over the 28-symbol alphabet.
function userCode() {
  let out = '';
  while (out.length < 8) {
    for (const b of crypto.getRandomValues(new Uint8Array(16))) if (b < 252 && out.length < 8) out += USER_ALPHABET[b % 28];
  }
  return out;
}
const normalizeCode = value => String(value ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');

// Per-IP counter in the existing hourly portal_limits table, keyed by an HMAC so raw IPs are not stored.
// Returns true when the caller is over the limit or the counter is unavailable (fail closed).
async function limited(env, category, request, maximum) {
  const ip = request.headers.get('cf-connecting-ip') ?? 'unknown';
  if (!env.PORTAL_KEY) return true;
  try {
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.PORTAL_KEY), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const bucket = hex(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`simpledocs:tv-limit:v1:${category}:${ip}`)));
    const row = await env.DB.prepare('INSERT INTO portal_limits (bucket, period, count) VALUES (?, ?, 1) ON CONFLICT(bucket, period) DO UPDATE SET count = count + 1 WHERE count < ? RETURNING count').bind(bucket, Math.floor(Date.now() / 3600000), maximum).first();
    return !row;
  } catch { return true; }
}

async function jsonBody(request) {
  try { return await request.json(); } catch { return null; }
}

export async function tvPairStart(request, env) {
  if (request.method !== 'POST') return reply({ error: 'Method not allowed' }, 405);
  if (!env.DB) return reply({ error: 'Storage unavailable' }, 503);
  if (await limited(env, 'start', request, 10)) return reply({ error: 'Too many attempts. Try again later.' }, 429);
  const body = await jsonBody(request);
  const deviceName = typeof body?.deviceName === 'string' && body.deviceName.trim() ? body.deviceName.trim().slice(0, 60) : 'Apple TV';
  const now = Date.now();
  const deviceCode = randomToken(), code = userCode();
  await env.DB.prepare("DELETE FROM tv_pairings WHERE status = 'pending' AND expires_at < ?").bind(now).run();
  await env.DB.prepare("INSERT INTO tv_pairings (id, device_code_hash, user_code_hash, device_name, status, expires_at, created_at) VALUES (?, ?, ?, ?, 'pending', ?, ?)")
    .bind(crypto.randomUUID(), await sha256Hex(deviceCode), await sha256Hex(code), deviceName, now + TTL_MS, new Date(now).toISOString()).run();
  return reply({ deviceCode, userCode: `${code.slice(0, 4)}-${code.slice(4)}`, verificationUri: `${new URL(request.url).origin}/settings`, expiresIn: TTL_MS / 1000, interval: INTERVAL_MS / 1000 });
}

// Owner preview: shows the device name before approval.
export async function tvPreview(request, env, actor) {
  if (request.method !== 'GET') return reply({ error: 'Method not allowed' }, 405);
  if (!env.DB) return reply({ error: 'Storage unavailable' }, 503);
  const code = normalizeCode(new URL(request.url).searchParams.get('code'));
  if (!/^[BCDFGHJKLMNPQRSTVWXZ23456789]{8}$/.test(code)) return reply({ error: 'Enter the 8-character code' }, 400);
  const row = await env.DB.prepare("SELECT device_name FROM tv_pairings WHERE user_code_hash = ? AND status = 'pending' AND expires_at > ?").bind(await sha256Hex(code), Date.now()).first();
  return row ? reply({ deviceName: row.device_name }) : reply({ error: 'Code not found or expired' }, 404);
}

export async function tvApprove(request, env, actor) {
  if (request.method !== 'POST') return reply({ error: 'Method not allowed' }, 405);
  if (!sameOrigin(request)) return reply({ error: 'Invalid origin' }, 403);
  if (!env.DB) return reply({ error: 'Storage unavailable' }, 503);
  const body = await jsonBody(request);
  const code = normalizeCode(body?.userCode);
  if (body?.confirmed !== true || !/^[BCDFGHJKLMNPQRSTVWXZ23456789]{8}$/.test(code)) return reply({ error: 'Confirm the Apple TV to pair' }, 400);
  const result = await env.DB.prepare("UPDATE tv_pairings SET status = 'approved', actor_id = ? WHERE user_code_hash = ? AND status = 'pending' AND expires_at > ?").bind(actor, await sha256Hex(code), Date.now()).run();
  return (result.meta?.changes ?? 0) > 0 ? reply({ ok: true }) : reply({ error: 'Code not found or expired' }, 404);
}

export async function tvPoll(request, env) {
  if (request.method !== 'POST') return reply({ error: 'Method not allowed' }, 405);
  if (!env.DB) return reply({ error: 'Storage unavailable' }, 503);
  if (await limited(env, 'poll', request, 1200)) return reply({ error: 'slow_down' }, 429);
  const body = await jsonBody(request);
  if (!DEVICE_CODE.test(body?.deviceCode ?? '')) return reply({ error: 'invalid_request' }, 400);
  const now = Date.now();
  const row = await env.DB.prepare('SELECT id, status, expires_at, last_polled_at FROM tv_pairings WHERE device_code_hash = ?').bind(await sha256Hex(body.deviceCode)).first();
  if (!row || row.expires_at <= now || !['pending', 'approved'].includes(row.status)) return reply({ error: 'expired_token' }, 400);
  if (row.status === 'pending') {
    if (row.last_polled_at && now - row.last_polled_at < INTERVAL_MS) return reply({ error: 'slow_down' }, 400);
    await env.DB.prepare('UPDATE tv_pairings SET last_polled_at = ? WHERE id = ?').bind(now, row.id).run();
    return reply({ error: 'authorization_pending' }, 400);
  }
  const token = randomToken();
  const claim = await env.DB.prepare("UPDATE tv_pairings SET status = 'redeemed', token_hash = ?, last_polled_at = ? WHERE id = ? AND status = 'approved' AND expires_at > ?").bind(await sha256Hex(token), now, row.id, now).run();
  if ((claim.meta?.changes ?? 0) === 0) return reply({ error: 'expired_token' }, 400);
  return reply({ accessToken: token, tokenType: 'Bearer', scope: 'tv:read' });
}

// Returns the owner actor for a valid, unrevoked TV token, or null.
export async function tvActor(request, env) {
  const match = BEARER.exec(request.headers.get('authorization') ?? '');
  if (!match || !env.DB) return null;
  const row = await env.DB.prepare("SELECT id, actor_id FROM tv_pairings WHERE token_hash = ? AND status = 'redeemed' AND revoked_at IS NULL").bind(await sha256Hex(match[1])).first();
  if (!row) return null;
  const stale = new Date(Date.now() - 60000).toISOString();
  await env.DB.prepare('UPDATE tv_pairings SET last_used_at = ? WHERE id = ? AND (last_used_at IS NULL OR last_used_at < ?)').bind(new Date().toISOString(), row.id, stale).run();
  return row.actor_id;
}

export async function tvDevices(request, env, actor) {
  if (request.method !== 'GET') return reply({ error: 'Method not allowed' }, 405);
  if (!env.DB) return reply({ error: 'Storage unavailable' }, 503);
  const rows = await env.DB.prepare("SELECT id, device_name, created_at, last_used_at, revoked_at FROM tv_pairings WHERE actor_id = ? AND status = 'redeemed' ORDER BY created_at DESC LIMIT 50").bind(actor).all();
  return reply({ devices: (rows.results ?? []).map(r => ({ id: r.id, deviceName: r.device_name, createdAt: r.created_at, lastUsedAt: r.last_used_at, revokedAt: r.revoked_at })) });
}

export async function tvRevoke(request, env, actor, id) {
  if (request.method !== 'POST') return reply({ error: 'Method not allowed' }, 405);
  if (!sameOrigin(request)) return reply({ error: 'Invalid origin' }, 403);
  if (!env.DB) return reply({ error: 'Storage unavailable' }, 503);
  if (!UUID.test(id)) return reply({ error: 'Not found' }, 404);
  const result = await env.DB.prepare('UPDATE tv_pairings SET revoked_at = ? WHERE id = ? AND actor_id = ? AND status = ? AND revoked_at IS NULL').bind(new Date().toISOString(), id, actor, 'redeemed').run();
  return (result.meta?.changes ?? 0) > 0 ? reply({ ok: true }) : reply({ error: 'Not found' }, 404);
}
