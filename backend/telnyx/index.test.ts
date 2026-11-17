import { strict as assert } from "node:assert";
import { generateKeyPairSync, sign } from "node:crypto";
import { test } from "node:test";
import { isFeatureEnabled, parseWebhook, verifyWebhookSignature, WebhookPayloadError } from "./index.js";

const fax = (overrides: Record<string, unknown> = {}) => JSON.stringify({ data: { id: "evt-123", event_type: "fax.delivered", occurred_at: "2026-01-01T00:00:00Z", payload: { fax_id: "fax-456", direction: "outbound", status: "delivered", ...overrides } } });

test("feature gates fail closed", () => {
  assert.equal(isFeatureEnabled({}, "fax.outbound"), false);
  assert.equal(isFeatureEnabled({ enabled: { "fax.outbound": false } }, "fax.outbound"), false);
  assert.equal(isFeatureEnabled({ enabled: { "fax.outbound": true } }, "fax.outbound"), true);
});

test("normalizes fax event with stable deduplication key and raw status", () => {
  assert.deepEqual(parseWebhook(fax()), {
    provider: "telnyx", eventId: "evt-123", eventType: "fax.delivered", channel: "fax", direction: "outbound", resourceId: "fax-456",
    occurredAt: "2026-01-01T00:00:00Z", rawStatus: "delivered", status: "delivered", idempotencyKey: "telnyx:evt-123",
  });
});

test("normalizes voice event by call control ID", () => {
  const body = JSON.stringify({ data: { id: "evt-v", event_type: "call.answered", payload: { call_control_id: "call-1", direction: "inbound" } } });
  assert.equal(parseWebhook(body).status, "in_progress");
  assert.equal(parseWebhook(body).channel, "voice");
});

test("rejects malformed, unsupported, and incomplete events", () => {
  assert.throws(() => parseWebhook("{"), WebhookPayloadError);
  assert.throws(() => parseWebhook(JSON.stringify({ data: { id: "x", event_type: "fax.queued", payload: {} } })), WebhookPayloadError);
  assert.throws(() => parseWebhook(JSON.stringify({ data: { id: "x", event_type: "future.event", payload: {} } })), WebhookPayloadError);
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
