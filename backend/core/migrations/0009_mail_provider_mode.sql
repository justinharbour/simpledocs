-- Historical claims used the live key. Preserve that classification.
ALTER TABLE mail_intents ADD COLUMN provider_mode TEXT NOT NULL DEFAULT 'live' CHECK (provider_mode IN ('test', 'live'));
