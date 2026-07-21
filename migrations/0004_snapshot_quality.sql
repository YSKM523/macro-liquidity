ALTER TABLE daily_snapshot ADD COLUMN decision_status TEXT NOT NULL DEFAULT 'DATA_INCOMPLETE';
ALTER TABLE daily_snapshot ADD COLUMN factor_quality_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE daily_snapshot ADD COLUMN freshness_json TEXT NOT NULL DEFAULT '{}';
