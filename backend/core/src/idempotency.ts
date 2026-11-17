import { digest, opaqueId, revision, utcTimestamp } from './validation.ts';
/** Minimal D1-compatible interface; bind parameters, never interpolate client input. */
export interface D1Statement {
  bind(...values: unknown[]): D1Statement;
  first<T>(): Promise<T | null>;
  run(): Promise<unknown>;
}
export interface D1DatabaseLike { prepare(sql: string): D1Statement }
export interface Intent {
  actorId: string; operation: string; deliveryId: string; keyHash: string;
  requestHash: string; revision: number; createdAt: string;
}
type Stored = { request_hash: string; revision: number; result_json: string | null };
export type Reservation = { kind: 'reserved' } | { kind: 'replay'; result: string | null } | { kind: 'conflict' };
/**
 * Call only after authorization and capability checks. Hash a high-entropy client key
 * and a versioned canonical request externally; never persist raw keys. Retain intents
 * until reconciliation/retention policy exists. This does not make provider sends atomic.
 */
export async function reserveIntent(db: D1DatabaseLike, intent: Intent): Promise<Reservation> {
  const actor = opaqueId(intent.actorId), operation = opaqueId(intent.operation), delivery = opaqueId(intent.deliveryId);
  const key = digest(intent.keyHash), hash = digest(intent.requestHash), rev = revision(intent.revision), created = utcTimestamp(intent.createdAt);
  const inserted = await db.prepare(`INSERT INTO submission_intents (actor_id, operation, delivery_id, idempotency_key_hash, request_hash, revision, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING RETURNING request_hash`).bind(actor, operation, delivery, key, hash, rev, created).first<{request_hash: string}>();
  if (inserted) return { kind: 'reserved' };
  const existing = await db.prepare(`SELECT request_hash, revision, result_json FROM submission_intents
    WHERE actor_id = ? AND operation = ? AND delivery_id = ? AND idempotency_key_hash = ?`).bind(actor, operation, delivery, key).first<Stored>();
  if (!existing || existing.request_hash !== hash || existing.revision !== rev) return { kind: 'conflict' };
  return { kind: 'replay', result: existing.result_json };
}
