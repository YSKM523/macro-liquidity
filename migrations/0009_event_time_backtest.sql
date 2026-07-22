-- Append-only daily execution/cash revisions and one database visibility clock.
-- This migration has not been deployed, so 0009 is intentionally rewritten in
-- place instead of layering a corrective migration over a mutable draft schema.
ALTER TABLE ingest_runs ADD COLUMN activated_at TEXT CHECK (
  activated_at IS NULL OR (
    julianday(activated_at) IS NOT NULL AND
    (activated_at = strftime('%Y-%m-%dT%H:%M:%fZ',julianday(activated_at)) OR
     activated_at = replace(strftime('%Y-%m-%dT%H:%M:%fZ',julianday(activated_at)),'.000Z','Z'))
  )
);

ALTER TABLE model_snapshot_weekly ADD COLUMN recorded_at TEXT CHECK (
  recorded_at IS NULL OR (
    julianday(recorded_at) IS NOT NULL AND
    (recorded_at = strftime('%Y-%m-%dT%H:%M:%fZ',julianday(recorded_at)) OR
     recorded_at = replace(strftime('%Y-%m-%dT%H:%M:%fZ',julianday(recorded_at)),'.000Z','Z'))
  )
);

-- One D1 clock read is shared by all synthetic backfills. Existing snapshots
-- become visible no earlier than migration application because their true
-- historical commit time was never recorded.
CREATE TABLE event_backtest_migration_clock (
  singleton INTEGER PRIMARY KEY CHECK (singleton=1),
  recorded_at TEXT NOT NULL
);
INSERT INTO event_backtest_migration_clock
VALUES (1,strftime('%Y-%m-%dT%H:%M:%fZ','now'));

UPDATE model_snapshot_weekly
SET recorded_at=(SELECT recorded_at FROM event_backtest_migration_clock)
WHERE recorded_at IS NULL;

