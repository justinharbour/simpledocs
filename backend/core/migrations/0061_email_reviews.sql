-- A prepared email's reviewed recipient, verification method and source digest.
CREATE TABLE email_reviews (
  transmission_id TEXT PRIMARY KEY REFERENCES transmissions(id),
  actor_id TEXT NOT NULL,
  options_json TEXT NOT NULL,
  pdf_sha256 TEXT NOT NULL
);
