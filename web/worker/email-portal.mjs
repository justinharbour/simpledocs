import { decryptPortalDocument, encryptPortalDocument, importPortalKey, newPortalAccessCode, newPortalToken, portalInvitationHash, portalTokenHash, portalExchangeSession, portalKeyId, portalDecryptionKey } from './portal-crypto.mjs';
import { normalizePhone } from './phone.mjs';
import { sha256Hex } from './deliveries.mjs';

const csp = "default-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'";
const security = { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Content-Security-Policy': csp };
const json = (value, status = 200, extra = {}) => Response.json(value, { status, headers: { ...security, ...extra } });
const fail = (status = 404) => json({ error: 'Unavailable' }, status);
const cookie = token => `__Host-sdportal=${token}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=1800`;
const validEmail = s => typeof s === 'string' && s.length <= 254 && /^[^\s@<>\r\n]+@[^\s@<>\r\n]+\.[^\s@<>\r\n]+$/.test(s);
const uuid = s => typeof s === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
const ready = env => env.DB && env.FILES && isHttpsOrigin(env.PORTAL_ORIGIN) && env.PORTAL_KEY;
export const portalAvailable = env => !!(ready(env) && typeof env.PORTAL_EMAIL?.send === 'function' && validEmail(env.PORTAL_SENDER));
const isHttpsOrigin = value => { try { const u = new URL(value); return u.protocol === 'https:' && u.origin === value; } catch { return false; } };
const requestOriginOK = (r, env) => isHttpsOrigin(env.PORTAL_ORIGIN) && new URL(r.url).origin === env.PORTAL_ORIGIN;
export const portalMutationOriginOK = (r, env) => {
  const origin = new URL(r.url).origin;
  return isHttpsOrigin(origin) && [env.PORTAL_ORIGIN, env.PORTAL_LEGACY_OWNER_ORIGIN].includes(origin) && r.headers.get('origin') === origin;
};
export const portalVerifyAvailable = env => !!(uuid(env.TELNYX_VERIFY_PROFILE_ID) && env.TELNYX_API_TOKEN);
export function validatePortalRecipient(b, env) {
  if (!validEmail(b?.email) || !['none', 'sms', 'voice'].includes(b?.pinChannel)) return { error: 'Enter a valid email address and verification option.', status: 400 };
  if (b.pinChannel === 'none') return null;
  if (!portalVerifyAvailable(env)) return { error: 'Phone verification is not configured on this instance.', status: 503 };
  if (typeof b.phone !== 'string' || b.phone.length > 40 || !/^\+1[2-9]\d{2}[2-9]\d{6}$/.test(normalizePhone(b.phone) ?? '')) return { error: 'Enter a valid North American verification number.', status: 400 };
  return null;
}
async function limit(env, category, value, maximum) {
  // Pseudonymize low-entropy phone, email and IP values with a keyed digest.
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.PORTAL_KEY), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const digest = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`simpledocs:portal-limit:v1:${category}:${value}`)));
  const bucket = Array.from(digest, b => b.toString(16).padStart(2, '0')).join('');
  const period = Math.floor(Date.now() / 3600000);
  let row;
  try { row = await env.DB.prepare('INSERT INTO portal_limits (bucket, period, count) VALUES (?, ?, 1) ON CONFLICT(bucket, period) DO UPDATE SET count = count + 1 WHERE count < ? RETURNING count').bind(bucket, period, maximum).first(); } catch { return false; }
  return !!row;
}
async function body(r) {
  if (r.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') throw Error();
  const reader = r.body?.getReader(); if (!reader) throw Error();
  let size = 0, chunks = [];
  for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > 2048) { await reader.cancel(); throw Error(); } chunks.push(value); }
  return JSON.parse(await new Blob(chunks).text());
}
async function session(r, env) {
  const matches = [...(r.headers.get('cookie') || '').matchAll(/(?:^|;\s*)__Host-sdportal=([^;]*)/g)];
  if (matches.length !== 1) return null;
  let hash; try { hash = await portalTokenHash(matches[0][1]); } catch { return null; }
  return env.DB.prepare('SELECT d.*, s.session_hash FROM portal_sessions s JOIN portal_deliveries d ON d.id = s.delivery_id WHERE s.session_hash = ? AND s.expires_at > ? AND d.expires_at > ? AND d.revoked_at IS NULL').bind(hash, Date.now(), Date.now()).first();
}

