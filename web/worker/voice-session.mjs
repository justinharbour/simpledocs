const json = (value, status = 200) => Response.json(value, { status, headers: { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' } });
const E164 = /^\+[1-9]\d{1,14}$/;

// Single configured Access subject and credential; never accept a credential ID
// or caller ID from the browser. Issued provider tokens are bearer credentials.
export async function handleVoiceSession(request, env, actor, fetcher = fetch) {
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  if (request.headers.get('origin') !== new URL(request.url).origin) return json({ error: 'Invalid origin' }, 403);
  if (env.VOICE_WEBRTC_ENABLED !== 'true' || (env.VOICE_OWNER_SUBJECT && actor !== env.VOICE_OWNER_SUBJECT) ||
      !/^[a-zA-Z0-9_-]{1,128}$/.test(env.TELNYX_WEBRTC_CREDENTIAL_ID ?? '') ||
      !E164.test(env.TELNYX_VOICE_FROM ?? '') || typeof env.TELNYX_API_TOKEN !== 'string' || !env.TELNYX_API_TOKEN.trim()) {
    return json({ error: 'Softphone unavailable' }, 503);
  }
  try {
    const response = await fetcher(`https://api.telnyx.com/v2/telephony_credentials/${env.TELNYX_WEBRTC_CREDENTIAL_ID}/token`, {
      method: 'POST', redirect: 'manual', headers: { Authorization: `Bearer ${env.TELNYX_API_TOKEN}`, Accept: 'text/plain' },
    });
    if (response.status !== 201) return json({ error: 'Softphone unavailable' }, 502);
    const text = await response.text();
    if (text.length > 8192 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(text)) return json({ error: 'Softphone unavailable' }, 502);
    return json({ loginToken: text, callerNumber: env.TELNYX_VOICE_FROM });
  } catch { return json({ error: 'Softphone unavailable' }, 502); }
}
