CREATE TABLE IF NOT EXISTS observations_pit (
  series_id TEXT NOT NULL,
  observation_date TEXT NOT NULL,
  vintage_date TEXT NOT NULL,
  released_at TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  tradable_at TEXT NOT NULL,
  source TEXT NOT NULL,
  checksum TEXT NOT NULL,
  data_run_id TEXT NOT NULL,
  release_time_status TEXT NOT NULL CHECK (release_time_status IN ('OBSERVED_AT_FETCH','CONSERVATIVE_DATE_END','OVERRIDE')),
  value REAL NOT NULL,
  PRIMARY KEY (series_id, observation_date, vintage_date),
  FOREIGN KEY (data_run_id) REFERENCES ingest_runs(run_id)
);

CREATE INDEX IF NOT EXISTS observations_pit_release_lookup
  ON observations_pit(series_id, released_at, observation_date, vintage_date);
CREATE INDEX IF NOT EXISTS observations_pit_tradable_lookup
  ON observations_pit(tradable_at);

CREATE TABLE IF NOT EXISTS staging_observations_pit (
  run_id TEXT NOT NULL,
  series_id TEXT NOT NULL,
  observation_date TEXT NOT NULL,
  vintage_date TEXT NOT NULL,
  released_at TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  tradable_at TEXT NOT NULL,
  source TEXT NOT NULL,
  checksum TEXT NOT NULL,
  release_time_status TEXT NOT NULL CHECK (release_time_status IN ('OBSERVED_AT_FETCH','CONSERVATIVE_DATE_END','OVERRIDE')),
  value REAL NOT NULL,
  PRIMARY KEY (run_id, series_id, observation_date, vintage_date),
  FOREIGN KEY (run_id) REFERENCES ingest_runs(run_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS staging_observations_pit_run
  ON staging_observations_pit(run_id, series_id);

CREATE TABLE IF NOT EXISTS release_calendar (
  series_id TEXT NOT NULL,
  expected_release_weekday INTEGER CHECK (expected_release_weekday IS NULL OR expected_release_weekday BETWEEN 0 AND 6),
  expected_release_time TEXT NOT NULL DEFAULT '23:59:59',
  timezone TEXT NOT NULL DEFAULT 'UTC',
  source_url TEXT NOT NULL,
  timing_policy TEXT NOT NULL DEFAULT 'CONSERVATIVE_ALFRED_DATE',
  valid_from TEXT NOT NULL DEFAULT '1776-07-04',
  valid_to TEXT NOT NULL DEFAULT '9999-12-31',
  PRIMARY KEY (series_id, valid_from)
);

CREATE TABLE IF NOT EXISTS release_calendar_overrides (
  series_id TEXT NOT NULL,
  vintage_date TEXT NOT NULL,
  released_at TEXT NOT NULL,
  tradable_at TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (series_id, vintage_date)
);

CREATE TABLE IF NOT EXISTS snapshot_inputs (
  snapshot_channel TEXT NOT NULL CHECK (snapshot_channel = 'OFFICIAL'),
  decision_week TEXT NOT NULL,
  snapshot_date TEXT NOT NULL,
  data_run_id TEXT NOT NULL,
  series_id TEXT NOT NULL,
  input_status TEXT NOT NULL CHECK (input_status IN ('AVAILABLE','MISSING')),
  observation_date TEXT,
  vintage_date TEXT,
  released_at TEXT,
  tradable_at TEXT,
  value REAL,
  source TEXT,
  checksum TEXT,
  CHECK (
    (input_status = 'AVAILABLE' AND observation_date IS NOT NULL AND vintage_date IS NOT NULL
      AND released_at IS NOT NULL AND tradable_at IS NOT NULL AND value IS NOT NULL
      AND source IS NOT NULL AND checksum IS NOT NULL)
    OR
    (input_status = 'MISSING' AND observation_date IS NULL AND vintage_date IS NULL
      AND released_at IS NULL AND tradable_at IS NULL AND value IS NULL
      AND source IS NULL AND checksum IS NULL)
  ),
  PRIMARY KEY (snapshot_channel, decision_week, series_id)
);

CREATE TRIGGER IF NOT EXISTS observations_pit_no_update BEFORE UPDATE ON observations_pit
BEGIN SELECT RAISE(ABORT, 'observations_pit is append-only'); END;
CREATE TRIGGER IF NOT EXISTS observations_pit_no_delete BEFORE DELETE ON observations_pit
BEGIN SELECT RAISE(ABORT, 'observations_pit is append-only'); END;
CREATE TRIGGER IF NOT EXISTS snapshot_inputs_no_update BEFORE UPDATE ON snapshot_inputs
BEGIN SELECT RAISE(ABORT, 'snapshot_inputs is append-only'); END;
CREATE TRIGGER IF NOT EXISTS snapshot_inputs_no_delete BEFORE DELETE ON snapshot_inputs
BEGIN SELECT RAISE(ABORT, 'snapshot_inputs is append-only'); END;

CREATE VIEW IF NOT EXISTS observation_revisions AS
WITH revisions AS (
  SELECT series_id, observation_date, vintage_date, released_at,
         LAG(value) OVER (PARTITION BY series_id, observation_date ORDER BY vintage_date) AS old_value,
         value AS new_value
  FROM observations_pit
)
SELECT series_id, observation_date, vintage_date, released_at, old_value, new_value,
       new_value - old_value AS revision_delta
FROM revisions WHERE old_value IS NOT NULL;

INSERT OR IGNORE INTO release_calendar
  (series_id, expected_release_weekday, expected_release_time, timezone, source_url, timing_policy)
VALUES
  ('WALCL',NULL,'23:59:59','UTC','https://fred.stlouisfed.org/series/WALCL','CONSERVATIVE_ALFRED_DATE'),
  ('WTREGEN',NULL,'23:59:59','UTC','https://fred.stlouisfed.org/series/WTREGEN','CONSERVATIVE_ALFRED_DATE'),
  ('WDTGAL',NULL,'23:59:59','UTC','https://fred.stlouisfed.org/series/WDTGAL','CONSERVATIVE_ALFRED_DATE'),
  ('WRBWFRBL',NULL,'23:59:59','UTC','https://fred.stlouisfed.org/series/WRBWFRBL','CONSERVATIVE_ALFRED_DATE'),
  ('RRPONTSYD',NULL,'23:59:59','UTC','https://fred.stlouisfed.org/series/RRPONTSYD','CONSERVATIVE_ALFRED_DATE'),
  ('RPONTSYD',NULL,'23:59:59','UTC','https://fred.stlouisfed.org/series/RPONTSYD','CONSERVATIVE_ALFRED_DATE'),
  ('SOFR',NULL,'23:59:59','UTC','https://fred.stlouisfed.org/series/SOFR','CONSERVATIVE_ALFRED_DATE'),
  ('IORB',NULL,'23:59:59','UTC','https://fred.stlouisfed.org/series/IORB','CONSERVATIVE_ALFRED_DATE'),
  ('BAMLH0A0HYM2',NULL,'23:59:59','UTC','https://fred.stlouisfed.org/series/BAMLH0A0HYM2','CONSERVATIVE_ALFRED_DATE'),
  ('DGS10',NULL,'23:59:59','UTC','https://fred.stlouisfed.org/series/DGS10','CONSERVATIVE_ALFRED_DATE'),
  ('VIXCLS',NULL,'23:59:59','UTC','https://fred.stlouisfed.org/series/VIXCLS','CONSERVATIVE_ALFRED_DATE'),
  ('DTWEXBGS',NULL,'23:59:59','UTC','https://fred.stlouisfed.org/series/DTWEXBGS','CONSERVATIVE_ALFRED_DATE'),
  ('SP500',NULL,'23:59:59','UTC','https://fred.stlouisfed.org/series/SP500','CONSERVATIVE_ALFRED_DATE'),
  ('T10Y2Y',NULL,'23:59:59','UTC','https://fred.stlouisfed.org/series/T10Y2Y','CONSERVATIVE_ALFRED_DATE'),
  ('ECBASSETSW',NULL,'23:59:59','UTC','https://fred.stlouisfed.org/series/ECBASSETSW','CONSERVATIVE_ALFRED_DATE'),
  ('JPNASSETS',NULL,'23:59:59','UTC','https://fred.stlouisfed.org/series/JPNASSETS','CONSERVATIVE_ALFRED_DATE'),
  ('DEXUSEU',NULL,'23:59:59','UTC','https://fred.stlouisfed.org/series/DEXUSEU','CONSERVATIVE_ALFRED_DATE'),
  ('DEXJPUS',NULL,'23:59:59','UTC','https://fred.stlouisfed.org/series/DEXJPUS','CONSERVATIVE_ALFRED_DATE');

ALTER TABLE model_snapshot_weekly ADD COLUMN data_run_id TEXT;
ALTER TABLE model_snapshot_weekly ADD COLUMN data_cutoff TEXT;
ALTER TABLE model_snapshot_weekly ADD COLUMN decision_at TEXT;
ALTER TABLE model_snapshot_weekly ADD COLUMN tradable_at TEXT;
ALTER TABLE model_snapshot_weekly ADD COLUMN pit_status TEXT NOT NULL DEFAULT 'LEGACY_NON_PIT'
  CHECK (pit_status IN ('LEGACY_NON_PIT','PIT'));

ALTER TABLE nowcast_snapshot_daily ADD COLUMN data_run_id TEXT;
ALTER TABLE nowcast_snapshot_daily ADD COLUMN data_cutoff TEXT;
ALTER TABLE nowcast_snapshot_daily ADD COLUMN decision_at TEXT;
ALTER TABLE nowcast_snapshot_daily ADD COLUMN tradable_at TEXT;
ALTER TABLE nowcast_snapshot_daily ADD COLUMN pit_status TEXT NOT NULL DEFAULT 'LEGACY_NON_PIT'
  CHECK (pit_status IN ('LEGACY_NON_PIT','PIT'));
