/** Validation for untrusted input. These are intentionally bounded draft shapes, not a published API. */
export class ValidationError extends Error {}
export type Channel = 'fax' | 'mail';
export type DeliveryState = 'draft' | 'awaiting_proof' | 'awaiting_approval' | 'ready' | 'queued' | 'submitting' | 'submitted' | 'in_progress' | 'delivered' | 'failed' | 'cancelled' | 'unknown';
const states = new Set<DeliveryState>(['draft', 'awaiting_proof', 'awaiting_approval', 'ready', 'queued', 'submitting', 'submitted', 'in_progress', 'delivered', 'failed', 'cancelled', 'unknown']);
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ValidationError('Expected object');
  return value as Record<string, unknown>;
}
export function opaqueId(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) throw new ValidationError('Invalid ID');
  return value;
}
export function digest(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw new ValidationError('Expected lowercase SHA-256 digest');
  return value;
}
export function revision(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new ValidationError('Invalid revision');
  return value as number;
}
export function channel(value: unknown): Channel {
  if (value !== 'fax' && value !== 'mail') throw new ValidationError('Invalid channel');
  return value;
}
export function deliveryState(value: unknown): DeliveryState {
  if (typeof value !== 'string' || !states.has(value as DeliveryState)) throw new ValidationError('Invalid delivery state');
  return value as DeliveryState;
}
export function utcTimestamp(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) throw new ValidationError('Invalid UTC timestamp');
  return value;
}
export function documentRevision(value: unknown) {
  const v = object(value);
  return { id: opaqueId(v.id), documentId: opaqueId(v.documentId), contentHash: digest(v.contentHash), objectRef: opaqueId(v.objectRef), createdAt: utcTimestamp(v.createdAt) };
}
export function job(value: unknown) {
  const v = object(value);
  return { id: opaqueId(v.id), createdBy: opaqueId(v.createdBy), createdAt: utcTimestamp(v.createdAt) };
}
export function delivery(value: unknown) {
  const v = object(value);
  return { id: opaqueId(v.id), jobId: opaqueId(v.jobId), channel: channel(v.channel), revision: revision(v.revision), state: deliveryState(v.state), updatedAt: utcTimestamp(v.updatedAt) };
}
