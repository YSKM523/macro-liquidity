-- Additive production-governance metadata. Historical scores and PIT values are
-- preserved byte-for-byte and explicitly labelled as unversioned.
ALTER TABLE model_snapshot_weekly ADD COLUMN model_version TEXT NOT NULL DEFAULT 'LEGACY_UNVERSIONED';
ALTER TABLE model_snapshot_weekly ADD COLUMN config_hash TEXT NOT NULL DEFAULT 'LEGACY_UNVERSIONED';
ALTER TABLE model_snapshot_weekly ADD COLUMN code_commit_sha TEXT NOT NULL DEFAULT 'LEGACY_UNVERSIONED';
ALTER TABLE model_snapshot_weekly ADD COLUMN created_at TEXT;

ALTER TABLE nowcast_snapshot_daily ADD COLUMN model_version TEXT NOT NULL DEFAULT 'LEGACY_UNVERSIONED';
ALTER TABLE nowcast_snapshot_daily ADD COLUMN config_hash TEXT NOT NULL DEFAULT 'LEGACY_UNVERSIONED';
ALTER TABLE nowcast_snapshot_daily ADD COLUMN code_commit_sha TEXT NOT NULL DEFAULT 'LEGACY_UNVERSIONED';
ALTER TABLE nowcast_snapshot_daily ADD COLUMN created_at TEXT;

UPDATE model_snapshot_weekly
SET model_version='LEGACY_UNVERSIONED',
    config_hash='LEGACY_UNVERSIONED',
    code_commit_sha='LEGACY_UNVERSIONED',
    created_at=COALESCE(recorded_at,strftime('%Y-%m-%dT%H:%M:%fZ','now'));

UPDATE nowcast_snapshot_daily
SET model_version='LEGACY_UNVERSIONED',
    config_hash='LEGACY_UNVERSIONED',
    code_commit_sha='LEGACY_UNVERSIONED',
    created_at=COALESCE(created_at,strftime('%Y-%m-%dT%H:%M:%fZ','now'));

CREATE TABLE IF NOT EXISTS admin_audit_log (
  audit_id TEXT PRIMARY KEY,
  attempted_at TEXT NOT NULL,
  action TEXT NOT NULL,
  auth_method TEXT NOT NULL,
  authorized INTEGER NOT NULL CHECK (authorized IN (0,1)),
  confirmed INTEGER NOT NULL CHECK (confirmed IN (0,1)),
  outcome TEXT NOT NULL,
  request_id TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_admin_audit_attempted_at
  ON admin_audit_log(attempted_at DESC);
