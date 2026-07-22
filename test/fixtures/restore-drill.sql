CREATE TABLE observations (series_id TEXT NOT NULL, date TEXT NOT NULL, value REAL NOT NULL, PRIMARY KEY(series_id,date));
CREATE TABLE ingest_runs (run_id TEXT PRIMARY KEY, state TEXT NOT NULL, mode TEXT NOT NULL, started_at TEXT NOT NULL);
CREATE TABLE model_snapshot_weekly (
  date TEXT PRIMARY KEY, score REAL, verdict TEXT, decision_status TEXT,
  model_version TEXT, config_hash TEXT, code_commit_sha TEXT, data_run_id TEXT,
  data_cutoff TEXT, decision_at TEXT, created_at TEXT
);
INSERT INTO observations VALUES ('WALCL','2026-07-15',6500000);
INSERT INTO ingest_runs VALUES ('fixture-run','ACTIVE','FULL','2026-07-16T00:00:00Z');
INSERT INTO model_snapshot_weekly VALUES (
  '2026-07-15',60,'BULLISH','OK','champion-v1.0.0',
  'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  'LOCAL_UNCONFIGURED','fixture-run','2026-07-16T00:00:00Z',
  '2026-07-16T00:00:00Z','2026-07-16T00:00:01Z'
);
