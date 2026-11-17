-- Existing accepted orders are deliberately unacknowledged. If this creates
-- conflicts for an actor, index creation fails. Do not discard any claims.
ALTER TABLE mail_intents ADD COLUMN acknowledged_at TEXT;
CREATE UNIQUE INDEX mail_one_blocking_per_actor ON mail_intents(actor_id)
  WHERE status IN ('submitting', 'unknown') OR (status = 'accepted' AND acknowledged_at IS NULL);
DROP INDEX mail_one_unresolved_per_actor;
