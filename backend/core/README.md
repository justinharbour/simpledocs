# Core backend foundation (not deployed)

A standalone, Worker-compatible TypeScript foundation based on proposed PR #2 contracts. It is not an API, Worker entrypoint, production configuration or a completed security implementation. No live operations are enabled here.

## Verify

With Node 22.6+ and Python 3 with SQLite, run `npm test` in this directory. Install development dependencies locally and run `npm run typecheck` for TypeScript checking. Tests do not contact Cloudflare or providers. `migrations/0001_core.sql` targets D1's SQLite model; local SQLite tests are not a substitute for D1 integration tests or a deployment migration plan.

## Integration requirements and limitations

- Supply a reviewed Cloudflare Access JWT adapter verifying configured issuer, audience, signature, expiry and trusted individual identity, with key rotation and negative tests, plus an independent actor/resource authorizer. Without both, access fails closed. No verifier or roles are implemented. Wire mutation origin/CSRF checks for cookie-based sessions; native authentication remains unresolved. Webhooks must use separate provider verification, not this Access boundary.
- Flags require trusted server configuration, verified account capabilities and rechecking at dispatch. Their default is off; there is no administration, audit wiring or provider operation here.
- D1 tables are an initial schema, not a complete repository. Approval/proof invariants and immutable send-relevant revision data need atomic implementation. SQL constraints alone do not implement approval, dispatch, validation or delivery transitions. Hash canonicalization, sizes and retention remain undecided. Document revision update is prohibited; deletion and object immutability require storage policy and authorization.
- `reserveIntent` atomically reserves a key and prevents another key on the same delivery revision. Callers must validate high entropy, securely hash keys and canonical requests, and atomically coordinate authorization, current revision, approval, flag checks and submission state with reservation before any side effect. This helper alone does not do that. Results and reconciliation need a safe implementation; no automated retry on an ambiguous provider outcome. Local deduplication does not guarantee exactly-once external sends. Records intentionally have no expiry pending a retention decision.
- Private object interfaces have no R2 binding or write/upload flow. Configure private storage and authorize every operation. Reads force downloads and never disclose object references. Rate limiting, size limits, lifecycle, backup and recovery remain unimplemented.
- No provider adapters, webhook verification, event processing, queue, audit integration, routing, secrets or infrastructure are included. Do not use for production until these gaps and the proposed contracts are reviewed and verified.
