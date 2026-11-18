import { decryptPortalDocument, encryptPortalDocument, importPortalKey, newPortalToken, portalTokenHash } from './portal-crypto.mjs';
import { normalizePhone } from './phone.mjs';

const security = { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; connect-src 'self'; style-src 'unsafe-inline'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'" };
const json = (value, status = 200, extra = {}) => Response.json(value, { status, headers: { ...security, ...extra } });
const fail = (status = 404) => json({ error: 'Unavailable' }, status);
const cookie = token => `__Secure-sdportal=${token}; Path=/portal; Secure; HttpOnly; SameSite=Strict; Max-Age=1800`;
const validEmail = s => typeof s === 'string' && s.length <= 254 && /^[^\s@<>\r\n]+@[^\s@<>\r\n]+\.[^\s@<>\r\n]+$/.test(s);
const uuid = s => typeof s === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
const ready = env => env.DB && env.FILES && env.PORTAL_ORIGIN && env.PORTAL_KEY;
const originOK = (r, env) => { try { const u = new URL(env.PORTAL_ORIGIN); return u.protocol === 'https:' && u.origin === env.PORTAL_ORIGIN && new URL(r.url).origin === u.origin && r.headers.get('origin') === u.origin; } catch { return false; } };
async function limit(env, category, value, maximum) {
  // Hash destination/client identifiers; bounded fixed windows are deliberately fail-closed.
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${category}:${value}`)));
  const bucket = Array.from(digest, b => b.toString(16).padStart(2, '0')).join('');
  const period = Math.floor(Date.now() / 3600000);
  const row = await env.DB.prepare('INSERT INTO portal_limits (bucket, period, count) VALUES (?, ?, 1) ON CONFLICT(bucket, period) DO UPDATE SET count = count + 1 WHERE count < ? RETURNING count').bind(bucket, period, maximum).first();
  return !!row;
}
async function body(r) {
  if (!r.headers.get('content-type')?.toLowerCase().startsWith('application/json')) throw Error();
  const reader = r.body?.getReader(); if (!reader) throw Error();
  let size = 0, chunks = [];
  for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > 2048) { await reader.cancel(); throw Error(); } chunks.push(value); }
  return JSON.parse(await new Blob(chunks).text());
}
async function session(r, env) {
  const matches = [...(r.headers.get('cookie') || '').matchAll(/(?:^|;\s*)__Secure-sdportal=([^;]*)/g)];
  if (matches.length !== 1) return null;
  let hash; try { hash = await portalTokenHash(matches[0][1]); } catch { return null; }
  return env.DB.prepare('SELECT d.*, s.session_hash FROM portal_sessions s JOIN portal_deliveries d ON d.id = s.delivery_id WHERE s.session_hash = ? AND s.expires_at > ? AND d.expires_at > ? AND d.revoked_at IS NULL').bind(hash, Date.now(), Date.now()).first();
}

// Owner API is called only after the Worker has verified its Access JWT.
export async function createEmailDelivery(r, env, actor, transmissionId) {
  if (r.method !== 'POST') return fail(405);
  if (!ready(env) || typeof env.PORTAL_EMAIL?.send !== 'function' || !validEmail(env.PORTAL_SENDER)) return json({ error: 'Email portal is not configured: set PORTAL_ORIGIN, PORTAL_KEY, PORTAL_SENDER and the PORTAL_EMAIL binding.' }, 503);
  if (!originOK(r, env)) return fail(403);
  let b; try { b = await body(r); } catch { return fail(400); }
  if (!uuid(transmissionId) || !validEmail(b?.email) || !['none', 'sms', 'voice'].includes(b?.pinChannel)) return fail(400);
  let phone = null;
  if (b.pinChannel !== 'none') {
    phone = normalizePhone(b.phone);
    if (!phone) return json({ error: 'Enter a valid verification phone number.' }, 400);
    if (!env.TELNYX_VERIFY_PROFILE_ID || !env.TELNYX_API_TOKEN) return json({ error: 'Phone verification requires TELNYX_VERIFY_PROFILE_ID and TELNYX_API_TOKEN.' }, 503);
  }
  if (!(await limit(env, 'email-owner', actor, 30)) || !(await limit(env, 'email-destination', b.email.toLowerCase(), 5))) return fail(429);
  const tx = await env.DB.prepare('SELECT source_key FROM transmissions WHERE id = ? AND actor_id = ?').bind(transmissionId, actor).first();
  if (!tx) return fail();
  const source = await env.FILES.get(tx.source_key); if (!source) return fail(503);
  const bytes = new Uint8Array(await source.arrayBuffer()); if (bytes.length > 5 * 1024 * 1024) return fail(400);
  let key; try { key = await importPortalKey(env.PORTAL_KEY); } catch { return json({ error: 'PORTAL_KEY must be a 32-byte base64url secret.' }, 503); }
  const id = crypto.randomUUID(), token = newPortalToken(), now = Date.now();
  const encrypted = await encryptPortalDocument(key, bytes, id, 'source');
  const objectKey = `portal/${id}/source.enc`;
  await env.FILES.put(objectKey, encrypted.ciphertext);
  await env.DB.prepare('INSERT INTO portal_deliveries (id, transmission_id, actor_id, recipient, token_hash, expires_at, object_key, iv, pin_channel, pin_phone, pin_state, send_status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').bind(id, transmissionId, actor, b.email, await portalTokenHash(token), now + 7 * 86400000, objectKey, encrypted.iv, b.pinChannel, phone, b.pinChannel === 'none' ? 'none' : 'pending', 'submitting', now).run();
  try {
    await env.PORTAL_EMAIL.send({ from: env.PORTAL_SENDER, to: b.email, subject: 'A document is available securely', text: `A document has been shared with you. Open this link to access it within seven days:\n\n${env.PORTAL_ORIGIN}/portal#${token}\n\nAnyone with this link can use it. Do not forward it.` });
    await env.DB.prepare("UPDATE portal_deliveries SET send_status = 'accepted' WHERE id = ?").bind(id).run();
    return json({ id, status: 'accepted', notice: 'Email accepted for sending; delivery is not confirmed.' }, 202);
  } catch {
    // A timeout can mean that email was sent. Never automatically retry.
    await env.DB.prepare("UPDATE portal_deliveries SET send_status = 'unknown' WHERE id = ?").bind(id).run();
    return json({ id, status: 'unknown', notice: 'Email outcome is unknown; check before sending again.' }, 202);
  }
}

