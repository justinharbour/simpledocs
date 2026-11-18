// Voicemail greeting and voice live in the settings table so they can change
// without a deploy. The VOICEMAIL_GREETING variable stays as a fallback.
export const DEFAULT_VOICE = 'Telnyx.KokoroTTS.af';
export const DEFAULT_SERVICE_LEVEL = 'basic';
export const MAX_GREETING = 1000;
const VOICE = /^[A-Za-z0-9]+\.[A-Za-z0-9]+\.[A-Za-z0-9_-]+$/;
const KEYS = { greeting: 'voicemail_greeting', voice: 'voicemail_voice', service_level: 'voicemail_service_level' };
const headers = { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' };
const reply = (body, status = 200) => Response.json(body, { status, headers });

export const isLegacyVoice = voice => voice === 'female' || voice === 'male';
const validGreeting = value => typeof value === 'string' && value.trim().length > 0 && value.trim().length <= MAX_GREETING;
const validVoice = value => typeof value === 'string' && value.length <= 100 && (isLegacyVoice(value) || VOICE.test(value));
const validLevel = value => value === 'basic' || value === 'premium';

const envGreeting = env => {
  const value = typeof env.VOICEMAIL_GREETING === 'string' ? env.VOICEMAIL_GREETING.trim() : '';
  return validGreeting(value) ? value : '';
};
export const fallbackConfig = env => ({ greeting: envGreeting(env), voice: DEFAULT_VOICE, service_level: DEFAULT_SERVICE_LEVEL });

// Effective values: stored setting, then the environment greeting, then the default voice.
export async function voicemailConfig(env) {
  const rows = await env.DB.prepare("SELECT key, value FROM settings WHERE key IN ('voicemail_greeting', 'voicemail_voice', 'voicemail_service_level')").all();
  const stored = Object.fromEntries((rows.results ?? []).map(r => [r.key, r.value]));
  const fromEnv = envGreeting(env);
  const greeting = validGreeting(stored[KEYS.greeting]) ? stored[KEYS.greeting].trim() : validGreeting(fromEnv) ? fromEnv : '';
  return {
    greeting,
    voice: validVoice(stored[KEYS.voice]) ? stored[KEYS.voice] : DEFAULT_VOICE,
    service_level: validLevel(stored[KEYS.service_level]) ? stored[KEYS.service_level] : DEFAULT_SERVICE_LEVEL,
  };
}

export async function handleVoicemailSettings(request, env) {
  if (!env.DB) return reply({ error: 'Storage unavailable' }, 503);
  try {
    if (request.method === 'GET') return reply(await voicemailConfig(env));
    if (request.method !== 'PUT') return reply({ error: 'Method not allowed' }, 405);
    if (request.headers.get('origin') !== new URL(request.url).origin) return reply({ error: 'Invalid origin' }, 403);
    let body;
    try { body = await request.json(); } catch { return reply({ error: 'Invalid JSON' }, 400); }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return reply({ error: 'Invalid JSON' }, 400);
    const writes = [];
    if (body.greeting !== undefined) {
      if (!validGreeting(body.greeting)) return reply({ error: `Enter a greeting of 1 to ${MAX_GREETING} characters` }, 400);
      writes.push([KEYS.greeting, body.greeting.trim()]);
    }
    if (body.voice !== undefined) {
      if (!validVoice(body.voice)) return reply({ error: 'Voice must be female, male, or a Provider.Model.VoiceId such as Telnyx.KokoroTTS.af' }, 400);
      writes.push([KEYS.voice, body.voice]);
    }
    if (body.service_level !== undefined) {
      if (!validLevel(body.service_level)) return reply({ error: 'Service level must be basic or premium' }, 400);
      writes.push([KEYS.service_level, body.service_level]);
    }
    const now = new Date().toISOString();
    for (const [key, value] of writes) {
      await env.DB.prepare('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at').bind(key, value, now).run();
    }
    return reply(await voicemailConfig(env));
  } catch { return reply({ error: 'Settings unavailable' }, 503); }
}
