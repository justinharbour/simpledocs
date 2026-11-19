-- What PostGrid reports about a mailed letter (tracking number, status and USPS
-- barcode scans) and the owner-stored return receipt. Each change is also kept
-- as a JSON snapshot in R2 under outbound/<transmission>/mail/<delivery>/tracking/.
CREATE TABLE mail_tracking (
  delivery_id TEXT PRIMARY KEY REFERENCES dispatches(id),
  tracking_number TEXT,
  imb_status TEXT,
  imb_date TEXT,
  imb_zip TEXT,
  events_json TEXT NOT NULL DEFAULT '{"status":[],"imb":[]}',
  checked_at TEXT,
  changed_at TEXT,
  receipt_key TEXT,
  receipt_sha256 TEXT,
  receipt_uploaded_at TEXT
);
