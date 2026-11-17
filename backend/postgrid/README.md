# PostGrid integration foundation

This is a pure TypeScript domain boundary, not a working provider client. It has no network dependency, credentials, or live-send implementation.

- `validateMailingClass` accepts a deliberately narrow destination/class matrix. Confirm exact values and combinations against the intended PostGrid account, product (letter/postcard), destination, and current API before expanding it. Unknown combinations are rejected.
- `normalizeMailStatus` preserves raw values and maps only known statuses. Tracking data is optional and is never itself evidence of delivery or a signed return receipt.
- `validateProofApprovalShape` validates only syntactic shape (including nonempty identifiers, positive integer revision, SHA-256 hex digests and UTC timestamp). It does **not** establish that any value is genuine, immutable, or authorized; all such values can be fabricated by a caller. It must never authorize sending. A future send path requires a trusted durable approval record, authenticated actor provenance, a provider-generated proof, and an atomic check that the approval still matches the current immutable delivery revision. None exists here; live send is unavailable.
- `rejectUnauthenticatedWebhook` always rejects. There is deliberately no injectable verifier because a caller-provided callback is not proof of provider authentication. The public feasibility review does not verify PostGrid's webhook authentication semantics. Do not create/enable a production webhook endpoint until a provider-specific verifier based on verified documentation is implemented and tested, with durable inbox acceptance after verification.

Proof hashing/canonical serialization, trusted durable approval and atomic dispatch authorization, account and product capability discovery, API request/response schemas, webhook signature/replay rules, durable idempotency, event persistence and provider reconciliation are integration gaps. The current contract also requires testing product-specific status transitions and classes before enabling any operation. Tests use synthetic data only; no network calls or secrets.

Run tests on Node.js 22+: `node --experimental-strip-types --test backend/postgrid/index.test.ts`.
