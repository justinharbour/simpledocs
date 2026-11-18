-- Existing registrations belong to the legacy bundle IDs. Keep them intact.
ALTER TABLE push_devices ADD COLUMN bundle_id TEXT;
