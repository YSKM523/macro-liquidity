import type { Obs, SeriesMap, Snapshot, Verdict } from './metrics';
import { SERIES_IDS } from './config';
import type { PitDecisionEvent, PitObservation, ReleaseOverride, ReleaseRule, SnapshotInput } from './pit';
import { compareIsoTimestamps, isoTimestampMs, validateReleaseOverride } from './pit';
import type { EventBacktestInputs } from './event-backtest';
import {
  isPortfolioDirection,
  isPortfolioVerdict,
  mapPortfolioPolicy,
  officialPortfolioFieldIssue,
  snapshotVixStressStatus,
} from './portfolio-policy';
import { resolveModelIdentity } from './model-version';
import type { ModelIdentity } from './model-version';

function requireIsoTimestamp(value: string, field: string): void {
  isoTimestampMs(value, field);
}

async function validateOverrideTimings(db: D1Database, releaseResolutionAt: string): Promise<void> {
  const releaseResolutionMs = isoTimestampMs(releaseResolutionAt, 'release resolutionAt');
  const rows = await db.prepare(
    'SELECT series_id,vintage_date,created_at,released_at,tradable_at FROM release_calendar_overrides',
  ).all<{
    series_id: string; vintage_date: string; created_at: string;
    released_at: string; tradable_at: string;
  }>();
  const versions = new Set<string>();
  for (const row of rows.results ?? []) {
    const createdAtMs = isoTimestampMs(row.created_at, 'override createdAt');
    const version = `${row.series_id}|${row.vintage_date}|${createdAtMs}`;
    if (versions.has(version)) throw new Error('duplicate override createdAt instant');
    versions.add(version);
    if (createdAtMs <= releaseResolutionMs) {
      validateReleaseOverride({ releasedAt: row.released_at, tradableAt: row.tradable_at });
    }
  }
}

function invalidSqlTimestamp(column: string): string {
  const canonical = `strftime('%Y-%m-%dT%H:%M:%fZ',julianday(${column}))`;
  return `(julianday(${column}) IS NULL OR (${column}<>${canonical}
    AND ${column}<>replace(${canonical},'.000Z','Z')))`;
}

async function validateStoredPitTimings(db: D1Database): Promise<void> {
  const invalidFetchedAt = invalidSqlTimestamp('fetched_at');
  const invalidReleasedAt = invalidSqlTimestamp('released_at');
  const invalidTradableAt = invalidSqlTimestamp('tradable_at');
  const row = await db.prepare(
    `SELECT CASE
       WHEN ${invalidFetchedAt} THEN 'fetched'
       WHEN ${invalidReleasedAt} THEN 'released'
       WHEN ${invalidTradableAt} THEN 'tradable'
       WHEN julianday(tradable_at)<julianday(released_at) THEN 'order'
     END AS issue
     FROM observations_pit
     WHERE ${invalidFetchedAt} OR ${invalidReleasedAt} OR ${invalidTradableAt}
        OR julianday(tradable_at)<julianday(released_at)
     LIMIT 1`,
  ).first<{ issue: 'fetched' | 'released' | 'tradable' | 'order' }>();
  if (row?.issue === 'fetched') throw new Error('invalid raw fetchedAt');
  if (row?.issue === 'released') throw new Error('invalid raw releasedAt');
  if (row?.issue === 'tradable') throw new Error('invalid raw tradableAt');
  if (row?.issue === 'order') throw new Error('raw tradableAt precedes releasedAt');
}

export async function maxObsDate(db: D1Database, seriesId: string): Promise<string | null> {
  const row = await db.prepare('SELECT MAX(date) AS d FROM observations WHERE series_id = ?')
    .bind(seriesId).first<{ d: string | null }>();
  return row?.d ?? null;
}

export async function maxPitVintageDate(db: D1Database, seriesId: string): Promise<string | null> {
  const row = await db.prepare('SELECT MAX(vintage_date) AS d FROM observations_pit WHERE series_id = ?')
    .bind(seriesId).first<{ d: string | null }>();
  return row?.d ?? null;
}

export async function loadReleaseRules(db: D1Database): Promise<Map<string, ReleaseRule[]>> {
  const rows = await db.prepare(
    `SELECT series_id, expected_release_time, valid_from, valid_to FROM release_calendar
     ORDER BY series_id, valid_from`,
  ).all<{ series_id: string; expected_release_time: string; valid_from: string; valid_to: string }>();
  const out = new Map<string, ReleaseRule[]>();
  for (const row of rows.results ?? []) {
    const rules = out.get(row.series_id) ?? [];
    rules.push({
      expectedReleaseTime: row.expected_release_time,
      validFrom: row.valid_from,
      validTo: row.valid_to,
    });
    out.set(row.series_id, rules);
  }
  return out;
}

export async function loadReleaseOverrides(
  db: D1Database,
  seriesId: string,
  fromVintage: string,
  releaseResolutionAt: string,
): Promise<Map<string, ReleaseOverride>> {
  requireIsoTimestamp(releaseResolutionAt, 'release resolutionAt');
  const rows = await db.prepare(
    `SELECT vintage_date, released_at, tradable_at, created_at FROM release_calendar_overrides
     WHERE series_id = ? AND vintage_date >= ?
     ORDER BY vintage_date`,
  ).bind(seriesId, fromVintage)
    .all<{ vintage_date: string; released_at: string; tradable_at: string; created_at: string }>();
  const eligible = (rows.results ?? []).filter(row => {
    requireIsoTimestamp(row.created_at, 'override createdAt');
    if (compareIsoTimestamps(row.created_at, releaseResolutionAt) > 0) return false;
    validateReleaseOverride({ releasedAt: row.released_at, tradableAt: row.tradable_at });
    return true;
  });
  const selected = new Map<string, { createdAt: string; override: ReleaseOverride }>();
  const versions = new Set<string>();
  for (const row of eligible) {
    const version = `${row.vintage_date}|${isoTimestampMs(row.created_at)}`;
    if (versions.has(version)) throw new Error('duplicate override createdAt instant');
    versions.add(version);
    const previous = selected.get(row.vintage_date);
    if (previous == null || compareIsoTimestamps(row.created_at, previous.createdAt) > 0) {
      selected.set(row.vintage_date, {
        createdAt: row.created_at,
        override: { releasedAt: row.released_at, tradableAt: row.tradable_at },
      });
    }
  }
  return new Map([...selected].map(([vintageDate, value]) => [vintageDate, value.override]));
}

export async function stagePitObservations(
  db: D1Database,
  runId: string,
  rows: PitObservation[],
): Promise<void> {
  if (rows.length === 0) return;
  for (const row of rows) {
    isoTimestampMs(row.fetchedAt, 'raw fetchedAt');
    validateReleaseOverride({ releasedAt: row.releasedAt, tradableAt: row.tradableAt });
  }
  const statement = db.prepare(
    `INSERT INTO staging_observations_pit
       (run_id,series_id,observation_date,vintage_date,released_at,fetched_at,tradable_at,
        source,checksum,release_time_status,value)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(run_id,series_id,observation_date,vintage_date) DO UPDATE SET
       released_at=excluded.released_at,fetched_at=excluded.fetched_at,tradable_at=excluded.tradable_at,
       source=excluded.source,checksum=excluded.checksum,
       release_time_status=excluded.release_time_status,value=excluded.value`,
  );
  const writes = rows.map(row => statement.bind(
    runId, row.seriesId, row.observationDate, row.vintageDate, row.releasedAt, row.fetchedAt,
    row.tradableAt, row.source, row.checksum, row.releaseTimeStatus, row.value,
  ));
  for (let index = 0; index < writes.length; index += 100) await db.batch(writes.slice(index, index + 100));
}

