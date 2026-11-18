// APNs push for the owner's iOS and macOS apps. Payloads carry no document
// content or phone numbers. Never log tokens, keys, or provider payloads.
// Sending never throws: a push failure must not break the primary flow.
const HOSTS = { production: 'https://api.push.apple.com', sandbox: 'https://api.sandbox.push.apple.com' };
const TOPICS = { ios: 'dev.justinharbour.simpledocs.ios', macos: 'dev.justinharbour.simpledocs.mac.connected' };
const TOKEN = /^[0-9a-f]{64,200}$/;
const JWT_MAX_AGE_MS = 50 * 60 * 1000;
const MESSAGES = {
  fax: ['New fax', 'A fax was received.'],
  voicemail: ['New voicemail', 'A voicemail was saved.'],
  'fax-failed': ['Fax failed', 'An outgoing fax could not be delivered.'],
  'fax-attention': ['Fax needs attention', 'An inbound fax has not been archived.'],
};
const reply = (body, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });

const b64url = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes))).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
const text64url = value => b64url(new TextEncoder().encode(JSON.stringify(value)));

function credentials(env) {
  const { APNS_KEY_P8: key, APNS_KEY_ID: keyId, APNS_TEAM_ID: teamId } = env;
  if (![key, keyId, teamId].every(v => typeof v === 'string' && v.trim())) return null;
  return { key, keyId: keyId.trim(), teamId: teamId.trim() };
}

function topicFor(env, platform) {
  const override = platform === 'macos' ? env.APNS_TOPIC_MACOS : env.APNS_TOPIC;
  return typeof override === 'string' && override.trim() ? override.trim() : TOPICS[platform];
}

let cached = null;
export function resetPushCache() { cached = null; }

// Apple asks providers to reuse a token for 20 to 60 minutes.
export async function providerToken({ key, keyId, teamId }, now) {
  const id = `${teamId}:${keyId}`;
  if (cached?.id === id && now - cached.at < JWT_MAX_AGE_MS && now >= cached.at) return cached.jwt;
  const pem = key.replaceAll('\\n', '\n').replace(/-----(BEGIN|END) PRIVATE KEY-----/g, '').replace(/\s+/g, '');
  const der = Uint8Array.from(atob(pem), c => c.charCodeAt(0));
  const privateKey = await crypto.subtle.importKey('pkcs8', der, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const input = `${text64url({ alg: 'ES256', kid: keyId })}.${text64url({ iss: teamId, iat: Math.floor(now / 1000) })}`;
  // WebCrypto returns the raw r||s form that JWS ES256 requires.
  const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, privateKey, new TextEncoder().encode(input));
  const jwt = `${input}.${b64url(signature)}`;
  cached = { id, at: now, jwt };
  return jwt;
}

// Lets request handlers push without blocking the response: index.mjs wraps env once per request.
export const withPush = (env, ctx) => ctx?.waitUntil ? { ...env, waitUntil: promise => ctx.waitUntil(promise) } : env;
export function pushLater(env, event) {
  const promise = notifyPush(env, event);
  env.waitUntil?.(promise);
  return promise;
}

async function sendOne(env, device, jwt, body, fetcher) {
  const response = await fetcher(`${HOSTS[device.environment]}/3/device/${device.token}`, {
    method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(4000), body,
    headers: {
      authorization: `bearer ${jwt}`, 'apns-topic': topicFor(env, device.platform), 'apns-push-type': 'alert',
      'apns-priority': '10', 'content-type': 'application/json',
    },
  });
  if (response.ok) return 'sent';
  let reason = '';
  try { reason = (await response.json())?.reason ?? ''; } catch { /* Reason is optional. */ }
  if (response.status === 410 || reason === 'Unregistered' || reason === 'BadDeviceToken') {
    await env.DB.prepare('DELETE FROM push_devices WHERE token = ?').bind(device.token).run();
    return 'removed';
  }
  console.error('APNs rejected a notification', response.status, String(reason).slice(0, 64));
  return 'failed';
}

// Returns a status string; it never throws. Callers pass an event that is
// already de-duplicated (a first-time insert), so retries do not push twice.
export async function notifyPush(env, { kind, id }, { fetcher = fetch, now = Date.now() } = {}) {
  const creds = credentials(env);
  const message = MESSAGES[kind];
  if (!creds || !message || !env.DB) return 'skipped';
  try {
    const devices = await env.DB.prepare('SELECT token, platform, environment FROM push_devices').all();
    if (!devices.results?.length) return 'none';
    const jwt = await providerToken(creds, now);
    const payload = { aps: { alert: { title: message[0], body: message[1] }, sound: 'default', 'thread-id': kind }, kind, ...(id ? { id } : {}) };
    const body = JSON.stringify(payload);
    const results = await Promise.allSettled(devices.results.map(device => sendOne(env, device, jwt, body, fetcher)));
    return results.some(r => r.status === 'fulfilled' && r.value === 'sent') ? 'sent' : 'failed';
  } catch { return 'failed'; }
}

async function readJson(request) {
  if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') throw Error('type');
  const text = await request.text();
  if (text.length > 1024) throw Error('size');
  return JSON.parse(text);
}

// POST /api/push/devices {token, platform, environment}; DELETE /api/push/devices/:token.
// The caller has already verified the Access assertion.
export async function handlePushDevices(request, env, actor, token) {
  if (env.VOICE_OWNER_SUBJECT && actor !== env.VOICE_OWNER_SUBJECT) return reply({ error: 'Not found' }, 404);
  if (!env.DB) return reply({ error: 'Storage unavailable' }, 503);
  try {
    if (request.method === 'DELETE' && token !== undefined) {
      const value = token.toLowerCase();
      if (!TOKEN.test(value)) return reply({ error: 'Invalid token' }, 400);
      await env.DB.prepare('DELETE FROM push_devices WHERE token = ?').bind(value).run();
      return reply({ ok: true });
    }
    if (request.method !== 'POST' || token !== undefined) return reply({ error: 'Method not allowed' }, 405);
    let body;
    try { body = await readJson(request); } catch { return reply({ error: 'Invalid request' }, 400); }
    const value = typeof body?.token === 'string' ? body.token.toLowerCase() : '';
    if (!TOKEN.test(value) || !['ios', 'macos'].includes(body.platform) || !['sandbox', 'production'].includes(body.environment)) return reply({ error: 'Invalid device' }, 400);
    await env.DB.prepare("INSERT INTO push_devices (token, platform, environment) VALUES (?, ?, ?) ON CONFLICT(token) DO UPDATE SET platform = excluded.platform, environment = excluded.environment, last_seen_at = datetime('now')")
      .bind(value, body.platform, body.environment).run();
    return reply({ ok: true });
  } catch { return reply({ error: 'Storage unavailable' }, 503); }
}