// Owner API is called only after the Worker has verified its Access JWT.
export async function createEmailDelivery(r, env, actor, transmissionId, fromTransmission = false, approvedHash = null) {
  if (r.method !== 'POST') return fail(405);
  if (!env.DB) return fail(503);
  if (!portalMutationOriginOK(r, env)) return fail(403);
  if (!portalAvailable(env)) return json({ error: 'Email portal requires an encryption key, sender address, and email binding.' }, 503);
  let b; try { b = await body(r); } catch { return fail(400); }
  const invalid = validatePortalRecipient(b, env);
  if (invalid) return json({ error: invalid.error }, invalid.status);
  if (!uuid(transmissionId)) return fail(400);
  const tx = await env.DB.prepare('SELECT source_key FROM transmissions WHERE id = ? AND actor_id = ?').bind(transmissionId, actor).first();
  if (!tx) return fail();
  const prepared = await env.DB.prepare('SELECT options_json, pdf_sha256 FROM email_reviews WHERE transmission_id = ? AND actor_id = ?').bind(transmissionId, actor).first();
  if (prepared) {
    const options = JSON.parse(prepared.options_json);
    const hash = await sha256Hex(JSON.stringify({ transmissionId, options, pdfSha256: prepared.pdf_sha256 }));
    if (!fromTransmission || approvedHash !== hash || b.email !== options.email || b.pinChannel !== options.pinChannel || (b.pinChannel === 'none' ? null : normalizePhone(b.phone)) !== options.phone) return json({ error: 'Review and approve this email before sending.' }, 409);
  }
  const recipient = typeof b?.email === 'string' ? b.email.slice(0, 254) : '';
  const claimed = fromTransmission
    ? await env.DB.prepare("UPDATE email_attempts SET status = 'preparing' WHERE transmission_id = ? AND actor_id = ? AND status = 'pending'").bind(transmissionId, actor).run()
    : await env.DB.prepare("INSERT INTO email_attempts (transmission_id, actor_id, recipient, status, created_at) VALUES (?, ?, ?, 'preparing', ?) ON CONFLICT(transmission_id) DO NOTHING").bind(transmissionId, actor, recipient, Date.now()).run();
  if (claimed.meta.changes !== 1) return json({ error: 'Email was already attempted for this transmission. Check Records before sending again.' }, 409);
  const reject = async (message, status = 503) => {
    await env.DB.prepare("UPDATE email_attempts SET status = 'failed', error = ? WHERE transmission_id = ? AND status = 'preparing'").bind(message, transmissionId).run();
    return json({ error: message }, status);
  };
  const phone = b.pinChannel === 'none' ? null : normalizePhone(b.phone);
  if (!(await limit(env, 'email-owner', actor, 30)) || !(await limit(env, 'email-destination', b.email.toLowerCase(), 5)) || !(await limit(env, 'email-global', 'all', 50))) return reject('Email rate limit reached. Try again later with a new transmission.', 429);
  const source = await env.FILES.get(tx.source_key); if (!source) return reject('The source document is unavailable.');
  if (source.size > 5 * 1024 * 1024) return reject('The source document exceeds 5 MB.', 400);
  const bytes = new Uint8Array(await source.arrayBuffer()); if (bytes.length > 5 * 1024 * 1024) return reject('The source document exceeds 5 MB.', 400);
  if (prepared && await sha256Hex(bytes) !== prepared.pdf_sha256) return reject('The document changed after review.', 409);
  let key; try { key = await importPortalKey(env.PORTAL_KEY); } catch { return reject('PORTAL_KEY must be a 32-byte base64url secret.'); }
  const id = crypto.randomUUID(), token = newPortalToken(), accessCode = newPortalAccessCode(), now = Date.now();
  const encrypted = await encryptPortalDocument(key, bytes, id, 'source');
  const objectKey = `portal/${id}/source.enc`;
  await env.DB.prepare('INSERT INTO portal_object_intents (object_key, cleanup_after) VALUES (?, ?)').bind(objectKey, now + 8 * 86400000).run();
  await env.FILES.put(objectKey, encrypted.ciphertext);
  await env.DB.batch([
    env.DB.prepare('INSERT INTO portal_deliveries (id, transmission_id, actor_id, recipient, token_hash, expires_at, object_key, iv, key_id, pin_channel, pin_phone, pin_state, send_status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').bind(id, transmissionId, actor, b.email, await portalInvitationHash(token, accessCode), now + 7 * 86400000, objectKey, encrypted.iv, await portalKeyId(env.PORTAL_KEY), b.pinChannel, phone, b.pinChannel === 'none' ? 'none' : 'pending', 'unknown', now),
    env.DB.prepare('DELETE FROM portal_object_intents WHERE object_key = ?').bind(objectKey),
    env.DB.prepare("UPDATE email_attempts SET status = 'unknown', delivery_id = ? WHERE transmission_id = ? AND status = 'preparing'").bind(id, transmissionId),
  ]);
  // Persist the no-retry boundary before the provider call. A crash after this
  // claim leaves an honest unknown outcome, even if the provider accepted it.
  try {
    await env.PORTAL_EMAIL.send({ from: env.PORTAL_SENDER, to: b.email, subject: 'A document is available securely', text: `A document has been shared with you. Open this link within seven days:\n\n${env.PORTAL_ORIGIN}/portal#${token}\n\nEnter this access code on the page: ${accessCode}\n\nDo not forward this email.` });
    await env.DB.batch([
      env.DB.prepare("UPDATE portal_deliveries SET send_status = 'accepted' WHERE id = ?").bind(id),
      env.DB.prepare("UPDATE email_attempts SET status = 'accepted' WHERE transmission_id = ? AND status = 'unknown'").bind(transmissionId),
    ]);
    return json({ id, status: 'accepted', notice: 'Email accepted for sending; delivery is not confirmed.' }, 202);
  } catch {
    // A timeout can mean that email was sent. Never automatically retry.
    return json({ id, status: 'unknown', notice: 'Email outcome is unknown; check before sending again.' }, 202);
  }
}

