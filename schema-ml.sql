-- ML training data: capture every synthesis run with full input/output.
-- Additive only — no changes to existing tables.
-- Apply with: psql "$DATABASE_URL" -f schema-ml.sql
-- This file is NOT included in migrate.js (which is destructive). Apply manually.

CREATE TABLE IF NOT EXISTS ml_synthesis_runs (
  id              SERIAL PRIMARY KEY,
  report_id       INTEGER REFERENCES property_reports(id) ON DELETE SET NULL,
  property_id     INTEGER REFERENCES properties(id),
  model           TEXT,
  system_prompt   TEXT,
  user_prompt     TEXT,
  raw_response    TEXT,
  parsed_ok       BOOLEAN NOT NULL,
  fallback_used   BOOLEAN NOT NULL DEFAULT FALSE,
  input_tokens    INTEGER,
  output_tokens   INTEGER,
  cost_zar        NUMERIC(10,4),
  duration_ms     INTEGER,
  error_message   TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ml_synthesis_runs_report   ON ml_synthesis_runs(report_id);
CREATE INDEX IF NOT EXISTS idx_ml_synthesis_runs_property ON ml_synthesis_runs(property_id);
CREATE INDEX IF NOT EXISTS idx_ml_synthesis_runs_created  ON ml_synthesis_runs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ml_synthesis_runs_failed   ON ml_synthesis_runs(parsed_ok) WHERE parsed_ok = FALSE;
