-- A claimed intent is never automatically retried, including after a crash.
CREATE TABLE fax_intents (
  id TEXT PRIMARY KEY NOT NULL,
  actor_id TEXT NOT NULL,
  destination TEXT NOT NULL,
  media_name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('prepared', 'submitting', 'accepted', 'rejected', 'unknown', 'delivered', 'failed')),
  provider_id TEXT UNIQUE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX fax_intents_actor_idx ON fax_intents(actor_id, created_at);
