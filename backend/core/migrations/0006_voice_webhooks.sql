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
  kind TEXT NOT NULL DEFAULT 'recording' CHECK (kind IN ('recording', 'voicemail')),
  archived_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- A dedicated incoming call leg is claimed before any provider command.
CREATE TABLE IF NOT EXISTS voicemail_calls (
  call_control_id TEXT PRIMARY KEY,
  marker TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS voicemail_commands (
  call_control_id TEXT NOT NULL REFERENCES voicemail_calls(call_control_id),
  action TEXT NOT NULL CHECK (action IN ('answer', 'speak', 'record_start')),
  command_id TEXT NOT NULL UNIQUE,
  outcome TEXT NOT NULL CHECK (outcome IN ('claimed', 'accepted', 'unknown')),
  PRIMARY KEY (call_control_id, action)
);
