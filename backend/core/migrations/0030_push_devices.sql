-- APNs device tokens for owner push notifications. Tokens are credentials-adjacent:
-- never log them or return them from any API.
CREATE TABLE push_devices (
  token TEXT PRIMARY KEY CHECK (length(token) BETWEEN 64 AND 200),
  platform TEXT NOT NULL CHECK (platform IN ('ios', 'macos')),
  environment TEXT NOT NULL CHECK (environment IN ('sandbox', 'production')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at TEXT NOT NULL DEFAULT (datetime('now'))
);
