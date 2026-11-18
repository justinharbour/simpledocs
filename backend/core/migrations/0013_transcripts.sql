ALTER TABLE voice_recordings ADD COLUMN transcript TEXT;
ALTER TABLE voice_recordings ADD COLUMN transcript_at TEXT;

-- Telnyx may deliver the transcript before or after the recording is archived,
-- so it always lands here first and is copied onto the recording when both exist.
CREATE TABLE IF NOT EXISTS voice_transcripts (
  recording_id TEXT PRIMARY KEY,
  call_control_id TEXT NOT NULL,
  transcript TEXT NOT NULL,
  received_at TEXT NOT NULL DEFAULT (datetime('now'))
);
