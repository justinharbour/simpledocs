-- Call history, recording metadata, sender settings and unified outgoing
-- transmissions (envelopes) with one delivery row per channel and recipient.
-- New table names are a single word, matching the project naming standard.
ALTER TABLE voice_recordings ADD COLUMN direction TEXT;
ALTER TABLE voice_recordings ADD COLUMN from_number TEXT;
ALTER TABLE voice_recordings ADD COLUMN to_number TEXT;
ALTER TABLE voice_recordings ADD COLUMN duration_secs INTEGER;
ALTER TABLE voice_recordings ADD COLUMN heard_at TEXT;

CREATE TABLE calls (
  call_control_id TEXT PRIMARY KEY,
  direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  from_number TEXT,
  to_number TEXT,
  started_at TEXT NOT NULL,
  answered_at TEXT,
  ended_at TEXT,
  duration_secs INTEGER,
  hangup_cause TEXT,
  outcome TEXT NOT NULL DEFAULT 'ringing',
  updated_at TEXT NOT NULL
);
CREATE INDEX calls_started ON calls(started_at DESC);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- The source PDF lives in R2 (FILES) under outbound/<id>/document.pdf.
CREATE TABLE transmissions (
  id TEXT PRIMARY KEY,
  actor_id TEXT NOT NULL,
  title TEXT NOT NULL,
  source_key TEXT NOT NULL,
  page_count INTEGER NOT NULL CHECK (page_count > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX transmissions_actor_created ON transmissions(actor_id, created_at DESC);

-- id is the fax_intents id (fax) or the mail_drafts id (mail). status is the
-- Simpledocs view; provider_status is what the provider last reported.
-- 'accepted' means a provider took the job, never that it was delivered.
-- 'completed' is PostGrid's own status for mail and is not proof of delivery.
CREATE TABLE dispatches (
  id TEXT PRIMARY KEY,
  transmission_id TEXT NOT NULL REFERENCES transmissions(id),
  channel TEXT NOT NULL CHECK (channel IN ('fax', 'mail')),
  recipient TEXT NOT NULL,
  options_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('awaiting_approval', 'queued', 'submitting', 'accepted', 'delivered', 'completed', 'failed', 'unknown')),
  provider_id TEXT,
  provider_status TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  submitted_at TEXT,
  finished_at TEXT
);
CREATE INDEX dispatches_transmission ON dispatches(transmission_id);
CREATE INDEX dispatches_open ON dispatches(status, updated_at);

-- Append-only per-channel status history shown as the timeline.
CREATE TABLE timeline (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  delivery_id TEXT NOT NULL REFERENCES dispatches(id),
  at TEXT NOT NULL,
  status TEXT NOT NULL,
  detail TEXT
);
CREATE INDEX timeline_delivery ON timeline(delivery_id, id);
