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
  // The predicate and claim are one SQLite write, so distinct IDs racing for
  // the same actor cannot both cross the irreversible provider boundary.
  const claimed = await db.prepare("UPDATE fax_intents SET status = 'submitting', updated_at = ? WHERE id = ? AND actor_id = ? AND status = 'prepared' AND NOT EXISTS (SELECT 1 FROM fax_intents WHERE actor_id = ? AND status IN ('submitting', 'unknown', 'accepted'))")
    .bind(now, id, actor, actor).run();
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

// Called only after authenticating a Telnyx event. The provider ID must match
// the stored accepted submission; never associate an event using an untrusted
// destination or actor. Repeated and out-of-order events are harmless. A
// conflict between terminal statuses requires operator reconciliation.
export async function applyFaxDeliveryEvent(db, { providerId, status }) {
  if (!db || typeof providerId !== 'string' || !providerId.trim() || providerId.length > 256 || !['delivered', 'failed'].includes(status)) {
    throw new TypeError('Invalid delivery event');
  }
  const result = await db.prepare("UPDATE fax_intents SET status = ?, updated_at = ? WHERE provider_id = ? AND status = 'accepted'")
    .bind(status, new Date().toISOString(), providerId).run();
  if (result.meta.changes === 1) return 'updated';
  const existing = await db.prepare('SELECT status FROM fax_intents WHERE provider_id = ?').bind(providerId).first();
  if (!existing) return 'unmatched';
  if (existing.status === status) return 'duplicate';
  return 'conflict';
}