export type IngestRunState = 'RUNNING' | 'ACTIVE' | 'FAILED' | 'SUPERSEDED';

export interface IngestSeriesAttempt {
  seriesId: string;
  status: 'RUNNING' | 'SUCCEEDED' | 'FAILED';
  rowCount: number;
}

export interface IngestFailure {
  step: string;
  seriesId?: string;
  error: string;
}

export class IngestSeriesValidationError extends Error {
  constructor(
    public readonly seriesId: string,
    message: string,
  ) {
    super(message);
    this.name = 'IngestSeriesValidationError';
  }
}

export async function acquireIngestLock(
  db: D1Database,
  runId: string,
  leaseSeconds: number,
): Promise<boolean> {
  const result = await db.prepare(
    `INSERT INTO ingest_lock (lock_name, owner_run_id, acquired_at, expires_at)
     VALUES (
       'fred_ingest', ?,
       strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
       strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+' || ? || ' seconds')
     )
     ON CONFLICT(lock_name) DO UPDATE SET
       owner_run_id = excluded.owner_run_id,
       acquired_at = excluded.acquired_at,
       expires_at = excluded.expires_at
     WHERE unixepoch(ingest_lock.expires_at) <= unixepoch('now')`
  ).bind(runId, leaseSeconds).run();
  return Number((result.meta as any)?.changes ?? 0) === 1;
}

export async function releaseIngestLock(db: D1Database, runId: string): Promise<boolean> {
  const result = await db.prepare(
    `DELETE FROM ingest_lock WHERE lock_name = 'fred_ingest' AND owner_run_id = ?`
  ).bind(runId).run();
  return Number((result.meta as any)?.changes ?? 0) === 1;
}

export async function renewIngestLock(
  db: D1Database,
  runId: string,
  leaseSeconds: number,
): Promise<boolean> {
  const result = await db.prepare(
    `UPDATE ingest_lock
     SET expires_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+' || ? || ' seconds')
     WHERE lock_name = 'fred_ingest' AND owner_run_id = ?
       AND unixepoch(expires_at) > unixepoch('now')`
  ).bind(leaseSeconds, runId).run();
  return Number((result.meta as any)?.changes ?? 0) === 1;
}

export async function createIngestRun(
  db: D1Database,
  runId: string,
  mode: 'INCREMENTAL' | 'FULL',
  startedAt: string,
): Promise<void> {
  await db.prepare(
    `INSERT INTO ingest_runs (run_id, state, mode, started_at)
     VALUES (?, 'RUNNING', ?, ?)`
  ).bind(runId, mode, startedAt).run();
}

export function validateSeriesRows(seriesId: string, rows: Obs[]): void {
  for (const row of rows) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(row.date) || !Number.isFinite(row.value)) {
      throw new Error(`${seriesId} staged an invalid observation`);
    }
  }
}

export async function startSeriesAttempt(
  db: D1Database,
  runId: string,
  seriesId: string,
  startedAt: string,
): Promise<void> {
  await db.prepare(
    `INSERT INTO ingest_series_attempts
       (run_id, series_id, status, started_at, row_count)
     VALUES (?, ?, 'RUNNING', ?, 0)`
  ).bind(runId, seriesId, startedAt).run();
}

export async function stageSeriesAttempt(
  db: D1Database,
  runId: string,
  seriesId: string,
  rows: Obs[],
  completedAt?: string,
): Promise<void> {
  if (rows.length > 0) {
    const statement = db.prepare(
      `INSERT INTO staging_observations (run_id, series_id, date, value)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(run_id, series_id, date) DO UPDATE SET value = excluded.value`
    );
    const writes = rows.map(row => statement.bind(runId, seriesId, row.date, row.value));
    for (let index = 0; index < writes.length; index += 100) {
      await db.batch(writes.slice(index, index + 100));
    }
  }

  const result = await db.prepare(
    `UPDATE ingest_series_attempts
     SET status = 'SUCCEEDED', completed_at = ?, row_count = ?
     WHERE run_id = ? AND series_id = ? AND status = 'RUNNING'`
  ).bind(completedAt ?? new Date().toISOString(), rows.length, runId, seriesId).run();
  if (Number((result.meta as any)?.changes ?? 0) !== 1) {
    throw new Error(`${seriesId} has no RUNNING ingest attempt to complete`);
  }
}

export async function failSeriesAttempt(
  db: D1Database,
  runId: string,
  seriesId: string,
  error: string,
  completedAt: string,
): Promise<void> {
  const result = await db.prepare(
     `UPDATE ingest_series_attempts
     SET status = 'FAILED', completed_at = ?, error = ?
     WHERE run_id = ? AND series_id = ? AND status IN ('RUNNING', 'SUCCEEDED')`
  ).bind(completedAt, error, runId, seriesId).run();
  if (Number((result.meta as any)?.changes ?? 0) !== 1) {
    throw new Error(`${seriesId} has no RUNNING ingest attempt to fail`);
  }
}

export function validateSeriesAttempts(
  configuredSeries: string[],
  attempts: IngestSeriesAttempt[],
  activeSeries: Set<string>,
): void {
  const bySeries = new Map(attempts.map(attempt => [attempt.seriesId, attempt]));
  for (const seriesId of configuredSeries) {
    const attempt = bySeries.get(seriesId);
    if (!attempt) throw new IngestSeriesValidationError(seriesId, `${seriesId} has no ingest attempt`);
    if (attempt.status !== 'SUCCEEDED') {
      throw new IngestSeriesValidationError(seriesId, `${seriesId} attempt did not succeed`);
    }
    if (attempt.rowCount === 0 && !activeSeries.has(seriesId)) {
      throw new IngestSeriesValidationError(
        seriesId,
        `${seriesId} returned empty without active production history`,
      );
    }
  }
}

export async function validateIngestRun(
  db: D1Database,
  runId: string,
  configuredSeries: string[],
): Promise<void> {
  const [attemptRows, activeRows] = await Promise.all([
    // D1 rolls the batch back on a statement error. The intentionally invalid
    // json() converts a fence miss into an error before the transaction commits.
    db.prepare(
      `SELECT series_id, status, row_count
       FROM ingest_series_attempts WHERE run_id = ?`
    ).bind(runId).all<{ series_id: string; status: IngestSeriesAttempt['status']; row_count: number }>(),
    db.prepare('SELECT DISTINCT series_id FROM observations').all<{ series_id: string }>(),
  ]);
  const attempts = (attemptRows.results ?? []).map(row => ({
    seriesId: row.series_id,
    status: row.status,
    rowCount: row.row_count,
  }));
  validateSeriesAttempts(
    configuredSeries,
    attempts,
    new Set((activeRows.results ?? []).map(row => row.series_id)),
  );
}

