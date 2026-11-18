-- Keep opt-outs even if message history is deleted. The provider also applies
-- profile-level blocks; this local ledger covers events received by this number.
CREATE TABLE sms_opt_outs (
  peer TEXT PRIMARY KEY,
  opted_out_at TEXT NOT NULL
);