CREATE TABLE IF NOT EXISTS market_prices_daily (
  symbol         TEXT NOT NULL CHECK (symbol IN ('SPX','VIX')),
  date           TEXT NOT NULL CHECK (date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' AND date(date)=date),
  close          REAL NOT NULL CHECK (
    typeof(close) IN ('real','integer') AND
    ((symbol='SPX' AND close>0) OR (symbol='VIX' AND close>=0))
  ),
  adjusted_close REAL NOT NULL CHECK (
    typeof(adjusted_close) IN ('real','integer') AND
    ((symbol='SPX' AND adjusted_close>0) OR (symbol='VIX' AND adjusted_close>=0))
  ),
  source         TEXT NOT NULL CHECK (length(source)>0),
  fetched_at     TEXT NOT NULL CHECK (
    julianday(fetched_at) IS NOT NULL AND
    (fetched_at = strftime('%Y-%m-%dT%H:%M:%fZ',julianday(fetched_at)) OR
     fetched_at = replace(strftime('%Y-%m-%dT%H:%M:%fZ',julianday(fetched_at)),'.000Z','Z'))
  ),
  data_run_id    TEXT CHECK (data_run_id IS NULL OR length(data_run_id)>0),
  activation_run_id TEXT NOT NULL CHECK (length(activation_run_id)>0),
  activated_at   TEXT NOT NULL CHECK (
    julianday(activated_at) IS NOT NULL AND
    (activated_at = strftime('%Y-%m-%dT%H:%M:%fZ',julianday(activated_at)) OR
     activated_at = replace(strftime('%Y-%m-%dT%H:%M:%fZ',julianday(activated_at)),'.000Z','Z'))
  ),
  provenance_status TEXT NOT NULL CHECK (
    provenance_status IN ('PIT_RAW','SYNTHETIC_BACKFILL','LEGACY_NO_PIT')
  ),
  PRIMARY KEY (symbol,date,activation_run_id)
);

CREATE INDEX IF NOT EXISTS idx_market_prices_daily_asof
  ON market_prices_daily(symbol,date,activated_at DESC,activation_run_id DESC);
CREATE INDEX IF NOT EXISTS idx_market_prices_daily_run ON market_prices_daily(activation_run_id,data_run_id);

CREATE TABLE IF NOT EXISTS cash_rates_daily (
  rate_id      TEXT NOT NULL CHECK (rate_id='SOFR'),
  date         TEXT NOT NULL CHECK (date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' AND date(date)=date),
  rate         REAL NOT NULL CHECK (typeof(rate) IN ('real','integer')),
  source       TEXT NOT NULL CHECK (length(source)>0),
  fetched_at   TEXT NOT NULL CHECK (
    julianday(fetched_at) IS NOT NULL AND
    (fetched_at = strftime('%Y-%m-%dT%H:%M:%fZ',julianday(fetched_at)) OR
     fetched_at = replace(strftime('%Y-%m-%dT%H:%M:%fZ',julianday(fetched_at)),'.000Z','Z'))
  ),
  data_run_id  TEXT CHECK (data_run_id IS NULL OR length(data_run_id)>0),
  activation_run_id TEXT NOT NULL CHECK (length(activation_run_id)>0),
  activated_at TEXT NOT NULL CHECK (
    julianday(activated_at) IS NOT NULL AND
    (activated_at = strftime('%Y-%m-%dT%H:%M:%fZ',julianday(activated_at)) OR
     activated_at = replace(strftime('%Y-%m-%dT%H:%M:%fZ',julianday(activated_at)),'.000Z','Z'))
  ),
  provenance_status TEXT NOT NULL CHECK (
    provenance_status IN ('PIT_RAW','SYNTHETIC_BACKFILL','LEGACY_NO_PIT')
  ),
  PRIMARY KEY (rate_id,date,activation_run_id)
);

CREATE INDEX IF NOT EXISTS idx_cash_rates_daily_asof
  ON cash_rates_daily(rate_id,date,activated_at DESC,activation_run_id DESC);
CREATE INDEX IF NOT EXISTS idx_cash_rates_daily_run ON cash_rates_daily(activation_run_id,data_run_id);

-- The bridge is retained as an auditable but non-formal revision. A later real
-- activation appends PIT_RAW/LEGACY_NO_PIT rows; it never overwrites this row.
INSERT OR IGNORE INTO market_prices_daily
  (symbol,date,close,adjusted_close,source,fetched_at,data_run_id,activation_run_id,activated_at,provenance_status)
SELECT CASE series_id WHEN 'SP500' THEN 'SPX' ELSE 'VIX' END,
       date,value,value,'FRED:' || series_id,clock.recorded_at,
       'MIGRATION_0009_BACKFILL','MIGRATION_0009_BACKFILL',clock.recorded_at,'SYNTHETIC_BACKFILL'
FROM observations
CROSS JOIN event_backtest_migration_clock clock
WHERE series_id IN ('SP500','VIXCLS');

INSERT OR IGNORE INTO cash_rates_daily
  (rate_id,date,rate,source,fetched_at,data_run_id,activation_run_id,activated_at,provenance_status)
SELECT 'SOFR',date,value,'FRED:SOFR',clock.recorded_at,
       'MIGRATION_0009_BACKFILL','MIGRATION_0009_BACKFILL',clock.recorded_at,'SYNTHETIC_BACKFILL'
FROM observations
CROSS JOIN event_backtest_migration_clock clock
WHERE series_id='SOFR';

DROP TABLE event_backtest_migration_clock;

CREATE TRIGGER market_prices_daily_no_update
BEFORE UPDATE ON market_prices_daily
BEGIN SELECT RAISE(ABORT,'market_prices_daily is append-only'); END;

CREATE TRIGGER market_prices_daily_no_delete
BEFORE DELETE ON market_prices_daily
BEGIN SELECT RAISE(ABORT,'market_prices_daily is append-only'); END;

CREATE TRIGGER cash_rates_daily_no_update
BEFORE UPDATE ON cash_rates_daily
BEGIN SELECT RAISE(ABORT,'cash_rates_daily is append-only'); END;

CREATE TRIGGER cash_rates_daily_no_delete
BEFORE DELETE ON cash_rates_daily
BEGIN SELECT RAISE(ABORT,'cash_rates_daily is append-only'); END;
