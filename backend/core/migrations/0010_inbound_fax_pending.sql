-- A receipt is pending while no corresponding archived event exists.
-- Never store signed URLs, webhook bodies, phone numbers, or documents here.
CREATE TABLE inbound_fax_pending (
  event_id TEXT PRIMARY KEY,
  fax_id TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  received_at TEXT NOT NULL
);
CREATE VIEW inbound_fax_unarchived AS
SELECT p.event_id, p.fax_id, p.occurred_at, p.received_at
FROM inbound_fax_pending p
WHERE NOT EXISTS (SELECT 1 FROM inbound_fax_events e WHERE e.event_id = p.event_id AND e.event_type = 'fax.received' AND e.object_key IS NOT NULL);
