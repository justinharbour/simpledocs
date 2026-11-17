CREATE TABLE IF NOT EXISTS voice_events (
  event_id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  call_control_id TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  received_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS voice_recordings (
  recording_id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES voice_events(event_id),
  call_control_id TEXT NOT NULL,
  object_key TEXT NOT NULL UNIQUE,
  content_type TEXT NOT NULL,
  archived_at TEXT NOT NULL DEFAULT (datetime('now'))
);
