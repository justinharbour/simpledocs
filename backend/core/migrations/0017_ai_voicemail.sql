CREATE TABLE ai_voicemail_sessions (call_control_id TEXT PRIMARY KEY, token_hash TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE ai_voicemail_commands (call_control_id TEXT PRIMARY KEY, command_id TEXT NOT NULL UNIQUE, outcome TEXT NOT NULL CHECK (outcome IN ('claimed', 'accepted', 'unknown', 'rejected')));
CREATE TABLE ai_voicemail_requests (call_control_id TEXT NOT NULL, kind TEXT NOT NULL, details TEXT NOT NULL, consent INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, PRIMARY KEY (call_control_id, kind));
