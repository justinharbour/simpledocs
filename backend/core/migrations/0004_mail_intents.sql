-- One irreversible claim per draft, including after an uncertain outcome.
CREATE TABLE mail_intents (
  draft_id TEXT PRIMARY KEY,
  actor_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  review_hash TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('submitting', 'accepted', 'unknown')),
  provider_id TEXT,
  confirmed_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
