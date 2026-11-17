-- No signed media URLs, webhook bodies, caller numbers or document content in D1.
CREATE TABLE inbound_fax_events (
  event_id TEXT PRIMARY KEY,
  fax_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  received_at TEXT NOT NULL,
  object_key TEXT
);
