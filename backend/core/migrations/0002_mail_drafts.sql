-- Drafts are private to the verified actor. Content is not a provider order.
-- A revision is incremented by the caller on each successful conditional edit.
CREATE TABLE mail_drafts (
  id TEXT PRIMARY KEY,
  actor_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  content_json TEXT NOT NULL CHECK (json_valid(content_json)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX mail_drafts_actor_updated ON mail_drafts(actor_id, updated_at DESC);