export async function revokeEmailDelivery(r, env, actor, transmissionId, id) {
  if (r.method !== 'POST') return fail(405);
  if (!env.DB) return fail(503);
  if (!portalMutationOriginOK(r, env)) return fail(403);
  if (!uuid(transmissionId) || !uuid(id)) return fail();
  const result = await env.DB.prepare('UPDATE portal_deliveries SET revoked_at = ? WHERE id = ? AND transmission_id = ? AND actor_id = ? AND revoked_at IS NULL').bind(Date.now(), id, transmissionId, actor).run();
  return result.meta.changes === 1 ? json({ status: 'revoked' }) : fail();
}

// Bounded cleanup preserves delivery metadata and consent audit while removing
// expired sessions and encrypted copies. Failed deletes remain eligible for retry.
export async function cleanupPortal(env, now = Date.now()) {
  if (!env.DB || typeof env.FILES?.delete !== 'function') return;
  await env.DB.prepare('DELETE FROM portal_sessions WHERE session_hash IN (SELECT session_hash FROM portal_sessions WHERE expires_at <= ? LIMIT 500)').bind(now).run();
  await env.DB.prepare('DELETE FROM portal_limits WHERE (bucket, period) IN (SELECT bucket, period FROM portal_limits WHERE period < ? LIMIT 3000)').bind(Math.floor(now / 3600000) - 1).run();
  const orphans = await env.DB.prepare('SELECT object_key FROM portal_object_intents WHERE cleanup_after <= ? ORDER BY cleanup_after LIMIT 50').bind(now).all();
  for (const row of orphans.results ?? []) {
    try {
      await env.FILES.delete(row.object_key);
      await env.DB.prepare('DELETE FROM portal_object_intents WHERE object_key = ?').bind(row.object_key).run();
    } catch { /* retry in the next scheduled run */ }
  }
  const rows = await env.DB.prepare("SELECT id, object_key FROM portal_deliveries WHERE (expires_at <= ? OR revoked_at IS NOT NULL) AND object_key <> '' ORDER BY expires_at LIMIT 50").bind(now).all();
  for (const row of rows.results ?? []) {
    try {
      await env.FILES.delete(row.object_key);
      await env.DB.prepare("UPDATE portal_deliveries SET object_key = '' WHERE id = ? AND object_key = ?").bind(row.id, row.object_key).run();
    } catch { /* retry in the next scheduled run */ }
  }
}

