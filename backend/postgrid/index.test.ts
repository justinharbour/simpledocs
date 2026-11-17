import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  rejectUnauthenticatedWebhook,
  normalizeMailStatus,
  validateMailingClass,
  validateProofApprovalShape,
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

  it("validates only approval shape and rejects empty or malformed/fabricated fields", () => {
    const valid = {
      deliveryId: "delivery-1", revision: 2, inputHash: "a".repeat(64),
      proofId: "proof-1", proofHash: "b".repeat(64), actorId: "actor-1",
      approvedAt: "2026-01-01T00:00:00Z",
    };
    assert.equal(validateProofApprovalShape(valid), true);
    for (const invalid of [
      null,
      {},
      { ...valid, deliveryId: "" },
      { ...valid, proofId: " " },
      { ...valid, actorId: "" },
      { ...valid, revision: 0 },
      { ...valid, revision: 1.5 },
      { ...valid, inputHash: "inputs-hash" },
      { ...valid, proofHash: "proof-hash" },
      { ...valid, approvedAt: "not-a-date" },
    ]) assert.equal(validateProofApprovalShape(invalid), false);
    // Even a valid shape is attacker-fabricable and conveys no authorization.
    assert.equal(validateProofApprovalShape({ ...valid, actorId: "attacker-claimed-actor" }), true);
  });

  it("always rejects webhook events until provider-specific authentication is implemented", () => {
    assert.throws(() => rejectUnauthenticatedWebhook(), /not implemented/);
  });
});
