-- Persistent scraper run history — powers the "Today" morning review.

CREATE TABLE IF NOT EXISTS scraper_runs (
  id SERIAL PRIMARY KEY,
  run_type TEXT NOT NULL,                -- 'master' | 'scheduled' | 'manual'
  trigger TEXT,                          -- 'cron' | 'dashboard' | 'cli'
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'running', -- 'running' | 'success' | 'failed' | 'partial' | 'killed'
  total_collected INTEGER DEFAULT 0,
  total_errors INTEGER DEFAULT 0,
  notes TEXT
);
CREATE INDEX IF NOT EXISTS idx_scraper_runs_started ON scraper_runs(started_at DESC);

CREATE TABLE IF NOT EXISTS scraper_run_items (
  id SERIAL PRIMARY KEY,
  run_id INTEGER REFERENCES scraper_runs(id) ON DELETE CASCADE,
  scraper_name TEXT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  duration_seconds INTEGER,
  collected INTEGER DEFAULT 0,
  errors INTEGER DEFAULT 0,
  status TEXT DEFAULT 'running',         -- 'running' | 'success' | 'failed' | 'timeout' | 'empty'
  error_sample TEXT                       -- first failure message, for diagnosis
);
CREATE INDEX IF NOT EXISTS idx_scraper_run_items_run ON scraper_run_items(run_id);
CREATE INDEX IF NOT EXISTS idx_scraper_run_items_name_started ON scraper_run_items(scraper_name, started_at DESC);
