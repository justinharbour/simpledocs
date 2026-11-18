// Availability is a routing policy, not a device-presence signal. A policy
// allowing calls to ring still requires a connected softphone.
export const DEFAULT_AVAILABILITY = Object.freeze({ mode: 'online', timezone: 'UTC', intervals: [] });

const time = value => typeof value === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
const minutes = value => Number(value.slice(0, 2)) * 60 + Number(value.slice(3));

export function validAvailability(value) {
  if (!value || typeof value !== 'object' || !['online', 'offline', 'schedule'].includes(value.mode) ||
      typeof value.timezone !== 'string' || value.timezone.length > 100 || !Array.isArray(value.intervals) || value.intervals.length > 100) return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: value.timezone }).format(0); } catch { return false; }
  return value.intervals.every(i => i && Number.isInteger(i.day) && i.day >= 0 && i.day <= 6 && time(i.start) && time(i.end) && i.start !== i.end);
}

// day is Sunday=0. Overnight intervals end on the following local day.
// Intl converts the instant into local civil time, including DST transitions.
export function availabilityOnline(policy, instant = Date.now()) {
  if (!validAvailability(policy)) return false;
  if (policy.mode !== 'schedule') return policy.mode === 'online';
  const fields = new Intl.DateTimeFormat('en-US', { timeZone: policy.timezone, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(instant);
  const parts = Object.fromEntries(fields.map(p => [p.type, p.value]));
  const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday);
  const current = Number(parts.hour) * 60 + Number(parts.minute);
  return policy.intervals.some(i => {
    const start = minutes(i.start), end = minutes(i.end);
    return start < end ? i.day === day && current >= start && current < end :
      (i.day === day && current >= start) || ((i.day + 1) % 7 === day && current < end);
  });
}

export async function loadAvailability(db) {
  const row = await db.prepare('SELECT value FROM settings WHERE key = ?').bind('voice_availability').first();
  if (!row) return DEFAULT_AVAILABILITY;
  try { const value = JSON.parse(row.value); return validAvailability(value) ? value : null; } catch { return null; }
}

export async function handleAvailability(request, env) {
  const headers = { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' };
  const reply = (body, status = 200) => Response.json(body, { status, headers });
  if (!env.DB) return reply({ error: 'Storage unavailable' }, 503);
  try {
    if (request.method === 'GET') {
      const policy = await loadAvailability(env.DB);
      return policy ? reply(policy) : reply({ error: 'Invalid stored availability' }, 503);
    }
    if (request.method !== 'PUT') return reply({ error: 'Method not allowed' }, 405);
    if (request.headers.get('origin') !== new URL(request.url).origin) return reply({ error: 'Invalid origin' }, 403);
    let value;
    try { value = await request.json(); } catch { return reply({ error: 'Invalid JSON' }, 400); }
    if (!validAvailability(value)) return reply({ error: 'Invalid availability' }, 400);
    const policy = { mode: value.mode, timezone: value.timezone, intervals: value.intervals.map(({ day, start, end }) => ({ day, start, end })) };
    await env.DB.prepare('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at').bind('voice_availability', JSON.stringify(policy), new Date().toISOString()).run();
    return reply(policy);
  } catch { return reply({ error: 'Availability unavailable' }, 503); }
}
