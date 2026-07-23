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
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (event_key, revision),
  FOREIGN KEY (supersedes_event_id) REFERENCES policy_regime_events(event_id),
  CHECK ((revision = 1 AND supersedes_event_id IS NULL)
    OR (revision > 1 AND supersedes_event_id IS NOT NULL)),
  CONSTRAINT policy_regime_event_required_fields CHECK (
    length(trim(event_id)) > 0
    AND length(trim(event_key)) > 0
    AND length(trim(source_document)) > 0
    AND length(trim(approved_by)) > 0
  ),
  CONSTRAINT policy_regime_event_effective_dates CHECK (
    date(effective_from) IS NOT NULL
    AND date(effective_from) = effective_from
    AND (effective_to IS NULL OR (
      date(effective_to) IS NOT NULL
      AND date(effective_to) = effective_to
      AND effective_to > effective_from
    ))
  ),
  CONSTRAINT policy_regime_event_timestamps CHECK (
    julianday(source_published_at) IS NOT NULL
    AND julianday(created_at) IS NOT NULL
    AND (
      strftime('%Y-%m-%dT%H:%M:%SZ',source_published_at) = source_published_at
      OR strftime('%Y-%m-%dT%H:%M:%fZ',source_published_at) = source_published_at
    )
    AND strftime('%Y-%m-%dT%H:%M:%fZ',created_at) = created_at
    AND julianday(source_published_at) <= julianday(created_at)
  )
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

CREATE TRIGGER IF NOT EXISTS policy_regime_events_server_clock
BEFORE INSERT ON policy_regime_events
WHEN NEW.created_at <> strftime('%Y-%m-%dT%H:%M:%fZ','now')
BEGIN SELECT RAISE(ABORT, 'policy regime knowledge created_at must use database time'); END;
