/** Provider-independent boundary for Telnyx event intake. No network or send operation is performed here. */

export type Feature = "fax.outbound" | "fax.inbound" | "voice.outbound" | "voice.inbound" | "voice.voicemail";
export type Channel = "fax" | "voice";
export type NormalizedStatus = "queued" | "in_progress" | "delivered" | "failed" | "unknown";

export interface TelnyxConfig {
  /** Every live capability is off unless explicitly opted in by the server operator. */
  enabled?: Partial<Record<Feature, boolean>>;
}

interface CommonEvent {
  provider: "telnyx";
  eventId: string;
  eventType: string;
  channel: Channel;
  occurredAt?: string;
  rawStatus?: string;
  status: NormalizedStatus;
  /** Stable deduplication key only. Persistence and atomic uniqueness are the caller's responsibility. */
  idempotencyKey: string;
}

export type NormalizedEvent = CommonEvent & (
  | { channel: "fax"; direction: "inbound" | "outbound"; resourceId: { kind: "fax_id"; value: string } }
  | { channel: "voice"; direction?: "inbound" | "outbound"; resourceId: { kind: "call_control_id"; value: string } }
);

export class WebhookVerificationError extends Error {
  constructor(message = "Invalid Telnyx webhook signature") {
    super(message);
    this.name = "WebhookVerificationError";
  }
}

export class WebhookPayloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebhookPayloadError";
  }
}

export function isFeatureEnabled(config: TelnyxConfig, feature: Feature): boolean {
  return config.enabled?.[feature] === true;
}

/**
 * Verify Telnyx's documented Ed25519 webhook signature.
 * `telnyx-signature-ed25519` is base64 Ed25519 signature over
 * `${telnyx-timestamp}|${exactRawRequestBody}`; public key is the configured
 * dashboard key, base64 encoded. Caller must enforce size limits and persist
 * accepted event IDs atomically before acknowledging the request.
 */
export async function verifyWebhookSignature(input: {
  rawBody: string | Uint8Array;
  signature: string | null;
  timestamp: string | null;
  publicKey: string;
  now?: number;
  toleranceSeconds?: number;
}): Promise<boolean> {
  const { signature, timestamp, publicKey } = input;
  if (!signature || !timestamp || !publicKey || !/^\d+$/.test(timestamp)) return false;
  const timestampSeconds = Number(timestamp);
  if (!Number.isSafeInteger(timestampSeconds)) return false;
  const nowSeconds = Math.floor((input.now ?? Date.now()) / 1000);
  const tolerance = input.toleranceSeconds ?? 300;
  if (!Number.isFinite(tolerance) || tolerance < 0 || Math.abs(nowSeconds - timestampSeconds) > tolerance) return false;

  try {
    const sig = decodeBase64(signature);
    const key = decodeBase64(publicKey);
    // Ed25519 SPKI DER prefix for a raw 32-byte public key.
    if (sig.length !== 64 || key.length !== 32) return false;
    const spkiPrefix = new Uint8Array([0x30,0x2a,0x30,0x05,0x06,0x03,0x2b,0x65,0x70,0x03,0x21,0x00]);
    const spki = new Uint8Array(spkiPrefix.length + key.length);
    spki.set(spkiPrefix); spki.set(key, spkiPrefix.length);
    const cryptoKey = await globalThis.crypto.subtle.importKey("spki", spki, { name: "Ed25519" }, false, ["verify"]);
    const body = typeof input.rawBody === "string" ? new TextEncoder().encode(input.rawBody) : input.rawBody;
    const message = new Uint8Array(new TextEncoder().encode(`${timestamp}|`).length + body.length);
    message.set(new TextEncoder().encode(`${timestamp}|`)); message.set(body, new TextEncoder().encode(`${timestamp}|`).length);
    return await globalThis.crypto.subtle.verify("Ed25519", cryptoKey, toArrayBuffer(sig), toArrayBuffer(message));
  } catch {
    return false;
  }
}

/** Authenticate the exact received bytes, then parse those same bytes before returning trusted normalized data. */
export async function verifyAndParseWebhook(input: {
  rawBody: Uint8Array;
  signature: string | null;
  timestamp: string | null;
  publicKey: string;
  now?: number;
  toleranceSeconds?: number;
}): Promise<NormalizedEvent> {
  const valid = await verifyWebhookSignature(input);
  if (!valid) throw new WebhookVerificationError();
  return parseVerifiedBytes(input.rawBody);
}

function parseVerifiedBytes(rawBody: Uint8Array): NormalizedEvent {
  let root: unknown;
  try { root = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(rawBody)); }
  catch { throw new WebhookPayloadError("Webhook body is not valid UTF-8 JSON"); }
  if (!isRecord(root) || !isRecord(root.data)) throw new WebhookPayloadError("Missing webhook data");
  const data = root.data;
  const payload = isRecord(data.payload) ? data.payload : data;
  const eventType = nonEmpty(data.event_type);
  const eventId = nonEmpty(data.id);
  if (!eventType || !eventId) throw new WebhookPayloadError("Missing event type or ID");

  const faxTypes = new Set(["fax.queued", "fax.media.processed", "fax.sending.started", "fax.delivered", "fax.failed", "fax.receiving.started", "fax.received"]);
  const voiceTypes = new Set(["call.initiated", "call.ringing", "call.answered", "call.hangup", "call.machine.detection.ended", "call.recording.saved"]);
  const channel: Channel = faxTypes.has(eventType) ? "fax" : voiceTypes.has(eventType) ? "voice" : (() => { throw new WebhookPayloadError("Unsupported Telnyx event type"); })();
  const rawDirection = nonEmpty(payload.direction);
  const direction = channel === "fax"
    ? rawDirection === "inbound" ? "inbound" : rawDirection === "outbound" ? "outbound" : undefined
    : rawDirection === "incoming" ? "inbound" : rawDirection === "outgoing" ? "outbound" : undefined;
  if (channel === "fax" && !direction) throw new WebhookPayloadError("Missing or invalid fax direction");
  const resourceIdValue = nonEmpty(channel === "fax" ? payload.fax_id : payload.call_control_id);
  if (!resourceIdValue) throw new WebhookPayloadError(`Missing ${channel === "fax" ? "fax_id" : "call_control_id"}`);
  const rawStatus = nonEmpty(payload.status);
  const status: NormalizedStatus = eventType.endsWith(".queued") ? "queued"
    : eventType.endsWith(".delivered") ? "delivered"
    : eventType.endsWith(".failed") ? "failed"
    : eventType.endsWith(".started") || eventType.endsWith(".answered") || eventType.endsWith(".ringing") ? "in_progress"
    : "unknown";
  const occurredAt = nonEmpty(data.occurred_at);
  return {
    provider: "telnyx", eventId, eventType, channel,
    ...(direction ? { direction } : {}),
    resourceId: channel === "fax" ? { kind: "fax_id", value: resourceIdValue } : { kind: "call_control_id", value: resourceIdValue },
    ...(occurredAt ? { occurredAt } : {}), ...(rawStatus ? { rawStatus } : {}), status,
    idempotencyKey: `telnyx:${eventId}`,
  } as NormalizedEvent;
}

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function nonEmpty(value: unknown): string | undefined { return typeof value === "string" && value.trim() ? value : undefined; }
function decodeBase64(value: string): Uint8Array {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw new Error("Malformed base64");
  const binary = atob(value);
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}
