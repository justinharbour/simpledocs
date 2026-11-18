-- Written before R2; retained until the object is registered or cleanup succeeds.
CREATE TABLE portal_object_intents (
 object_key TEXT PRIMARY KEY,
 cleanup_after INTEGER NOT NULL
);
CREATE INDEX portal_object_intents_expiry ON portal_object_intents(cleanup_after);
