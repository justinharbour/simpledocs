-- Read state for inbox items that have no read column of their own (received faxes and
-- missed calls). A row means "read"; deleting it marks the item unread again.
-- Voicemails use voice_recordings.heard_at and SMS uses sms_messages.read_at.
CREATE TABLE inbox_reads (
  kind TEXT NOT NULL CHECK (kind IN ('fax', 'call')),
  id TEXT NOT NULL,
  read_at TEXT NOT NULL,
  PRIMARY KEY (kind, id)
);
