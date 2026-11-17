-- No addresses, fax metadata or message bodies are stored in alert pacing.
CREATE TABLE fax_alert_pacing (
  channel TEXT PRIMARY KEY CHECK (channel = 'email'),
  next_attempt_ms INTEGER NOT NULL CHECK (next_attempt_ms >= 0)
);
