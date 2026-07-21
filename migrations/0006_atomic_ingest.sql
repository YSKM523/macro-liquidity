CREATE TABLE IF NOT EXISTS ingest_runs (
  run_id TEXT PRIMARY KEY,
  state TEXT NOT NULL CHECK (state IN ('RUNNING', 'ACTIVE', 'FAILED', 'SUPERSEDED')),
  mode TEXT NOT NULL CHECK (mode IN ('INCREMENTAL', 'FULL')),
  started_at TEXT NOT NULL,
  completed_at TEXT,
  failed_step TEXT,
  failed_series TEXT,
  error TEXT,
  row_count INTEGER NOT NULL DEFAULT 0 CHECK (row_count >= 0),
  series_count INTEGER NOT NULL DEFAULT 0 CHECK (series_count >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS ingest_runs_single_active
  ON ingest_runs(state) WHERE state = 'ACTIVE';
CREATE INDEX IF NOT EXISTS ingest_runs_started_at
  ON ingest_runs(started_at DESC);

CREATE TABLE IF NOT EXISTS ingest_series_attempts (
  run_id TEXT NOT NULL,
  series_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('RUNNING', 'SUCCEEDED', 'FAILED')),
  started_at TEXT NOT NULL,
  completed_at TEXT,
  row_count INTEGER NOT NULL DEFAULT 0 CHECK (row_count >= 0),
  error TEXT,
  PRIMARY KEY (run_id, series_id),
  FOREIGN KEY (run_id) REFERENCES ingest_runs(run_id)
);

CREATE TABLE IF NOT EXISTS staging_observations (
  run_id TEXT NOT NULL,
  series_id TEXT NOT NULL,
  date TEXT NOT NULL CHECK (date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  value REAL NOT NULL,
  PRIMARY KEY (run_id, series_id, date),
  FOREIGN KEY (run_id, series_id) REFERENCES ingest_series_attempts(run_id, series_id)
);
CREATE INDEX IF NOT EXISTS staging_observations_run
  ON staging_observations(run_id, series_id);

CREATE TABLE IF NOT EXISTS ingest_lock (
  lock_name TEXT PRIMARY KEY CHECK (lock_name = 'fred_ingest'),
  owner_run_id TEXT NOT NULL,
  acquired_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

-- Bootstrap the pre-PR-06 production view as the first durable ACTIVE run.
INSERT INTO ingest_runs (
  run_id, state, mode, started_at, completed_at, row_count, series_count
)
SELECT
  'legacy-bootstrap', 'ACTIVE', 'FULL', datetime('now'), datetime('now'),
  COUNT(*), COUNT(DISTINCT series_id)
FROM observations
HAVING COUNT(*) > 0
   AND NOT EXISTS (SELECT 1 FROM ingest_runs WHERE state = 'ACTIVE');
