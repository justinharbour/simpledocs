-- Fail the migration rather than silently discard existing unresolved claims.
-- A partial unique index serializes claims across all drafts for each actor.
CREATE UNIQUE INDEX mail_one_unresolved_per_actor ON mail_intents(actor_id)
  WHERE status IN ('submitting', 'unknown');