export async function activateIngestRun(
  db: D1Database,
  runId: string,
  completedAt: string,
): Promise<void> {
  requireIsoTimestamp(completedAt, 'ingest completedAt');
  const results = await db.batch([
    db.prepare(
      `SELECT CASE WHEN NOT EXISTS (
         SELECT 1 FROM staging_observations_pit staged
         JOIN observations_pit existing
           ON existing.series_id=staged.series_id
          AND existing.observation_date=staged.observation_date
          AND existing.vintage_date=staged.vintage_date
         WHERE staged.run_id=? AND existing.checksum<>staged.checksum
       ) THEN 1 ELSE json('conflicting append-only PIT observation') END AS pit_conflict`
    ).bind(runId),
    db.prepare(
      `INSERT INTO observations_pit
       (series_id,observation_date,vintage_date,released_at,fetched_at,tradable_at,source,
        checksum,data_run_id,release_time_status,value)
       SELECT staged.series_id,staged.observation_date,staged.vintage_date,staged.released_at,
              staged.fetched_at,staged.tradable_at,staged.source,staged.checksum,staged.run_id,
              staged.release_time_status,staged.value
       FROM staging_observations_pit staged
       WHERE staged.run_id=?
         AND EXISTS (SELECT 1 FROM ingest_runs target WHERE target.run_id=? AND target.state='RUNNING')
         AND EXISTS (SELECT 1 FROM ingest_lock lease WHERE lease.lock_name='fred_ingest'
           AND lease.owner_run_id=? AND unixepoch(lease.expires_at)>unixepoch('now'))
       ON CONFLICT(series_id,observation_date,vintage_date) DO NOTHING`
    ).bind(runId, runId, runId),
    // Keep the assertion inside the batch: inspecting meta.changes afterward
    // would be too late to roll back success metadata written earlier.
    db.prepare(
      `INSERT INTO observations (series_id, date, value)
       SELECT staged.series_id, staged.date, staged.value FROM staging_observations staged
       WHERE staged.run_id = ?
         AND EXISTS (
           SELECT 1 FROM ingest_runs target
           WHERE target.run_id = ? AND target.state = 'RUNNING'
         )
         AND EXISTS (
           SELECT 1 FROM ingest_lock lease
           WHERE lease.lock_name = 'fred_ingest' AND lease.owner_run_id = ?
             AND unixepoch(lease.expires_at) > unixepoch('now')
         )
       ON CONFLICT(series_id, date) DO UPDATE SET value = excluded.value`
    ).bind(runId, runId, runId),
    db.prepare(
      `SELECT CASE WHEN NOT EXISTS (
         SELECT 1 FROM observations active
         WHERE active.series_id IN ('SP500','VIXCLS','SOFR')
           AND EXISTS (SELECT 1 FROM observations_pit any_raw
             WHERE any_raw.series_id=active.series_id
               AND any_raw.observation_date=active.date)
           AND NOT EXISTS (
             SELECT 1 FROM observations_pit latest
             WHERE latest.series_id=active.series_id
               AND latest.observation_date=active.date
               AND latest.value=active.value
               AND latest.vintage_date=(
                 SELECT MAX(candidate.vintage_date) FROM observations_pit candidate
                 WHERE candidate.series_id=active.series_id
                   AND candidate.observation_date=active.date)
           )
       ) THEN 1 ELSE json('active observation/latest PIT vintage mismatch') END AS pit_active_match`
    ),
    // A single database clock value identifies the atomic revision set. D1
    // exposes db.batch() transactionally, so readers observe either none or all
    // rows carrying this instant; no application clock participates.
    db.prepare(
      `UPDATE ingest_runs
       SET activated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
       WHERE run_id=? AND state='RUNNING'
         AND EXISTS (SELECT 1 FROM ingest_lock lease
           WHERE lease.lock_name='fred_ingest' AND lease.owner_run_id=?
             AND unixepoch(lease.expires_at)>unixepoch('now'))`
    ).bind(runId, runId),
    db.prepare(
      `INSERT INTO market_prices_daily
         (symbol,date,close,adjusted_close,source,fetched_at,data_run_id,
          activation_run_id,activated_at,provenance_status)
       SELECT CASE active.series_id WHEN 'SP500' THEN 'SPX' ELSE 'VIX' END,
              active.date,active.value,active.value,
              COALESCE(provenance.source,'FRED:' || active.series_id),
              COALESCE(provenance.fetched_at,
                (SELECT attempt.completed_at FROM ingest_series_attempts attempt
                 WHERE attempt.run_id=? AND attempt.series_id=active.series_id
                   AND attempt.status='SUCCEEDED'),?),
              provenance.data_run_id,target.run_id,target.activated_at,
              CASE WHEN provenance.series_id IS NULL THEN 'LEGACY_NO_PIT'
                   ELSE 'PIT_RAW' END
       FROM observations active
       JOIN staging_observations staged
         ON staged.run_id=? AND staged.series_id=active.series_id AND staged.date=active.date
       JOIN ingest_runs target
         ON target.run_id=? AND target.state='RUNNING' AND target.activated_at IS NOT NULL
       LEFT JOIN observations_pit provenance
         ON provenance.series_id=active.series_id
        AND provenance.observation_date=active.date
        AND provenance.value=active.value
        AND provenance.vintage_date=(
          SELECT MAX(candidate.vintage_date) FROM observations_pit candidate
          WHERE candidate.series_id=active.series_id
            AND candidate.observation_date=active.date
       )
       WHERE active.series_id IN ('SP500','VIXCLS')
         AND EXISTS (SELECT 1 FROM ingest_lock lease
           WHERE lease.lock_name='fred_ingest' AND lease.owner_run_id=?
             AND unixepoch(lease.expires_at)>unixepoch('now'))
         AND NOT EXISTS (
           SELECT 1 FROM market_prices_daily prior
           WHERE prior.symbol=CASE active.series_id WHEN 'SP500' THEN 'SPX' ELSE 'VIX' END
             AND prior.date=active.date
             AND NOT EXISTS (
               SELECT 1 FROM market_prices_daily newer
               WHERE newer.symbol=prior.symbol AND newer.date=prior.date
                 AND (julianday(newer.activated_at)>julianday(prior.activated_at)
                   OR (julianday(newer.activated_at)=julianday(prior.activated_at)
                     AND newer.activation_run_id>prior.activation_run_id))
             )
             AND prior.close=active.value AND prior.adjusted_close=active.value
             AND prior.provenance_status=CASE WHEN provenance.series_id IS NULL
                   THEN 'LEGACY_NO_PIT' ELSE 'PIT_RAW' END
             AND (provenance.series_id IS NULL OR (
               prior.source=provenance.source
               AND julianday(prior.fetched_at)=julianday(provenance.fetched_at)
               AND prior.data_run_id IS provenance.data_run_id
             ))
         )
       ON CONFLICT(symbol,date,activation_run_id) DO NOTHING`
    ).bind(runId, completedAt, runId, runId, runId),
    db.prepare(
      `INSERT INTO cash_rates_daily
         (rate_id,date,rate,source,fetched_at,data_run_id,
          activation_run_id,activated_at,provenance_status)
       SELECT 'SOFR',active.date,active.value,
              COALESCE(provenance.source,'FRED:SOFR'),
              COALESCE(provenance.fetched_at,
                (SELECT attempt.completed_at FROM ingest_series_attempts attempt
                 WHERE attempt.run_id=? AND attempt.series_id=active.series_id
                   AND attempt.status='SUCCEEDED'),?),
              provenance.data_run_id,target.run_id,target.activated_at,
              CASE WHEN provenance.series_id IS NULL THEN 'LEGACY_NO_PIT'
                   ELSE 'PIT_RAW' END
       FROM observations active
       JOIN staging_observations staged
         ON staged.run_id=? AND staged.series_id=active.series_id AND staged.date=active.date
       JOIN ingest_runs target
         ON target.run_id=? AND target.state='RUNNING' AND target.activated_at IS NOT NULL
       LEFT JOIN observations_pit provenance
         ON provenance.series_id=active.series_id
        AND provenance.observation_date=active.date
        AND provenance.value=active.value
        AND provenance.vintage_date=(
          SELECT MAX(candidate.vintage_date) FROM observations_pit candidate
          WHERE candidate.series_id=active.series_id
            AND candidate.observation_date=active.date
       )
       WHERE active.series_id='SOFR'
         AND EXISTS (SELECT 1 FROM ingest_lock lease
           WHERE lease.lock_name='fred_ingest' AND lease.owner_run_id=?
             AND unixepoch(lease.expires_at)>unixepoch('now'))
         AND NOT EXISTS (
           SELECT 1 FROM cash_rates_daily prior
           WHERE prior.rate_id='SOFR' AND prior.date=active.date
             AND NOT EXISTS (
               SELECT 1 FROM cash_rates_daily newer
               WHERE newer.rate_id=prior.rate_id AND newer.date=prior.date
                 AND (julianday(newer.activated_at)>julianday(prior.activated_at)
                   OR (julianday(newer.activated_at)=julianday(prior.activated_at)
                     AND newer.activation_run_id>prior.activation_run_id))
             )
             AND prior.rate=active.value
             AND prior.provenance_status=CASE WHEN provenance.series_id IS NULL
                   THEN 'LEGACY_NO_PIT' ELSE 'PIT_RAW' END
             AND (provenance.series_id IS NULL OR (
               prior.source=provenance.source
               AND julianday(prior.fetched_at)=julianday(provenance.fetched_at)
               AND prior.data_run_id IS provenance.data_run_id
             ))
         )
       ON CONFLICT(rate_id,date,activation_run_id) DO NOTHING`
    ).bind(runId, completedAt, runId, runId, runId),
    db.prepare(
      `UPDATE ingest_runs SET state = 'SUPERSEDED'
       WHERE state = 'ACTIVE' AND run_id <> ?
         AND EXISTS (
           SELECT 1 FROM ingest_runs target
           WHERE target.run_id = ? AND target.state = 'RUNNING'
         )
         AND EXISTS (
           SELECT 1 FROM ingest_lock lease
           WHERE lease.lock_name = 'fred_ingest' AND lease.owner_run_id = ?
             AND unixepoch(lease.expires_at) > unixepoch('now')
         )`
    ).bind(runId, runId, runId),
    db.prepare(
      `UPDATE ingest_runs SET
         state = 'ACTIVE', completed_at = ?,
         snapshot_state = 'PENDING', snapshot_completed_at = NULL,
         snapshot_error = NULL, snapshot_count = 0,
         row_count = (SELECT COUNT(*) FROM staging_observations WHERE run_id = ?),
         series_count = (SELECT COUNT(*) FROM ingest_series_attempts
                         WHERE run_id = ? AND status = 'SUCCEEDED')
       WHERE run_id = ? AND state = 'RUNNING'
         AND EXISTS (
           SELECT 1 FROM ingest_lock lease
           WHERE lease.lock_name = 'fred_ingest' AND lease.owner_run_id = ?
             AND unixepoch(lease.expires_at) > unixepoch('now')
         )`
    ).bind(completedAt, runId, runId, runId, runId),
    db.prepare(
      `SELECT CASE WHEN
         EXISTS (
           SELECT 1 FROM ingest_lock lease
           WHERE lease.lock_name = 'fred_ingest' AND lease.owner_run_id = ?
             AND unixepoch(lease.expires_at) > unixepoch('now')
         )
         AND EXISTS (
           SELECT 1 FROM ingest_runs target
           WHERE target.run_id = ? AND target.state = 'ACTIVE'
         )
       THEN 1 ELSE json('ingest activation fence rejected') END AS fence`
    ).bind(runId, runId),
  ]).catch(error => {
    throw new Error(
      `ingest run ${runId} activation lease/state fence rejected; target must be RUNNING: ${String((error as any)?.message ?? error)}`,
    );
  });
  if (Number((results[8]?.meta as any)?.changes ?? 0) !== 1) {
    throw new Error(`ingest run ${runId} must be RUNNING before activation`);
  }
}

