const headers = { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' };
const json = (value, status = 200) => Response.json(value, { status, headers });

// The softphone page posts a heartbeat about every 30 s while connected; a missed beat or two means offline.
export const PRESENCE_KEY = 'phone_online';
export const PRESENCE_TTL_MS = 90 * 1000;

export async function phoneOnline(db, now = Date.now()) {
  const row = await db.prepare('SELECT value FROM settings WHERE key = ?').bind(PRESENCE_KEY).first();
  const at = Date.parse(row?.value ?? '');
  return Number.isFinite(at) && now - at >= 0 && now - at < PRESENCE_TTL_MS;
}

export async function handlePresence(request, env) {
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  if (request.headers.get('origin') !== new URL(request.url).origin) return json({ error: 'Invalid origin' }, 403);
  if (!env.DB) return json({ error: 'Storage unavailable' }, 503);
  let online = true;
  try { online = (await request.json())?.online !== false; } catch { /* a bare heartbeat means online */ }
  const now = new Date().toISOString();
  try {
    // Going offline stores a time long past, so the same key answers both cases.
    await env.DB.prepare('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at')
      .bind(PRESENCE_KEY, online ? now : new Date(0).toISOString(), now).run();
    return json({ online });
  } catch { return json({ error: 'Storage unavailable' }, 503); }
}
