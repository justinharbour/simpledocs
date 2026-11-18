-- SMS conversations. Threads are derived with GROUP BY peer; there is no thread table.
-- provider_id is the Telnyx message id, so a redelivered webhook cannot create a second row.
CREATE TABLE sms_messages (
  id TEXT PRIMARY KEY,
  provider_id TEXT UNIQUE,
  direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  peer TEXT NOT NULL,
  body TEXT NOT NULL,
  status TEXT NOT NULL,
  error_code TEXT,
  error_text TEXT,
  created_at TEXT NOT NULL,
  status_at TEXT NOT NULL,
  read_at TEXT
);
CREATE INDEX sms_peer_created ON sms_messages(peer, created_at DESC);
