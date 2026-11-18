-- Independent recipient deliveries; does not alter transmission or bundle IDs.
CREATE TABLE portal_deliveries (
 id TEXT PRIMARY KEY, transmission_id TEXT NOT NULL, actor_id TEXT NOT NULL,
 recipient TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, expires_at INTEGER NOT NULL,
 consumed_at INTEGER, revoked_at INTEGER, object_key TEXT NOT NULL, iv TEXT NOT NULL, key_id TEXT NOT NULL,
 pin_channel TEXT, pin_phone TEXT, pin_state TEXT NOT NULL DEFAULT 'none',
 verify_id TEXT, pin_attempts INTEGER NOT NULL DEFAULT 0, consent_at INTEGER,
 consent_version TEXT, send_status TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE INDEX portal_owner ON portal_deliveries(transmission_id, actor_id);
CREATE TABLE portal_sessions (
 session_hash TEXT PRIMARY KEY, delivery_id TEXT NOT NULL REFERENCES portal_deliveries(id),
 expires_at INTEGER NOT NULL
);
CREATE INDEX portal_sessions_expiry ON portal_sessions(expires_at);
CREATE TABLE portal_limits (bucket TEXT NOT NULL, period INTEGER NOT NULL, count INTEGER NOT NULL, PRIMARY KEY(bucket, period));
CREATE INDEX portal_limits_period ON portal_limits(period);