export async function loadPitObservations(
  db: D1Database,
  releaseResolutionAt: string,
): Promise<PitObservation[]> {
  requireIsoTimestamp(releaseResolutionAt, 'release resolutionAt');
  await validateOverrideTimings(db, releaseResolutionAt);
  await validateStoredPitTimings(db);
  const rows = await db.prepare(
    `SELECT raw.series_id,raw.observation_date,raw.vintage_date,
            COALESCE(overrides.released_at,raw.released_at) AS released_at,
            raw.fetched_at,
            COALESCE(overrides.tradable_at,raw.tradable_at) AS tradable_at,
            raw.source,raw.checksum,
            CASE WHEN overrides.series_id IS NOT NULL THEN 'OVERRIDE'
                 ELSE raw.release_time_status END AS release_time_status,
            overrides.released_at AS override_released_at,
            overrides.tradable_at AS override_tradable_at,
            raw.value
     FROM observations_pit raw
     LEFT JOIN release_calendar_overrides overrides
       ON overrides.series_id=raw.series_id AND overrides.vintage_date=raw.vintage_date
      AND overrides.created_at=(
        SELECT candidate.created_at FROM release_calendar_overrides candidate
        WHERE candidate.series_id=raw.series_id AND candidate.vintage_date=raw.vintage_date
          AND julianday(candidate.created_at)<=julianday(?)
        ORDER BY julianday(candidate.created_at) DESC LIMIT 1
      )
     WHERE julianday(raw.fetched_at)<=julianday(?)
     ORDER BY julianday(COALESCE(overrides.released_at,raw.released_at)),
              raw.series_id,raw.observation_date,raw.vintage_date`,
  ).bind(releaseResolutionAt, releaseResolutionAt).all<any>();
  return (rows.results ?? []).map(row => {
    if (row.override_released_at != null || row.override_tradable_at != null) {
      validateReleaseOverride({
        releasedAt: row.override_released_at,
        tradableAt: row.override_tradable_at,
      });
    }
    isoTimestampMs(row.fetched_at, 'raw fetchedAt');
    validateReleaseOverride({ releasedAt: row.released_at, tradableAt: row.tradable_at });
    return {
      seriesId: row.series_id, observationDate: row.observation_date, vintageDate: row.vintage_date,
      releasedAt: row.released_at, fetchedAt: row.fetched_at, tradableAt: row.tradable_at,
      source: row.source, checksum: row.checksum, releaseTimeStatus: row.release_time_status,
      value: row.value,
    } as PitObservation;
  });
}

export async function officialPitDecisionEvents(
  db: D1Database,
  releaseResolutionAt: string,
): Promise<PitDecisionEvent[]> {
  requireIsoTimestamp(releaseResolutionAt, 'release resolutionAt');
  await validateOverrideTimings(db, releaseResolutionAt);
  await validateStoredPitTimings(db);
  const rows = await db.prepare(
    `WITH ranked AS (
       SELECT raw.observation_date,
              COALESCE(overrides.released_at,raw.released_at) AS released_at,
              COALESCE(overrides.tradable_at,raw.tradable_at) AS tradable_at,
              overrides.released_at AS override_released_at,
              overrides.tradable_at AS override_tradable_at,
              ROW_NUMBER() OVER (
                PARTITION BY raw.observation_date
                ORDER BY raw.vintage_date,julianday(COALESCE(overrides.released_at,raw.released_at))
              ) AS n
       FROM observations_pit raw
       LEFT JOIN release_calendar_overrides overrides
         ON overrides.series_id=raw.series_id AND overrides.vintage_date=raw.vintage_date
        AND overrides.created_at=(
          SELECT candidate.created_at FROM release_calendar_overrides candidate
          WHERE candidate.series_id=raw.series_id AND candidate.vintage_date=raw.vintage_date
            AND julianday(candidate.created_at)<=julianday(?)
          ORDER BY julianday(candidate.created_at) DESC LIMIT 1
        )
       WHERE raw.series_id='WALCL'
         AND julianday(raw.fetched_at)<=julianday(?)
     )
     SELECT observation_date,released_at,tradable_at,override_released_at,override_tradable_at
     FROM ranked WHERE n=1 AND julianday(released_at)<=julianday(?)
     ORDER BY julianday(released_at)`,
  ).bind(releaseResolutionAt, releaseResolutionAt, releaseResolutionAt).all<{
    observation_date: string; released_at: string; tradable_at: string;
    override_released_at: string | null; override_tradable_at: string | null;
  }>();
  return (rows.results ?? []).map(row => {
    if (row.override_released_at != null || row.override_tradable_at != null) {
      validateReleaseOverride({
        releasedAt: row.override_released_at!, tradableAt: row.override_tradable_at!,
      });
    }
    validateReleaseOverride({ releasedAt: row.released_at, tradableAt: row.tradable_at });
    return { modelDate: row.observation_date, decisionAt: row.released_at, tradableAt: row.tradable_at };
  });
}

