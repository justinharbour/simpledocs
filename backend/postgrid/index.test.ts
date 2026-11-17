import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  assertLiveReleaseAllowed,
  authenticateWebhook,
  normalizeMailStatus,
  validateMailingClass,
} from "./index.ts";

describe("PostGrid foundation", () => {
  it("accepts only configured destination/class combinations", () => {
    assert.equal(validateMailingClass("us", "first_class"), "first_class");
    assert.throws(() => validateMailingClass("FR", "first_class"), /Unsupported/);
    assert.throws(() => validateMailingClass("US", "uk_first_class"), /Unsupported/);
  });

  it("preserves unknown statuses and never treats tracking as delivery proof", () => {
    const future = normalizeMailStatus("some_future_status", { trackingNumber: "123" });
    assert.equal(future.normalized, "unknown");
    assert.equal(future.raw, "some_future_status");
    assert.equal(future.tracking.deliveryEvidence, "none");
    assert.equal(normalizeMailStatus("delivered").tracking.deliveryEvidence, "provider_status");
  });

  it("blocks release unless the verified gate and exact immutable approval match", () => {
    const base = {
      liveEnabled: true,
      proofReleaseVerified: false,
      providerProofId: "proof-1",
      currentDeliveryId: "delivery-1",
      currentRevision: 2,
      currentInputHash: "inputs-hash",
      currentProofHash: "proof-hash",
      approval: {
        deliveryId: "delivery-1", revision: 2, inputHash: "inputs-hash",
        proofId: "proof-1", proofHash: "proof-hash", actorId: "actor-1", approvedAt: "2026-01-01T00:00:00Z",
      },
    } as const;
    assert.throws(() => assertLiveReleaseAllowed(base), /unverified/);
    assert.throws(() => assertLiveReleaseAllowed({ ...base, proofReleaseVerified: true, currentRevision: 3 }), /does not match/);
    assert.doesNotThrow(() => assertLiveReleaseAllowed({ ...base, proofReleaseVerified: true }));
  });

  it("rejects webhook events without verified authentication", async () => {
    await assert.rejects(authenticateWebhook(null, new Uint8Array([1]), {}), /unverified/);
    await assert.rejects(authenticateWebhook({ verify: async () => false }, new Uint8Array([1]), {}), /Invalid/);
    await assert.doesNotReject(authenticateWebhook({ verify: async () => true }, new Uint8Array([1]), {}));
  });
});
