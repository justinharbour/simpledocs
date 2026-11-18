-- An attempt is claimed before any external email call. One email per envelope.
CREATE TABLE email_attempts (
 transmission_id TEXT PRIMARY KEY REFERENCES transmissions(id),
 actor_id TEXT NOT NULL,
 recipient TEXT NOT NULL,
 status TEXT NOT NULL,
 error TEXT,
 delivery_id TEXT,
 created_at INTEGER NOT NULL
);
CREATE INDEX email_attempts_actor ON email_attempts(actor_id, transmission_id);
