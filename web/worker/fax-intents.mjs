import { submitFax } from './telnyx-fax.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const E164 = /^\+[1-9]\d{1,14}$/;

// Internal functions only: the caller must validate ownership of the media and
// collect explicit paid-send confirmation. No HTTP route uses these yet.
export async function prepareFax(db, { id, actor, destination, mediaName }) {
  if (!db || !UUID.test(id ?? '') || typeof actor !== 'string' || !actor.trim() ||
      !E164.test(destination ?? '') || typeof mediaName !== 'string' || !mediaName.trim() || mediaName.length > 255) {
    throw new TypeError('Invalid fax intent');
  }
  const now = new Date().toISOString();
  const result = await db.prepare('INSERT INTO fax_intents (id, actor_id, destination, media_name, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING')
    .bind(id, actor, destination, mediaName, 'prepared', now, now).run();
  return result.meta.changes === 1;
}

export async function sendPreparedFax(db, { id, actor, config, confirmed }, submit = submitFax) {
  if (confirmed !== true || config?.enabled !== true || !db || !UUID.test(id ?? '') || typeof actor !== 'string' || !actor.trim()) {
    return { outcome: 'unavailable' };
  }
  // Validate operator configuration before consuming the irreversible claim.
  if (typeof config.token !== 'string' || !config.token.trim() || typeof config.connectionId !== 'string' || !config.connectionId.trim() || !E164.test(config.from ?? '')) {
    return { outcome: 'unavailable' };
  }
  const now = new Date().toISOString();
  const claimed = await db.prepare("UPDATE fax_intents SET status = 'submitting', updated_at = ? WHERE id = ? AND actor_id = ? AND status = 'prepared'")
    .bind(now, id, actor).run();
  if (claimed.meta.changes !== 1) return { outcome: 'not_claimed' };
  const row = await db.prepare('SELECT destination, media_name FROM fax_intents WHERE id = ? AND actor_id = ?').bind(id, actor).first();
  let result = { outcome: 'unknown' };
  try {
    result = await submit({ token: config.token, connectionId: config.connectionId, from: config.from, to: row.destination, mediaName: row.media_name, intentId: id });
  } catch {
    // Provider invocation or response handling may have failed after sending.
  }
  if (!['accepted', 'rejected', 'unknown'].includes(result?.outcome) ||
      (result.outcome === 'accepted' && (typeof result.providerId !== 'string' || !result.providerId.trim()))) result = { outcome: 'unknown' };
  await db.prepare("UPDATE fax_intents SET status = ?, provider_id = ?, updated_at = ? WHERE id = ? AND actor_id = ? AND status = 'submitting'")
    .bind(result.outcome, result.providerId ?? null, new Date().toISOString(), id, actor).run();
  return result;
}