export async function revokeEmailDelivery(r, env, actor, transmissionId, id) {
  if (r.method !== 'POST') return fail(405);
  if (!ready(env)) return fail(503);
  if (!originOK(r, env)) return fail(403);
  const result = await env.DB.prepare('UPDATE portal_deliveries SET revoked_at = ? WHERE id = ? AND transmission_id = ? AND actor_id = ? AND revoked_at IS NULL').bind(Date.now(), id, transmissionId, actor).run();
  return result.meta.changes === 1 ? json({ status: 'revoked' }) : fail();
}

async function telnyx(env, path, payload, fetcher) {
  try {
    const response = await fetcher(`https://api.telnyx.com/v2/${path}`, { method: 'POST', headers: { Authorization: `Bearer ${env.TELNYX_API_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify(payload), redirect: 'error' });
    if (!response.ok) return null;
    return await response.json();
  } catch { return null; }
}

export async function portal(r, env, fetcher = fetch) {
  const path = new URL(r.url).pathname;
  if (!ready(env)) return fail(503);
  if (path === '/portal' && r.method === 'GET') return new Response(PAGE, { headers: { ...security, 'Content-Type': 'text/html; charset=utf-8' } });
  if (r.method === 'POST' && !originOK(r, env)) return fail(403);
  if (r.method === 'POST') {
    const ip = r.headers.get('cf-connecting-ip');
    if (!ip || ip.length > 64 || !(await limit(env, 'portal-client', ip, 120))) return fail(429);
  }
  if (path === '/portal/exchange' && r.method === 'POST') {
    let b, hash; try { b = await body(r); hash = await portalTokenHash(b.token); } catch { return fail(400); }
    const now = Date.now();
    const row = await env.DB.prepare('UPDATE portal_deliveries SET consumed_at = ? WHERE token_hash = ? AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at > ? RETURNING id, expires_at').bind(now, hash, now).first();
    if (!row) return fail();
    const value = newPortalToken();
    await env.DB.prepare('INSERT INTO portal_sessions (session_hash, delivery_id, expires_at) VALUES (?, ?, ?)').bind(await portalTokenHash(value), row.id, Math.min(row.expires_at, now + 1800000)).run();
    return json({ status: 'ok' }, 200, { 'Set-Cookie': cookie(value) });
  }
  const s = await session(r, env); if (!s) return fail();
  if (path === '/portal/status' && r.method === 'GET') return json({ pinChannel: s.pin_channel, pinState: s.pin_state, phoneEnding: s.pin_phone?.slice(-4) ?? null });
  if (path === '/portal/pin/start' && r.method === 'POST') {
    let b; try { b = await body(r); } catch { return fail(400); }
    if (b?.consent !== true || s.pin_state !== 'pending' || !['sms', 'voice'].includes(s.pin_channel) || !env.TELNYX_VERIFY_PROFILE_ID || !env.TELNYX_API_TOKEN) return fail(400);
    if (!(await limit(env, 'verify-destination', s.pin_phone, 3))) return fail(429);
    const claim = await env.DB.prepare("UPDATE portal_deliveries SET pin_state = 'submitting', consent_at = ?, consent_version = 'portal-v1' WHERE id = ? AND pin_state = 'pending' AND revoked_at IS NULL AND expires_at > ?").bind(Date.now(), s.id, Date.now()).run();
    if (claim.meta.changes !== 1) return fail(409);
    const result = await telnyx(env, `verifications/${s.pin_channel === 'sms' ? 'sms' : 'call'}`, { phone_number: s.pin_phone, verify_profile_id: env.TELNYX_VERIFY_PROFILE_ID, timeout_secs: 300 }, fetcher);
    if (!uuid(result?.data?.id)) { await env.DB.prepare("UPDATE portal_deliveries SET pin_state = 'unknown' WHERE id = ? AND pin_state = 'submitting'").bind(s.id).run(); return fail(503); }
    await env.DB.prepare("UPDATE portal_deliveries SET pin_state = 'sent', verify_id = ? WHERE id = ? AND pin_state = 'submitting'").bind(result.data.id, s.id).run();
    return json({ status: 'sent' });
  }
  if (path === '/portal/pin/check' && r.method === 'POST') {
    let b; try { b = await body(r); } catch { return fail(400); }
    if (!/^\d{4,10}$/.test(b?.code ?? '') || s.pin_state !== 'sent' || !uuid(s.verify_id)) return fail(400);
    const claim = await env.DB.prepare("UPDATE portal_deliveries SET pin_attempts = pin_attempts + 1 WHERE id = ? AND pin_state = 'sent' AND pin_attempts < 5 AND revoked_at IS NULL AND expires_at > ?").bind(s.id, Date.now()).run();
    if (claim.meta.changes !== 1) return fail(429);
    const result = await telnyx(env, `verifications/${s.verify_id}/actions/verify`, { code: b.code }, fetcher);
    if (result?.data?.response_code !== 'accepted') return fail(403);
    await env.DB.prepare("UPDATE portal_deliveries SET pin_state = 'verified' WHERE id = ? AND pin_state = 'sent' AND revoked_at IS NULL AND expires_at > ?").bind(s.id, Date.now()).run();
    return json({ status: 'verified' });
  }
  if (path === '/portal/document' && r.method === 'GET') {
    if (!['none', 'verified'].includes(s.pin_state)) return fail(403);
    const object = await env.FILES.get(s.object_key); if (!object) return fail();
    try {
      const bytes = await decryptPortalDocument(await importPortalKey(env.PORTAL_KEY), { version: 1, iv: s.iv, ciphertext: await object.arrayBuffer() }, s.id, 'source');
      return new Response(bytes, { headers: { ...security, 'Content-Type': 'application/pdf', 'Content-Disposition': 'attachment; filename="document.pdf"' } });
    } catch { return fail(503); }
  }
  return fail();
}

const PAGE = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Secure document</title><main><h1>Secure document</h1><p id="message">Open the link in your email to continue.</p><button id="open" hidden>Continue</button><section id="pin" hidden><p id="disclosure"></p><label><input type="checkbox" id="consent"> I agree to receive the automated verification message or call at the number provided by the sender. Message and data rates may apply.</label><p><button id="send">Send verification code</button></p><label>Verification code <input id="code" inputmode="numeric" autocomplete="one-time-code"></label><button id="check">Verify</button></section><p><a id="document" href="/portal/document" hidden>Download document</a></p></main><script>
const m=document.querySelector('#message'), open=document.querySelector('#open'), pin=document.querySelector('#pin'), link=document.querySelector('#document'); const token=location.hash.slice(1); history.replaceState(null,'',location.pathname); async function post(path,data){const r=await fetch(path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(data)});if(!r.ok)throw Error();return r.json()} async function status(){const r=await fetch('/portal/status');if(!r.ok)throw Error();const s=await r.json();if(s.pinState==='none'||s.pinState==='verified'){m.textContent='Your document is ready.';pin.hidden=true;link.hidden=false}else{m.textContent='Verification is required.';pin.hidden=false;document.querySelector('#disclosure').textContent=(s.pinChannel==='sms'?'An automated SMS will be sent':'An automated voice call will be placed')+' to the number ending in '+s.phoneEnding+'.';document.querySelector('#send').disabled=s.pinState!=='pending'}} if(token){open.hidden=false;open.onclick=async()=>{open.disabled=true;try{await post('/portal/exchange',{token});open.hidden=true;await status()}catch{m.textContent='This link is unavailable or expired.'}}}else status().catch(()=>{});document.querySelector('#send').onclick=async()=>{if(!document.querySelector('#consent').checked){m.textContent='Please agree before requesting a code.';return}try{await post('/portal/pin/start',{consent:true});await status()}catch{m.textContent='Verification could not be started. Contact the sender.'}};document.querySelector('#check').onclick=async()=>{try{await post('/portal/pin/check',{code:document.querySelector('#code').value});document.querySelector('#code').value='';await status()}catch{m.textContent='Verification failed. Check your code or contact the sender.'}};
</script></html>`;
