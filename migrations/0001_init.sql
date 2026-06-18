CREATE TABLE IF NOT EXISTS observations (
  series_id TEXT NOT NULL,
  date TEXT NOT NULL,
  value REAL NOT NULL,
  PRIMARY KEY (series_id, date)
);

CREATE TABLE IF NOT EXISTS daily_snapshot (
  date TEXT PRIMARY KEY,
  walcl REAL, tga REAL, rrp REAL, repo REAL,
  netliq REAL, netliq_trend REAL,
  sofr_iorb REAL, hy_oas REAL, dgs10 REAL, dxy_eod REAL, vix_eod REAL,
  qe_qt_regime TEXT, netliq_dir TEXT, verdict TEXT, score REAL,
  p0 INTEGER, p1 INTEGER, p2 INTEGER, p3 INTEGER,
  spx REAL, reason TEXT, factors_json TEXT
);
