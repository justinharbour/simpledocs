PRAGMA foreign_keys = ON;
CREATE TABLE document_revisions (
  id TEXT PRIMARY KEY, document_id TEXT NOT NULL, content_hash TEXT NOT NULL,
  object_ref TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TRIGGER document_revision_immutable BEFORE UPDATE ON document_revisions BEGIN
  SELECT RAISE(ABORT, 'document revision immutable');
END;
CREATE TABLE jobs (id TEXT PRIMARY KEY, created_by TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE deliveries (
  id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES jobs(id),
  channel TEXT NOT NULL CHECK (channel IN ('fax', 'mail')),
  revision INTEGER NOT NULL CHECK (revision > 0),
  state TEXT NOT NULL CHECK (state IN ('draft','awaiting_proof','awaiting_approval','ready','queued','submitting','submitted','in_progress','delivered','failed','cancelled','unknown')),
  provider_ref TEXT, raw_provider_status TEXT, updated_at TEXT NOT NULL
);
CREATE INDEX deliveries_job ON deliveries(job_id);
-- An intent is retained until a reviewed retention/reconciliation policy exists.
-- The second unique constraint forbids competing keys for the same delivery revision.
CREATE TABLE submission_intents (
  actor_id TEXT NOT NULL, operation TEXT NOT NULL, delivery_id TEXT NOT NULL REFERENCES deliveries(id),
  idempotency_key_hash TEXT NOT NULL, request_hash TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0), created_at TEXT NOT NULL,
  result_json TEXT,
  PRIMARY KEY (actor_id, operation, delivery_id, idempotency_key_hash),
  UNIQUE (delivery_id, revision)
);
CREATE TABLE proofs (
  id TEXT PRIMARY KEY, delivery_id TEXT NOT NULL REFERENCES deliveries(id), revision INTEGER NOT NULL,
  input_hash TEXT NOT NULL, proof_hash TEXT NOT NULL, object_ref TEXT NOT NULL, source TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE approvals (
  delivery_id TEXT NOT NULL REFERENCES deliveries(id), revision INTEGER NOT NULL, proof_id TEXT NOT NULL REFERENCES proofs(id),
  input_hash TEXT NOT NULL, proof_hash TEXT NOT NULL, actor_id TEXT NOT NULL, approved_at TEXT NOT NULL,
  PRIMARY KEY (delivery_id, revision)
);
CREATE TABLE provider_events (
  provider TEXT NOT NULL, event_id TEXT NOT NULL, received_at TEXT NOT NULL, provider_occurred_at TEXT,
  verification TEXT NOT NULL, processing_state TEXT NOT NULL, PRIMARY KEY (provider, event_id)
);
CREATE TABLE audit_events (
  id TEXT PRIMARY KEY, actor TEXT NOT NULL, action TEXT NOT NULL, target TEXT NOT NULL,
  outcome TEXT NOT NULL, time TEXT NOT NULL, request_id TEXT NOT NULL
);
