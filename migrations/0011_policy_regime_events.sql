CREATE TABLE IF NOT EXISTS policy_regime_events (
  event_id TEXT PRIMARY KEY,
  event_key TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  status TEXT NOT NULL CHECK (status IN ('ACTIVE','RETRACTED')),
  supersedes_event_id TEXT,
  effective_from TEXT NOT NULL,
  effective_to TEXT,
  regime TEXT NOT NULL CHECK (regime IN (
    'QE','QT','RESERVE_MANAGEMENT','REINVESTMENT_ONLY','CRISIS_LIQUIDITY','NEUTRAL','UNKNOWN'
  )),
  source_document TEXT NOT NULL,
  source_published_at TEXT NOT NULL,
  approved_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (event_key, revision),
  FOREIGN KEY (supersedes_event_id) REFERENCES policy_regime_events(event_id),
  CHECK ((revision = 1 AND supersedes_event_id IS NULL)
    OR (revision > 1 AND supersedes_event_id IS NOT NULL)),
  CHECK (effective_to IS NULL OR effective_to > effective_from)
);

CREATE INDEX IF NOT EXISTS policy_regime_events_visibility
  ON policy_regime_events(created_at,event_key,revision);
CREATE INDEX IF NOT EXISTS policy_regime_events_effective
  ON policy_regime_events(effective_from,effective_to,status);

CREATE TRIGGER IF NOT EXISTS policy_regime_events_no_update
BEFORE UPDATE ON policy_regime_events
BEGIN SELECT RAISE(ABORT, 'policy_regime_events is append-only'); END;

CREATE TRIGGER IF NOT EXISTS policy_regime_events_no_delete
BEFORE DELETE ON policy_regime_events
BEGIN SELECT RAISE(ABORT, 'policy_regime_events is append-only'); END;

CREATE TRIGGER IF NOT EXISTS policy_regime_events_revision_lineage
BEFORE INSERT ON policy_regime_events
WHEN NEW.revision > 1 AND NOT EXISTS (
  SELECT 1 FROM policy_regime_events previous
  WHERE previous.event_key = NEW.event_key
    AND previous.revision = NEW.revision - 1
    AND previous.event_id = NEW.supersedes_event_id
)
BEGIN SELECT RAISE(ABORT, 'policy regime revision lineage mismatch'); END;
