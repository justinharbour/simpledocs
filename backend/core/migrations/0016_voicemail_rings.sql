-- One attempt to ring the browser softphone before voicemail answers, claimed per incoming call
-- so a redelivered webhook never transfers the same call twice.
CREATE TABLE voicemail_rings (
  call_control_id TEXT PRIMARY KEY REFERENCES voicemail_calls(call_control_id),
  outcome TEXT NOT NULL CHECK (outcome IN ('claimed', 'accepted', 'rejected', 'unknown'))
);