async function telnyx(env, path, payload) {
  try {
    const response = await fetch(`https://api.telnyx.com/v2/${path}`, { method: 'POST', headers: { Authorization: `Bearer ${env.TELNYX_API_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify(payload), redirect: 'error', signal: AbortSignal.timeout(10000) });
    if (!response.ok) return null;
    return await response.json();
  } catch { return null; }
}

export async function portal(r, env) {
  const path = new URL(r.url).pathname;
  if (!requestOriginOK(r, env)) return fail();
  if (!ready(env)) return json({ error: 'The document portal is temporarily unavailable.' }, 503);
  if (path === '/portal' && r.method === 'GET') {
    const nonce = newPortalToken();
    return new Response(PAGE.replace('<script>', `<script nonce="${nonce}">`), { headers: { ...security, 'Content-Security-Policy': `${csp}; script-src 'nonce-${nonce}'; connect-src 'self'`, 'Content-Type': 'text/html; charset=utf-8' } });
  }
  if (r.method === 'POST' && r.headers.get('origin') !== env.PORTAL_ORIGIN) return fail(403);
  if (r.method === 'POST') {
    const ip = r.headers.get('cf-connecting-ip');
    if (!ip || ip.length > 64 || !(await limit(env, 'portal-client', ip, 120)) || !(await limit(env, 'portal-global', 'all', 1500))) return fail(429);
  }
  if (path === '/portal/exchange' && r.method === 'POST') {
    let b, hash, value; try { b = await body(r); hash = await portalInvitationHash(b.token, b.accessCode); value = await portalExchangeSession(hash, b.verifier); } catch { return fail(400); }
    const now = Date.now();
    const sessionHash = await portalTokenHash(value);
    const results = await env.DB.batch([
      env.DB.prepare('INSERT INTO portal_sessions (session_hash, delivery_id, expires_at) SELECT ?, id, MIN(expires_at, ?) FROM portal_deliveries WHERE token_hash = ? AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at > ?').bind(sessionHash, now + 1800000, hash, now),
      env.DB.prepare('UPDATE portal_deliveries SET consumed_at = ? WHERE token_hash = ? AND consumed_at IS NULL AND EXISTS (SELECT 1 FROM portal_sessions WHERE session_hash = ? AND delivery_id = portal_deliveries.id)').bind(now, hash, sessionHash),
    ]);
    if (results[0].meta.changes !== 1 || results[1].meta.changes !== 1) {
      const existing = await env.DB.prepare('SELECT 1 FROM portal_sessions s JOIN portal_deliveries d ON d.id = s.delivery_id WHERE s.session_hash = ? AND d.token_hash = ? AND s.expires_at > ? AND d.expires_at > ? AND d.revoked_at IS NULL').bind(sessionHash, hash, now, now).first();
      if (!existing) return fail();
    }
    return json({ status: 'ok' }, 200, { 'Set-Cookie': cookie(value) });
  }
  const s = await session(r, env); if (!s) return fail();
  if (path === '/portal/status' && r.method === 'GET') return json({ pinChannel: s.pin_channel, pinState: s.pin_state, phoneEnding: s.pin_phone?.slice(-4) ?? null });
  if (path === '/portal/pin/start' && r.method === 'POST') {
    let b; try { b = await body(r); } catch { return fail(400); }
    if (b?.consent !== true || s.pin_state !== 'pending' || !['sms', 'voice'].includes(s.pin_channel)) return fail(400);
    if (!portalVerifyAvailable(env)) return json({ error: 'Phone verification is temporarily unavailable.' }, 503);
    if (normalizePhone(b.phone) !== s.pin_phone) return fail(403);
    if (!(await limit(env, 'verify-global', 'all', 30)) || !(await limit(env, 'verify-destination', s.pin_phone, 3))) return fail(429);
    const now = Date.now();
    const claim = await env.DB.prepare("UPDATE portal_deliveries SET pin_state = 'submitting', consent_at = ?, consent_version = 'portal-v2' WHERE id = ? AND pin_state = 'pending' AND revoked_at IS NULL AND expires_at > ? AND EXISTS (SELECT 1 FROM portal_sessions WHERE session_hash = ? AND delivery_id = portal_deliveries.id AND expires_at > ?)").bind(now, s.id, now, s.session_hash, now).run();
    if (claim.meta.changes !== 1) return fail(409);
    const result = await telnyx(env, `verifications/${s.pin_channel === 'sms' ? 'sms' : 'call'}`, { phone_number: s.pin_phone, verify_profile_id: env.TELNYX_VERIFY_PROFILE_ID, timeout_secs: 300 });
    if (!uuid(result?.data?.id)) { await env.DB.prepare("UPDATE portal_deliveries SET pin_state = 'unknown' WHERE id = ? AND pin_state = 'submitting'").bind(s.id).run(); return fail(503); }
    await env.DB.prepare("UPDATE portal_deliveries SET pin_state = 'sent', verify_id = ? WHERE id = ? AND pin_state = 'submitting'").bind(result.data.id, s.id).run();
    return json({ status: 'sent' });
  }
  if (path === '/portal/pin/check' && r.method === 'POST') {
    let b; try { b = await body(r); } catch { return fail(400); }
    if (typeof b?.code !== 'string' || !/^\d{4,10}$/.test(b.code) || s.pin_state !== 'sent' || !uuid(s.verify_id) || !portalVerifyAvailable(env) || s.consent_at + 300000 <= Date.now()) return fail(400);
    const now = Date.now();
    const claim = await env.DB.prepare("UPDATE portal_deliveries SET pin_attempts = pin_attempts + 1 WHERE id = ? AND pin_state = 'sent' AND pin_attempts < 5 AND revoked_at IS NULL AND expires_at > ? AND consent_at > ? AND EXISTS (SELECT 1 FROM portal_sessions WHERE session_hash = ? AND delivery_id = portal_deliveries.id AND expires_at > ?)").bind(s.id, now, now - 300000, s.session_hash, now).run();
    if (claim.meta.changes !== 1) return fail(429);
    const result = await telnyx(env, `verifications/${s.verify_id}/actions/verify`, { code: b.code });
    if (!result) return fail(503);
    if (result.data?.response_code !== 'accepted') return fail(403);
    const verified = await env.DB.prepare("UPDATE portal_deliveries SET pin_state = 'verified' WHERE id = ? AND pin_state = 'sent' AND revoked_at IS NULL AND expires_at > ?").bind(s.id, Date.now()).run();
    return verified.meta.changes === 1 ? json({ status: 'verified' }) : fail();
  }
  if (path === '/portal/document' && r.method === 'GET') {
    if (!['none', 'verified'].includes(s.pin_state)) return fail(403);
    if (!s.object_key) return fail();
    const object = await env.FILES.get(s.object_key); if (!object || object.size > 5 * 1024 * 1024 + 16) return fail();
    try {
      const bytes = await decryptPortalDocument(await portalDecryptionKey(env, s.key_id), { version: 1, iv: s.iv, ciphertext: await object.arrayBuffer() }, s.id, 'source');
      if (!(await session(r, env))) return fail();
      return new Response(bytes, { headers: { ...security, 'Content-Type': 'application/pdf', 'Content-Disposition': 'attachment; filename="document.pdf"' } });
    } catch { return fail(503); }
  }
  return fail();
}

const PAGE = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Secure document</title><main><h1>Secure document</h1><p id="message" role="status">Open the link in your email to continue.</p><div id="invitation" hidden><label>Access code from your email <input id="access-code" autocomplete="off" maxlength="10" spellcheck="false"></label><button id="open">Continue</button></div><section id="pin" hidden><div id="request-code"><p id="disclosure"></p><p><label>Your full phone number <input id="phone" type="tel" autocomplete="tel" maxlength="40"></label></p><label><input type="checkbox" id="consent"> I control this number and agree to receive one automated verification message or call. Message and data rates may apply.</label><p><button id="send">Send verification code</button></p></div><div id="enter-code" hidden><label>Verification code <input id="code" inputmode="numeric" autocomplete="one-time-code" maxlength="10"></label><button id="check">Verify</button></div></section><p><a id="document" href="/portal/document" hidden>Download document</a></p></main><script>
const el = id => document.getElementById(id);
const message = text => { el('message').textContent = text; };
const token = location.hash.slice(1);
history.replaceState(null, '', location.pathname);
const verifier = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
async function post(path, data) {
  const r = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) });
  if (!r.ok) { const error = Error(); error.status = r.status; throw error; }
}
async function status() {
  const r = await fetch('/portal/status');
  if (!r.ok) throw Error();
  const s = await r.json();
  const complete = s.pinState === 'none' || s.pinState === 'verified';
  el('document').hidden = !complete;
  el('pin').hidden = complete;
  el('request-code').hidden = s.pinState !== 'pending';
  el('enter-code').hidden = s.pinState !== 'sent';
  if (complete) message('Your document is ready.');
  else if (s.pinState === 'pending') {
    message('Verification is required.');
    el('disclosure').textContent = (s.pinChannel === 'sms' ? 'An automated SMS will be sent' : 'An automated voice call will be placed') + ' to the number ending in ' + s.phoneEnding + '.';
  } else if (s.pinState === 'sent') message('Enter your verification code when it arrives.');
  else message('The verification request could not be confirmed. Contact the sender if you cannot continue.');
}
if (token) {
  el('invitation').hidden = false;
  message('Enter the access code from your email.');
  el('open').onclick = async event => {
    if (!event.isTrusted) return;
    el('open').disabled = true;
    try { await post('/portal/exchange', { token, verifier, accessCode: el('access-code').value.trim() }); await status(); el('access-code').value = ''; el('invitation').hidden = true; }
    catch { message('Could not open this link. Try again here, or contact the sender if the link has expired.'); }
    finally { el('open').disabled = false; }
  };
} else status().catch(() => {});
el('send').onclick = async () => {
  if (!el('consent').checked || !el('phone').value) { message('Enter your phone number and agree before requesting a code.'); return; }
  el('send').disabled = true;
  try { await post('/portal/pin/start', { consent: true, phone: el('phone').value }); el('phone').value = ''; await status(); }
  catch (error) {
    await status().catch(() => {});
    if (!el('request-code').hidden) message(error.status === 503 ? 'Phone verification is temporarily unavailable. Contact the sender.' : 'Verification could not be started. Check the number or contact the sender.');
  }
  finally { el('send').disabled = false; }
};
el('check').onclick = async () => {
  el('check').disabled = true;
  try { await post('/portal/pin/check', { code: el('code').value }); el('code').value = ''; await status(); }
  catch (error) {
    await status().catch(() => {});
    if (el('document').hidden) message(error.status === 503 ? 'Phone verification could not be confirmed. Try again or contact the sender.' : 'Verification failed. Check your code or contact the sender.');
  }
  finally { el('check').disabled = false; }
};
</script></html>`;
