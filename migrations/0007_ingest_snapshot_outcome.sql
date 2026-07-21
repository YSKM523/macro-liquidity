ALTER TABLE ingest_runs ADD COLUMN snapshot_state TEXT NOT NULL DEFAULT 'PENDING'
  CHECK (snapshot_state IN ('PENDING', 'SUCCEEDED', 'FAILED'));
ALTER TABLE ingest_runs ADD COLUMN snapshot_completed_at TEXT;
ALTER TABLE ingest_runs ADD COLUMN snapshot_error TEXT;
ALTER TABLE ingest_runs ADD COLUMN snapshot_count INTEGER NOT NULL DEFAULT 0
  CHECK (snapshot_count >= 0);

-- Runs that never activated cannot have produced snapshots. Existing ACTIVE and
-- SUPERSEDED rows remain conservatively PENDING because their historical
-- post-activation outcome cannot be reconstructed truthfully.
UPDATE ingest_runs
SET snapshot_state = 'FAILED',
    snapshot_completed_at = completed_at,
    snapshot_error = 'run failed before snapshot completion'
WHERE state = 'FAILED';