function fencedMetaStatement(
  db: D1Database,
  runId: string,
  key: string,
  value: string,
): D1PreparedStatement {
  return db.prepare(
    `INSERT INTO meta (key, value)
     SELECT ?, ?
     WHERE EXISTS (
       SELECT 1 FROM ingest_lock lease
       WHERE lease.lock_name = 'fred_ingest' AND lease.owner_run_id = ?
         AND unixepoch(lease.expires_at) > unixepoch('now')
     )
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).bind(key, value, runId);
}

export async function setIngestMeta(
  db: D1Database,
  runId: string,
  key: string,
  value: string,
): Promise<void> {
  const result = await fencedMetaStatement(db, runId, key, value).run();
  if (Number((result.meta as any)?.changes ?? 0) !== 1) {
    throw new Error(`ingest lease fence rejected meta write ${key} for run ${runId}`);
  }
}

export async function completeIngestSuccess(
  db: D1Database,
  runId: string,
  snapshotCount: number,
  completedAt: string,
  metaEntries: Array<[string, string]>,
): Promise<void> {
  const statements = metaEntries.map(([key, value]) =>
    fencedMetaStatement(db, runId, key, value));
  statements.push(
    db.prepare(
      `UPDATE ingest_runs SET
         snapshot_state = 'SUCCEEDED', snapshot_completed_at = ?,
         snapshot_error = NULL, snapshot_count = ?
       WHERE run_id = ? AND state = 'ACTIVE' AND snapshot_state = 'PENDING'
         AND EXISTS (
           SELECT 1 FROM ingest_lock lease
           WHERE lease.lock_name = 'fred_ingest' AND lease.owner_run_id = ?
             AND unixepoch(lease.expires_at) > unixepoch('now')
         )`
    ).bind(completedAt, snapshotCount, runId, runId),
    db.prepare(
      `SELECT CASE WHEN
         EXISTS (
           SELECT 1 FROM ingest_runs target
           WHERE target.run_id = ? AND target.state = 'ACTIVE'
             AND target.snapshot_state = 'SUCCEEDED'
         )
         AND EXISTS (
           SELECT 1 FROM ingest_lock lease
           WHERE lease.lock_name = 'fred_ingest' AND lease.owner_run_id = ?
             AND unixepoch(lease.expires_at) > unixepoch('now')
         )
       THEN 1 ELSE json('ingest success publication fence rejected') END AS fence`
    ).bind(runId, runId),
  );
  await db.batch(statements).catch(error => {
    throw new Error(
      `ingest success publication lease fence rejected for run ${runId}: ${String((error as any)?.message ?? error)}`,
    );
  });
}

export async function failIngestSnapshots(
  db: D1Database,
  runId: string,
  failure: Pick<IngestFailure, 'step' | 'error'> & { snapshotCount: number },
  completedAt: string,
): Promise<void> {
  const result = await db.prepare(
    `UPDATE ingest_runs SET
       snapshot_state = 'FAILED', snapshot_completed_at = ?, snapshot_error = ?, snapshot_count = ?
     WHERE run_id = ? AND state IN ('ACTIVE', 'SUPERSEDED') AND snapshot_state = 'PENDING'
       AND EXISTS (
         SELECT 1 FROM ingest_lock lease
         WHERE lease.lock_name = 'fred_ingest' AND lease.owner_run_id = ?
           AND unixepoch(lease.expires_at) > unixepoch('now')
       )`
  ).bind(completedAt, `${failure.step}: ${failure.error}`, failure.snapshotCount, runId, runId).run();
  if (Number((result.meta as any)?.changes ?? 0) !== 1) {
    throw new Error(`ingest run ${runId} has no pending snapshot outcome to fail`);
  }
}

export async function failIngestRun(
  db: D1Database,
  runId: string,
  failure: IngestFailure,
  completedAt = new Date().toISOString(),
): Promise<void> {
  await db.prepare(
    `UPDATE ingest_runs SET
       state = 'FAILED', completed_at = ?, failed_step = ?, failed_series = ?, error = ?,
       snapshot_state = 'FAILED', snapshot_completed_at = ?, snapshot_error = ?,
       row_count = (SELECT COUNT(*) FROM staging_observations WHERE run_id = ?),
       series_count = (SELECT COUNT(*) FROM ingest_series_attempts
                       WHERE run_id = ? AND status = 'SUCCEEDED')
     WHERE run_id = ? AND state = 'RUNNING'`
  ).bind(
    completedAt, failure.step, failure.seriesId ?? null, failure.error,
    completedAt, `not activated: ${failure.error}`,
    runId, runId, runId,
  ).run();
}

export async function ingestRunSummary(db: D1Database): Promise<{
  active: Record<string, unknown> | null;
  latestFailed: Record<string, unknown> | null;
}> {
  const [active, latestFailed] = await Promise.all([
    db.prepare(
      `SELECT run_id, state, mode, started_at, completed_at, row_count, series_count,
              snapshot_state, snapshot_completed_at, snapshot_error, snapshot_count
       FROM ingest_runs WHERE state = 'ACTIVE' LIMIT 1`
    ).first<Record<string, unknown>>(),
    db.prepare(
      `SELECT run_id, state, mode, started_at, completed_at, failed_step, failed_series,
              error, row_count, series_count,
              snapshot_state, snapshot_completed_at, snapshot_error, snapshot_count
       FROM ingest_runs WHERE state = 'FAILED' ORDER BY started_at DESC LIMIT 1`
    ).first<Record<string, unknown>>(),
  ]);
  return { active: active ?? null, latestFailed: latestFailed ?? null };
}

export async function loadSeriesMap(db: D1Database, from = '1900-01-01'): Promise<SeriesMap> {
  const rs = await db.prepare(
    'SELECT series_id, date, value FROM observations WHERE date >= ? ORDER BY series_id, date'
  ).bind(from).all<{ series_id: string; date: string; value: number }>();
  const m: SeriesMap = {};
  for (const id of SERIES_IDS) m[id] = [];
  for (const r of rs.results ?? []) (m[r.series_id] ??= []).push({ date: r.date, value: r.value });
  return m;
}

const SNAPSHOT_COLUMNS = `walcl, tga, rrp, repo, netliq, netliq_trend, sofr_iorb, hy_oas, dgs10,
       dxy_eod, vix_eod, qe_qt_regime, netliq_dir, verdict, score, p0, p1, p2, p3, spx, reason, factors_json, coverage,
       decision_status, factor_quality_json, freshness_json`;

const SNAPSHOT_UPDATE = `walcl=excluded.walcl, tga=excluded.tga, rrp=excluded.rrp, repo=excluded.repo,
       netliq=excluded.netliq, netliq_trend=excluded.netliq_trend, sofr_iorb=excluded.sofr_iorb,
       hy_oas=excluded.hy_oas, dgs10=excluded.dgs10, dxy_eod=excluded.dxy_eod, vix_eod=excluded.vix_eod,
       qe_qt_regime=excluded.qe_qt_regime, netliq_dir=excluded.netliq_dir, verdict=excluded.verdict,
       score=excluded.score, p0=excluded.p0, p1=excluded.p1, p2=excluded.p2, p3=excluded.p3,
       spx=excluded.spx, reason=excluded.reason, factors_json=excluded.factors_json,
       coverage=excluded.coverage, decision_status=excluded.decision_status,
       factor_quality_json=excluded.factor_quality_json, freshness_json=excluded.freshness_json`;

function snapshotValues(s: Snapshot, spx: number | null): unknown[] {
  return [
    s.walcl, s.tga, s.rrp, s.repo, s.netliq, s.netliqTrend, s.sofrIorb, s.hyOas, s.dgs10,
    s.dxy, s.vix, s.bsImpulse, s.netliqDir, s.verdict, s.score,
    s.p0 ? 1 : 0, s.p1 ? 1 : 0, s.p2 ? 1 : 0, s.p3 ? 1 : 0,
    spx, s.reason, JSON.stringify(s.factors), s.coverage,
    s.decisionStatus, JSON.stringify(s.factorResults), JSON.stringify(s.freshness),
  ];
}

export function decisionWeek(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  const daysFromMonday = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - daysFromMonday);
  return d.toISOString().slice(0, 10);
}

export interface SnapshotProvenance {
  dataRunId: string;
  dataCutoff: string | null;
  decisionAt: string;
  tradableAt: string;
  releaseResolutionAt: string;
  inputs: SnapshotInput[];
}

function validateSnapshotInputs(
  inputs: SnapshotInput[],
  decisionAt: string,
  snapshotDate: string,
  provenanceTradableAt: string,
): void {
  if (inputs.length !== SERIES_IDS.length) throw new Error('official PIT manifest is incomplete');
  const bySeries = new Map(inputs.map(input => [input.seriesId, input]));
  if (bySeries.size !== SERIES_IDS.length || SERIES_IDS.some(id => !bySeries.has(id))) {
    throw new Error('official PIT manifest must contain every configured series exactly once');
  }
  for (const input of inputs) {
    if (input.inputStatus === 'AVAILABLE'
      && compareIsoTimestamps(input.releasedAt, decisionAt) > 0) {
      throw new Error(`future PIT vintage in official manifest: ${input.seriesId}`);
    }
    if (input.inputStatus === 'AVAILABLE' && input.observationDate > snapshotDate) {
      throw new Error(`future observation date in official manifest: ${input.seriesId}`);
    }
    if (input.inputStatus === 'AVAILABLE'
      && compareIsoTimestamps(input.tradableAt, provenanceTradableAt) > 0) {
      throw new Error(`PIT input is not tradable by official snapshot time: ${input.seriesId}`);
    }
  }
}

export async function upsertOfficialSnapshot(
  db: D1Database,
  runId: string,
  s: Snapshot,
  spx: number | null,
  provenance?: SnapshotProvenance,
  suppliedIdentity?: ModelIdentity,
): Promise<'INSERTED' | 'UPGRADED_LEGACY' | 'FROZEN' | void> {
  const identity = suppliedIdentity ?? await resolveModelIdentity({});
  if (provenance) {
    if (provenance.dataRunId !== runId) throw new Error('official snapshot provenance run mismatch');
    requireIsoTimestamp(provenance.releaseResolutionAt, 'release resolutionAt');
    validateSnapshotInputs(provenance.inputs, provenance.decisionAt, s.date, provenance.tradableAt);
    const week = decisionWeek(s.date);
    const existing = await db.prepare(
      'SELECT pit_status,data_run_id FROM model_snapshot_weekly WHERE decision_week=?',
    ).bind(week).first<{ pit_status: string; data_run_id: string | null }>();
    if (existing?.pit_status === 'PIT') return 'FROZEN';

    const placeholders = Array.from({ length: 37 }, () => '?').join(',');
    const statements: D1PreparedStatement[] = [db.prepare(
      `INSERT INTO model_snapshot_weekly
       (date,decision_week,${SNAPSHOT_COLUMNS},data_run_id,data_cutoff,decision_at,tradable_at,release_resolution_at,pit_status,
        model_version,config_hash,code_commit_sha,created_at,recorded_at)
       SELECT ${placeholders},strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now')
       WHERE EXISTS (SELECT 1 FROM ingest_lock lease WHERE lease.lock_name='fred_ingest'
         AND lease.owner_run_id=? AND unixepoch(lease.expires_at)>unixepoch('now'))
       ON CONFLICT(decision_week) DO UPDATE SET date=excluded.date,${SNAPSHOT_UPDATE},
         data_run_id=excluded.data_run_id,data_cutoff=excluded.data_cutoff,
         decision_at=excluded.decision_at,tradable_at=excluded.tradable_at,
         release_resolution_at=excluded.release_resolution_at,pit_status='PIT',
         model_version=excluded.model_version,config_hash=excluded.config_hash,
         code_commit_sha=excluded.code_commit_sha,created_at=excluded.created_at,
         recorded_at=excluded.recorded_at
       WHERE model_snapshot_weekly.pit_status='LEGACY_NON_PIT'`,
    ).bind(
      s.date, week, ...snapshotValues(s, spx), provenance.dataRunId, provenance.dataCutoff,
      provenance.decisionAt, provenance.tradableAt, provenance.releaseResolutionAt, 'PIT',
      identity.modelVersion, identity.configHash, identity.codeCommitSha, runId,
    )];
    for (const input of provenance.inputs) {
      const available = input.inputStatus === 'AVAILABLE';
      statements.push(db.prepare(
        `INSERT INTO snapshot_inputs
         (snapshot_channel,decision_week,snapshot_date,data_run_id,series_id,input_status,
          observation_date,vintage_date,released_at,tradable_at,value,source,checksum)
         SELECT 'OFFICIAL',?,?,?,?,?,?,?,?,?,?,?,?
         WHERE EXISTS (SELECT 1 FROM ingest_lock lease WHERE lease.lock_name='fred_ingest'
           AND lease.owner_run_id=? AND unixepoch(lease.expires_at)>unixepoch('now'))
           AND EXISTS (SELECT 1 FROM model_snapshot_weekly snapshot
             WHERE snapshot.decision_week=? AND snapshot.pit_status='PIT' AND snapshot.data_run_id=?)`,
      ).bind(
        week, s.date, provenance.dataRunId, input.seriesId, input.inputStatus,
        available ? input.observationDate : null, available ? input.vintageDate : null,
        available ? input.releasedAt : null, available ? input.tradableAt : null,
        available ? input.value : null, available ? input.source : null,
        available ? input.checksum : null, runId, week, provenance.dataRunId,
      ));
    }
    statements.push(db.prepare(
      `SELECT CASE WHEN
       EXISTS (SELECT 1 FROM model_snapshot_weekly snapshot
           WHERE snapshot.decision_week=? AND snapshot.pit_status='PIT' AND snapshot.data_run_id=?
             AND snapshot.release_resolution_at=?)
         AND (SELECT COUNT(*) FROM snapshot_inputs
              WHERE snapshot_channel='OFFICIAL' AND decision_week=?)=?
         AND EXISTS (SELECT 1 FROM ingest_lock lease WHERE lease.lock_name='fred_ingest'
           AND lease.owner_run_id=? AND unixepoch(lease.expires_at)>unixepoch('now'))
       THEN 1 ELSE json('official PIT snapshot manifest assertion failed') END AS manifest_fence`,
    ).bind(
      week, provenance.dataRunId, provenance.releaseResolutionAt,
      week, SERIES_IDS.length, runId,
    ));
    await db.batch(statements).catch(error => {
      throw new Error(`official PIT snapshot atomic write rejected: ${String((error as any)?.message ?? error)}`);
    });
    return existing ? 'UPGRADED_LEGACY' : 'INSERTED';
  }
  const week = decisionWeek(s.date);
  const placeholders = Array.from({ length: 31 }, () => '?').join(',');
  const result = await db.prepare(
    `INSERT INTO model_snapshot_weekly (date, decision_week, ${SNAPSHOT_COLUMNS},
       model_version,config_hash,code_commit_sha,created_at,recorded_at)
     SELECT ${placeholders},strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now')
     WHERE EXISTS (
       SELECT 1 FROM ingest_lock lease
       WHERE lease.lock_name = 'fred_ingest' AND lease.owner_run_id = ?
         AND unixepoch(lease.expires_at) > unixepoch('now')
     )
     ON CONFLICT(decision_week) DO UPDATE SET date=excluded.date,
       ${SNAPSHOT_UPDATE},model_version=excluded.model_version,config_hash=excluded.config_hash,
       code_commit_sha=excluded.code_commit_sha,created_at=excluded.created_at,recorded_at=excluded.recorded_at
     WHERE model_snapshot_weekly.pit_status<>'PIT'`
  ).bind(s.date, week, ...snapshotValues(s, spx),
    identity.modelVersion, identity.configHash, identity.codeCommitSha, runId).run();
  if (Number((result.meta as any)?.changes ?? 0) !== 1) {
    const frozen = await db.prepare(
      "SELECT 1 AS frozen FROM model_snapshot_weekly WHERE decision_week=? AND pit_status='PIT'",
    ).bind(week).first();
    if (frozen) return 'FROZEN';
    throw new Error(`ingest lease fence rejected official snapshot write for run ${runId}`);
  }
}

export async function upsertNowcastSnapshot(
  db: D1Database,
  runId: string,
  s: Snapshot,
  spx: number | null,
  provenance?: Omit<SnapshotProvenance, 'inputs'>,
  suppliedIdentity?: ModelIdentity,
): Promise<void> {
  const identity = suppliedIdentity ?? await resolveModelIdentity({});
  if (provenance) {
    if (provenance.dataRunId !== runId) throw new Error('nowcast snapshot provenance run mismatch');
    requireIsoTimestamp(provenance.releaseResolutionAt, 'release resolutionAt');
    const placeholders = Array.from({ length: 37 }, () => '?').join(',');
    const result = await db.prepare(
      `INSERT INTO nowcast_snapshot_daily
       (date,channel_status,${SNAPSHOT_COLUMNS},data_run_id,data_cutoff,decision_at,tradable_at,release_resolution_at,pit_status,
        model_version,config_hash,code_commit_sha,created_at)
       SELECT ${placeholders},strftime('%Y-%m-%dT%H:%M:%fZ','now')
       WHERE EXISTS (SELECT 1 FROM ingest_lock lease WHERE lease.lock_name='fred_ingest'
         AND lease.owner_run_id=? AND unixepoch(lease.expires_at)>unixepoch('now'))
       ON CONFLICT(date) DO UPDATE SET channel_status='PROVISIONAL',${SNAPSHOT_UPDATE},
         data_run_id=excluded.data_run_id,data_cutoff=excluded.data_cutoff,
         decision_at=excluded.decision_at,tradable_at=excluded.tradable_at,
         release_resolution_at=excluded.release_resolution_at,pit_status='PIT',
         model_version=excluded.model_version,config_hash=excluded.config_hash,
         code_commit_sha=excluded.code_commit_sha,created_at=excluded.created_at`,
    ).bind(
      s.date, 'PROVISIONAL', ...snapshotValues(s, spx), provenance.dataRunId,
      provenance.dataCutoff, provenance.decisionAt, provenance.tradableAt,
      provenance.releaseResolutionAt, 'PIT', identity.modelVersion, identity.configHash,
      identity.codeCommitSha, runId,
    ).run();
    if (Number((result.meta as any)?.changes ?? 0) !== 1) {
      throw new Error(`ingest lease fence rejected PIT nowcast snapshot write for run ${runId}`);
    }
    return;
  }
  const placeholders = Array.from({ length: 31 }, () => '?').join(',');
  const result = await db.prepare(
    `INSERT INTO nowcast_snapshot_daily (date, channel_status, ${SNAPSHOT_COLUMNS},
       model_version,config_hash,code_commit_sha,created_at)
     SELECT ${placeholders},strftime('%Y-%m-%dT%H:%M:%fZ','now')
     WHERE EXISTS (
       SELECT 1 FROM ingest_lock lease
       WHERE lease.lock_name = 'fred_ingest' AND lease.owner_run_id = ?
         AND unixepoch(lease.expires_at) > unixepoch('now')
     )
     ON CONFLICT(date) DO UPDATE SET channel_status='PROVISIONAL',
       ${SNAPSHOT_UPDATE},model_version=excluded.model_version,config_hash=excluded.config_hash,
       code_commit_sha=excluded.code_commit_sha,created_at=excluded.created_at`
  ).bind(s.date, 'PROVISIONAL', ...snapshotValues(s, spx),
    identity.modelVersion, identity.configHash, identity.codeCommitSha, runId).run();
  if (Number((result.meta as any)?.changes ?? 0) !== 1) {
    throw new Error(`ingest lease fence rejected nowcast snapshot write for run ${runId}`);
  }
}

export async function latestOfficialSnapshot(db: D1Database) {
  return db.prepare('SELECT * FROM model_snapshot_weekly ORDER BY date DESC LIMIT 1').first();
}

export async function latestNowcastSnapshot(db: D1Database) {
  return db.prepare('SELECT * FROM nowcast_snapshot_daily ORDER BY date DESC LIMIT 1').first();
}

export async function officialSnapshotBefore(
  db: D1Database,
  date: string,
): Promise<{ date: string; verdict: Snapshot['verdict'] } | null> {
  return db.prepare("SELECT * FROM model_snapshot_weekly WHERE date < ? AND decision_status = 'OK' AND verdict IS NOT NULL ORDER BY date DESC LIMIT 1")
    .bind(date).first<{ date: string; verdict: Snapshot['verdict'] }>();
}

export async function officialVerdictAnchors(
  db: D1Database,
  from: string,
  to: string,
): Promise<Array<{ date: string; verdict: Verdict }>> {
  const rs = await db.prepare(
    "SELECT date, verdict FROM model_snapshot_weekly WHERE date BETWEEN ? AND ? AND decision_status = 'OK' AND verdict IS NOT NULL ORDER BY date",
  ).bind(from, to).all<{ date: string; verdict: Verdict }>();
  return rs.results ?? [];
}

export async function officialSnapshotHistory(db: D1Database, from: string, to: string) {
  const rs = await db.prepare(
    `SELECT date, netliq, walcl,
       CASE WHEN decision_status = 'OK' THEN score ELSE NULL END AS score,
       CASE WHEN decision_status = 'OK' AND verdict IS NOT NULL THEN verdict ELSE NULL END AS verdict,
       qe_qt_regime, spx, decision_status
     FROM model_snapshot_weekly WHERE date BETWEEN ? AND ? ORDER BY date`
  ).bind(from, to).all();
  return rs.results ?? [];
}

export async function exportOfficialSnapshots(db: D1Database, from: string, to: string) {
  const rs = await db.prepare(
    `SELECT date,score,verdict,decision_status,netliq,spx,reason,
            model_version,config_hash,code_commit_sha,data_run_id,data_cutoff,decision_at,created_at
     FROM model_snapshot_weekly WHERE date BETWEEN ? AND ? ORDER BY date`,
  ).bind(from, to).all<Record<string, unknown>>();
  return rs.results ?? [];
}

export async function distinctOfficialSnapshotDates(db: D1Database, lastN: number): Promise<string[]> {
  const rs = await db.prepare('SELECT date FROM model_snapshot_weekly ORDER BY date DESC LIMIT ?')
    .bind(lastN).all<{ date: string }>();
  return (rs.results ?? []).map(r => r.date).reverse();
}

export async function loadBacktestRows(db: D1Database): Promise<any[]> {
  const rs = await db.prepare(
    "SELECT date, score, spx, verdict, factors_json, qe_qt_regime, vix_eod FROM model_snapshot_weekly WHERE decision_status = 'OK' AND spx IS NOT NULL ORDER BY date"
  ).all();
  return rs.results ?? [];
}

export async function loadEventBacktestInputs(
  db: D1Database,
  requestedAsOf?: string,
): Promise<EventBacktestInputs> {
  const clock = await db.prepare(
    `WITH clock AS (SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now') AS db_now)
     SELECT db_now,CASE WHEN ? IS NULL THEN db_now ELSE ? END AS cutoff FROM clock`,
  ).bind(requestedAsOf ?? null, requestedAsOf ?? null)
    .first<{ db_now: string; cutoff: string }>();
  if (!clock) throw new Error('backtest database clock unavailable');
  requireIsoTimestamp(clock.db_now, 'backtest database now');
  try {
    requireIsoTimestamp(clock.cutoff, 'backtest as_of');
  } catch {
    throw new Error('invalid backtest as_of');
  }
  if (compareIsoTimestamps(clock.cutoff, clock.db_now) > 0) {
    throw new Error('future backtest as_of');
  }
  const cutoff = clock.cutoff;
  const [signalRows, marketRows, cashRows] = await Promise.all([
    db.prepare(
      `SELECT date AS signal_date,decision_at,tradable_at,score,verdict,netliq_dir,vix_eod,recorded_at,data_run_id
       FROM model_snapshot_weekly
       WHERE decision_status='OK' AND pit_status='PIT'
         AND decision_at IS NOT NULL AND tradable_at IS NOT NULL AND score IS NOT NULL
         AND recorded_at IS NOT NULL AND julianday(recorded_at)<julianday(?)
       ORDER BY julianday(decision_at),date`,
    ).bind(cutoff).all<{
      signal_date: string; decision_at: string; tradable_at: string; score: number;
      verdict: string | null; netliq_dir: string | null; vix_eod: number | null;
      recorded_at: string; data_run_id: string | null;
    }>(),
    db.prepare(
      `WITH eligible AS (
         SELECT symbol,date,adjusted_close,source,fetched_at,data_run_id,
                activation_run_id,activated_at,provenance_status,
                ROW_NUMBER() OVER (
                  PARTITION BY symbol,date
                  ORDER BY julianday(activated_at) DESC,activation_run_id DESC
                ) AS revision_rank
         FROM market_prices_daily
         WHERE symbol IN ('SPX','VIX') AND julianday(activated_at)<julianday(?)
       )
       SELECT symbol,date,adjusted_close,source,fetched_at,data_run_id,
              activation_run_id,activated_at,provenance_status
       FROM eligible WHERE revision_rank=1 ORDER BY date,symbol`,
    ).bind(cutoff).all<{
      symbol: 'SPX' | 'VIX'; date: string; adjusted_close: number; source: string;
      fetched_at: string; data_run_id: string | null; activation_run_id: string;
      activated_at: string; provenance_status: 'PIT_RAW' | 'SYNTHETIC_BACKFILL' | 'LEGACY_NO_PIT';
    }>(),
    db.prepare(
      `WITH eligible AS (
         SELECT date,rate,source,fetched_at,data_run_id,activation_run_id,
                activated_at,provenance_status,
                ROW_NUMBER() OVER (
                  PARTITION BY rate_id,date
                  ORDER BY julianday(activated_at) DESC,activation_run_id DESC
                ) AS revision_rank
         FROM cash_rates_daily
         WHERE rate_id='SOFR' AND julianday(activated_at)<julianday(?)
       )
       SELECT date,rate,source,fetched_at,data_run_id,activation_run_id,
              activated_at,provenance_status
       FROM eligible WHERE revision_rank=1 ORDER BY date`,
    ).bind(cutoff).all<{
      date: string; rate: number; source: string; fetched_at: string;
      data_run_id: string | null; activation_run_id: string; activated_at: string;
      provenance_status: 'PIT_RAW' | 'SYNTHETIC_BACKFILL' | 'LEGACY_NO_PIT';
    }>(),
  ]);
  const markets = marketRows.results ?? [];
  return {
    asOfCutoff: cutoff,
    signals: (signalRows.results ?? []).map(row => {
      const fieldIssue = officialPortfolioFieldIssue({
        score: row.score, verdict: row.verdict, netliqDir: row.netliq_dir, snapshotVixEod: row.vix_eod,
      });
      const baseSignal = {
        signalDate: row.signal_date,
        decisionAt: row.decision_at,
        tradableAt: row.tradable_at,
        score: row.score,
        verdict: row.verdict,
        netliqDir: row.netliq_dir,
        snapshotVixEod: row.vix_eod,
        recordedAt: row.recorded_at,
        dataRunId: row.data_run_id ?? undefined,
      };
      if (fieldIssue || !isPortfolioVerdict(row.verdict) || !isPortfolioDirection(row.netliq_dir)) {
        return { ...baseSignal, policyIssue: fieldIssue ?? 'invalid official portfolio field' };
      }
      const stressStatus = snapshotVixStressStatus(row.vix_eod);
      const policy = mapPortfolioPolicy({
        score: row.score, verdict: row.verdict, netliqDir: row.netliq_dir, stressStatus,
      });
      return {
        ...baseSignal,
        targetExposure: policy.targetExposure,
        portfolioTier: policy.tier,
        portfolioMethodology: policy.methodology,
        stressMethodology: 'PIT_SNAPSHOT_VIX_PROXY' as const,
      };
    }),
    prices: markets.filter(row => row.symbol === 'SPX').map(row => ({
      date: row.date, adjustedClose: row.adjusted_close, source: row.source,
      fetchedAt: row.fetched_at, dataRunId: row.data_run_id ?? undefined,
      activationRunId: row.activation_run_id, activatedAt: row.activated_at,
      provenanceStatus: row.provenance_status,
    })),
    vix: markets.filter(row => row.symbol === 'VIX').map(row => ({
      date: row.date, value: row.adjusted_close, source: row.source,
      fetchedAt: row.fetched_at, dataRunId: row.data_run_id ?? undefined,
      activationRunId: row.activation_run_id, activatedAt: row.activated_at,
      provenanceStatus: row.provenance_status,
    })),
    cashRates: (cashRows.results ?? []).map(row => ({
      date: row.date, rate: row.rate, source: row.source,
      fetchedAt: row.fetched_at, dataRunId: row.data_run_id ?? undefined,
      activationRunId: row.activation_run_id, activatedAt: row.activated_at,
      provenanceStatus: row.provenance_status,
    })),
  };
}

export async function countOfficialSnapshots(db: D1Database): Promise<number> {
  const row = await db.prepare('SELECT COUNT(*) AS n FROM model_snapshot_weekly').first<{ n: number }>();
  return row?.n ?? 0;
}

export async function officialSnapshotOnOrBefore(db: D1Database, date: string) {
  return db.prepare("SELECT * FROM model_snapshot_weekly WHERE date <= ? AND decision_status = 'OK' ORDER BY date DESC LIMIT 1")
    .bind(date).first();
}

export async function getAllMeta(db: D1Database): Promise<Record<string, string>> {
  const rs = await db.prepare('SELECT key, value FROM meta').all<{ key: string; value: string }>();
  const m: Record<string, string> = {};
  for (const r of rs.results ?? []) m[r.key] = r.value;
  return m;
}
