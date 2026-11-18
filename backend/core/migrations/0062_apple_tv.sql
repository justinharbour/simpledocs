-- Apple TV pairing. Only hashes are stored: the device code (polled by the TV), the
-- user code (typed in Settings) and the bearer token. A pairing row is single-use:
-- redeemed_at is set once when the token is issued, and the token itself is revocable.
CREATE TABLE tv_pairings (
  id TEXT PRIMARY KEY,
  actor_id TEXT,
  device_code_hash TEXT NOT NULL UNIQUE,
  user_code_hash TEXT NOT NULL UNIQUE,
  device_name TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'redeemed', 'denied')),
  token_hash TEXT UNIQUE,
  last_polled_at INTEGER,
  last_used_at TEXT,
  revoked_at TEXT,
  expires_at INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX tv_pairings_actor ON tv_pairings(actor_id, created_at DESC);
