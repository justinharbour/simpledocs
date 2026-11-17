# PostGrid integration foundation

This is a pure TypeScript domain boundary, not a working provider client. It has no network dependency, credentials, or live-send implementation.

- `validateMailingClass` accepts a deliberately narrow destination/class matrix. Confirm exact values and combinations against the intended PostGrid account, product (letter/postcard), destination, and current API before expanding it. Unknown combinations are rejected.
- `normalizeMailStatus` preserves raw values and maps only known statuses. Tracking data is optional and is never itself evidence of delivery or a signed return receipt.
- `assertLiveReleaseAllowed` requires live enablement, a verified provider-side proof-release capability, a provider-generated proof, and an explicit approval bound to delivery, immutable revision, input digest, proof identity and proof digest. It must execute at dispatch after an atomic read/check; this function is not a substitute for durable transaction or hash canonicalization. The currently reviewed PostGrid preview does not establish a safe hold/release flow, so `proofReleaseVerified` must remain false and live sending must not be implemented until verified.
- `authenticateWebhook` refuses events if no provider-authentication verifier is supplied, or if it rejects. The public feasibility review does not verify PostGrid's signature semantics. Do not acknowledge an event until authentication succeeds and a durable inbox write succeeds. No placeholder verifier may be used in production.

Proof hashing/canonical serialization, account and product capability discovery, API request/response schemas, webhook signature/replay rules, durable idempotency, event persistence and provider reconciliation are integration gaps. The current contract also requires testing product-specific status transitions and classes before enabling any operation. Tests use synthetic data only; no network calls or secrets.

Run tests on Node.js 22+: `node --experimental-strip-types --test backend/postgrid/index.test.ts`.
