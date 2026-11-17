import { strict as assert } from "node:assert";
import { generateKeyPairSync, sign } from "node:crypto";
import { test } from "node:test";
import { isFeatureEnabled, verifyAndParseWebhook, verifyWebhookSignature, WebhookPayloadError, WebhookVerificationError } from "./index.js";

const fax = (overrides: Record<string, unknown> = {}) => JSON.stringify({ data: { id: "evt-123", event_type: "fax.delivered", occurred_at: "2026-01-01T00:00:00Z", payload: { fax_id: "fax-456", direction: "outbound", status: "delivered", ...overrides } } });

test("feature gates fail closed", () => {
  assert.equal(isFeatureEnabled({}, "fax.outbound"), false);
  assert.equal(isFeatureEnabled({ enabled: { "fax.outbound": false } }, "fax.outbound"), false);
  assert.equal(isFeatureEnabled({ enabled: { "fax.outbound": true } }, "fax.outbound"), true);
});

test("normalizes documented fax event with typed fax ID", async () => {
  const event = await verified(fax());
  assert.deepEqual(event, {
    provider: "telnyx", eventId: "evt-123", eventType: "fax.delivered", channel: "fax", direction: "outbound", resourceId: { kind: "fax_id", value: "fax-456" },
    occurredAt: "2026-01-01T00:00:00Z", rawStatus: "delivered", status: "delivered", idempotencyKey: "telnyx:evt-123",
  });
});

test("normalizes documented incoming voice fixture and preserves typed call control ID", async () => {
  const body = JSON.stringify({ data: { id: "evt-v", event_type: "call.initiated", occurred_at: "2018-02-02T22:25:27.521992Z", payload: { call_control_id: "call-control-1", call_session_id: "session-1", direction: "incoming", state: "parked" } } });
  const event = await verified(body);
  assert.equal(event.status, "unknown");
  assert.equal(event.channel, "voice");
  assert.equal(event.direction, "inbound");
  assert.deepEqual(event.resourceId, { kind: "call_control_id", value: "call-control-1" });
});

test("voice direction may be absent on later events but session ID never substitutes for call control ID", async () => {
  const body = JSON.stringify({ data: { id: "evt-later", event_type: "call.answered", payload: { call_session_id: "session-only" } } });
  await assert.rejects(verified(body), WebhookPayloadError);
  const later = JSON.stringify({ data: { id: "evt-later", event_type: "call.answered", payload: { call_control_id: "cc-2", call_session_id: "session-2" } } });
  const event = await verified(later);
  assert.equal(event.direction, undefined);
  assert.deepEqual(event.resourceId, { kind: "call_control_id", value: "cc-2" });
});

test("fax.received is not normalized as delivery to the recipient", async () => {
  const body = JSON.stringify({ data: { id: "evt-in", event_type: "fax.received", payload: { fax_id: "fax-in-1", direction: "inbound", status: "received" } } });
  const event = await verified(body);
  assert.equal(event.status, "unknown");
});

test("authenticated intake rejects malformed, unsupported, incomplete, and unauthenticated payloads", async () => {
  await assert.rejects(verified("{"), WebhookPayloadError);
  await assert.rejects(verified(JSON.stringify({ data: { id: "x", event_type: "fax.queued", payload: {} } })), WebhookPayloadError);
  await assert.rejects(verified(JSON.stringify({ data: { id: "x", event_type: "future.event", payload: {} } })), WebhookPayloadError);
  await assert.rejects(verifyAndParseWebhook({ ...signed("{}"), signature: "" }), WebhookVerificationError);
});

test("verifies Telnyx Ed25519 signature over timestamp and exact body", async () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const rawPublic = publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("base64");
  const body = fax();
  const timestamp = "1767225600";
  const signature = sign(null, Buffer.from(`${timestamp}|${body}`), privateKey).toString("base64");
  const args = { rawBody: body, signature, timestamp, publicKey: rawPublic, now: Number(timestamp) * 1000 };
  assert.equal(await verifyWebhookSignature(args), true);
  assert.equal(await verifyWebhookSignature({ ...args, rawBody: `${body} ` }), false);
  assert.equal(await verifyWebhookSignature({ ...args, now: (Number(timestamp) + 301) * 1000 }), false);
  assert.equal(await verifyWebhookSignature({ ...args, signature: "invalid" }), false);
});

test("verified intake parses only the same signed bytes", async () => {
  const original = fax();
  const signedInput = signed(original);
  await assert.rejects(verifyAndParseWebhook({ ...signedInput, rawBody: new TextEncoder().encode(fax({ fax_id: "tampered" })) }), WebhookVerificationError);
});

async function verified(body: string) { return verifyAndParseWebhook(signed(body)); }
function signed(body: string) {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const rawPublic = publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("base64");
  const timestamp = "1767225600";
  const signature = sign(null, Buffer.from(`${timestamp}|${body}`), privateKey).toString("base64");
  return { rawBody: new TextEncoder().encode(body), signature, timestamp, publicKey: rawPublic, now: Number(timestamp) * 1000 };
}
