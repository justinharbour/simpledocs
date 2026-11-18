-- One allocation per envelope UUID, shared across actors on this D1 instance.
-- Allocations are made before writing numbered covers to R2; gaps are retained.
CREATE TABLE envelope_numbers (
  number INTEGER PRIMARY KEY AUTOINCREMENT CHECK (number BETWEEN 1 AND 999999),
  transmission_id TEXT NOT NULL UNIQUE
);

CREATE TABLE envelope_documents (
  transmission_id TEXT NOT NULL REFERENCES transmissions(id),
  position INTEGER NOT NULL CHECK (position BETWEEN 1 AND 99),
  name TEXT NOT NULL,
  page_count INTEGER NOT NULL CHECK (page_count > 0),
  PRIMARY KEY (transmission_id, position)
);
