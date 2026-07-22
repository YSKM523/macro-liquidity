-- Daily execution and cash inputs for the event-time backtest.
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
  source         TEXT NOT NULL CHECK (length(source) > 0),
  fetched_at     TEXT NOT NULL CHECK (
    julianday(fetched_at) IS NOT NULL AND
    (fetched_at = strftime('%Y-%m-%dT%H:%M:%fZ',julianday(fetched_at)) OR
     fetched_at = replace(strftime('%Y-%m-%dT%H:%M:%fZ',julianday(fetched_at)),'.000Z','Z'))
  ),
  data_run_id    TEXT NOT NULL CHECK (length(data_run_id) > 0),
  PRIMARY KEY (symbol,date)
);

CREATE INDEX IF NOT EXISTS idx_market_prices_daily_date ON market_prices_daily(date,symbol);
CREATE INDEX IF NOT EXISTS idx_market_prices_daily_run ON market_prices_daily(data_run_id);

CREATE TABLE IF NOT EXISTS cash_rates_daily (
  rate_id      TEXT NOT NULL CHECK (rate_id = 'SOFR'),
  date         TEXT NOT NULL CHECK (date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' AND date(date)=date),
  rate         REAL NOT NULL CHECK (typeof(rate) IN ('real','integer')),
  source       TEXT NOT NULL CHECK (length(source) > 0),
  fetched_at   TEXT NOT NULL CHECK (
    julianday(fetched_at) IS NOT NULL AND
    (fetched_at = strftime('%Y-%m-%dT%H:%M:%fZ',julianday(fetched_at)) OR
     fetched_at = replace(strftime('%Y-%m-%dT%H:%M:%fZ',julianday(fetched_at)),'.000Z','Z'))
  ),
  data_run_id  TEXT NOT NULL CHECK (length(data_run_id) > 0),
  PRIMARY KEY (rate_id,date)
);

CREATE INDEX IF NOT EXISTS idx_cash_rates_daily_date ON cash_rates_daily(date,rate_id);
CREATE INDEX IF NOT EXISTS idx_cash_rates_daily_run ON cash_rates_daily(data_run_id);

-- A local, auditable bridge for data already present when 0009 is applied.
-- The next successful activation corrects values and provenance atomically.
INSERT OR IGNORE INTO market_prices_daily
  (symbol,date,close,adjusted_close,source,fetched_at,data_run_id)
SELECT CASE series_id WHEN 'SP500' THEN 'SPX' ELSE 'VIX' END,
       date,value,value,'FRED:' || series_id,
       strftime('%Y-%m-%dT%H:%M:%fZ','now'),'MIGRATION_0009_BACKFILL'
FROM observations
WHERE series_id IN ('SP500','VIXCLS');

INSERT OR IGNORE INTO cash_rates_daily
  (rate_id,date,rate,source,fetched_at,data_run_id)
SELECT 'SOFR',date,value,'FRED:SOFR',
       strftime('%Y-%m-%dT%H:%M:%fZ','now'),'MIGRATION_0009_BACKFILL'
FROM observations
WHERE series_id='SOFR';
