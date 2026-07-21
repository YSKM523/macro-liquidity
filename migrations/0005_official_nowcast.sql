CREATE TABLE IF NOT EXISTS model_snapshot_weekly (
  date TEXT PRIMARY KEY,
  decision_week TEXT NOT NULL UNIQUE,
  walcl REAL, tga REAL, rrp REAL, repo REAL,
  netliq REAL, netliq_trend REAL,
  sofr_iorb REAL, hy_oas REAL, dgs10 REAL, dxy_eod REAL, vix_eod REAL,
  qe_qt_regime TEXT, netliq_dir TEXT, verdict TEXT, score REAL,
  p0 INTEGER, p1 INTEGER, p2 INTEGER, p3 INTEGER,
  spx REAL, reason TEXT, factors_json TEXT, coverage REAL,
  decision_status TEXT NOT NULL DEFAULT 'DATA_INCOMPLETE',
  factor_quality_json TEXT NOT NULL DEFAULT '{}',
  freshness_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS nowcast_snapshot_daily (
  date TEXT PRIMARY KEY,
  channel_status TEXT NOT NULL DEFAULT 'PROVISIONAL' CHECK (channel_status = 'PROVISIONAL'),
  walcl REAL, tga REAL, rrp REAL, repo REAL,
  netliq REAL, netliq_trend REAL,
  sofr_iorb REAL, hy_oas REAL, dgs10 REAL, dxy_eod REAL, vix_eod REAL,
  qe_qt_regime TEXT, netliq_dir TEXT, verdict TEXT, score REAL,
  p0 INTEGER, p1 INTEGER, p2 INTEGER, p3 INTEGER,
  spx REAL, reason TEXT, factors_json TEXT, coverage REAL,
  decision_status TEXT NOT NULL DEFAULT 'DATA_INCOMPLETE',
  factor_quality_json TEXT NOT NULL DEFAULT '{}',
  freshness_json TEXT NOT NULL DEFAULT '{}'
);

-- Conservative legacy migration: a row is official only when its date exactly
-- matches an observed WALCL release date. If more than one such date lands in the
-- same Monday-based week, retain the latest one so weekly uniqueness is explicit.
WITH walcl_cadence AS (
  SELECT
    d.*,
    date(d.date, '-' || ((CAST(strftime('%w', d.date) AS INTEGER) + 6) % 7) || ' days') AS decision_week,
    ROW_NUMBER() OVER (
      PARTITION BY date(d.date, '-' || ((CAST(strftime('%w', d.date) AS INTEGER) + 6) % 7) || ' days')
      ORDER BY d.date DESC
    ) AS week_rank
  FROM daily_snapshot d
  JOIN observations o ON o.series_id = 'WALCL' AND o.date = d.date
)
INSERT OR IGNORE INTO model_snapshot_weekly (
  date, decision_week, walcl, tga, rrp, repo, netliq, netliq_trend,
  sofr_iorb, hy_oas, dgs10, dxy_eod, vix_eod, qe_qt_regime, netliq_dir,
  verdict, score, p0, p1, p2, p3, spx, reason, factors_json, coverage,
  decision_status, factor_quality_json, freshness_json
)
SELECT
  date, decision_week, walcl, tga, rrp, repo, netliq, netliq_trend,
  sofr_iorb, hy_oas, dgs10, dxy_eod, vix_eod, qe_qt_regime, netliq_dir,
  verdict, score, p0, p1, p2, p3, spx, reason, factors_json, coverage,
  decision_status, factor_quality_json, freshness_json
FROM walcl_cadence
WHERE week_rank = 1;
