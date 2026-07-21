import type { Obs, SeriesMap, Snapshot, Verdict } from './metrics';
import { SERIES_IDS } from './config';

export async function maxObsDate(db: D1Database, seriesId: string): Promise<string | null> {
  const row = await db.prepare('SELECT MAX(date) AS d FROM observations WHERE series_id = ?')
    .bind(seriesId).first<{ d: string | null }>();
  return row?.d ?? null;
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

export async function acquireIngestLock(
  db: D1Database,
  runId: string,
  acquiredAt: string,
  expiresAt: string,
): Promise<boolean> {
  const result = await db.prepare(
    `INSERT INTO ingest_lock (lock_name, owner_run_id, acquired_at, expires_at)
     VALUES ('fred_ingest', ?, ?, ?)
     ON CONFLICT(lock_name) DO UPDATE SET
       owner_run_id = excluded.owner_run_id,
       acquired_at = excluded.acquired_at,
       expires_at = excluded.expires_at
     WHERE ingest_lock.expires_at <= ?`
  ).bind(runId, acquiredAt, expiresAt, acquiredAt).run();
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
  renewedAt: string,
  expiresAt: string,
): Promise<boolean> {
  const result = await db.prepare(
    `UPDATE ingest_lock SET expires_at = ?
     WHERE lock_name = 'fred_ingest' AND owner_run_id = ? AND expires_at > ?`
  ).bind(expiresAt, runId, renewedAt).run();
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
     WHERE run_id = ? AND series_id = ? AND status = 'RUNNING'`
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
    if (!attempt) throw new Error(`${seriesId} has no ingest attempt`);
    if (attempt.status !== 'SUCCEEDED') throw new Error(`${seriesId} attempt did not succeed`);
    if (attempt.rowCount === 0 && !activeSeries.has(seriesId)) {
      throw new Error(`${seriesId} returned empty without active production history`);
    }
  }
}

export async function validateIngestRun(
  db: D1Database,
  runId: string,
  configuredSeries: string[],
): Promise<void> {
  const [attemptRows, activeRows] = await Promise.all([
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
  const results = await db.batch([
    db.prepare(
      `INSERT INTO observations (series_id, date, value)
       SELECT staged.series_id, staged.date, staged.value FROM staging_observations staged
       WHERE staged.run_id = ?
         AND EXISTS (
           SELECT 1 FROM ingest_runs target
           WHERE target.run_id = ? AND target.state = 'RUNNING'
         )
       ON CONFLICT(series_id, date) DO UPDATE SET value = excluded.value`
    ).bind(runId, runId),
    db.prepare(
      `UPDATE ingest_runs SET state = 'SUPERSEDED'
       WHERE state = 'ACTIVE' AND run_id <> ?
         AND EXISTS (
           SELECT 1 FROM ingest_runs target
           WHERE target.run_id = ? AND target.state = 'RUNNING'
         )`
    ).bind(runId, runId),
    db.prepare(
      `UPDATE ingest_runs SET
         state = 'ACTIVE', completed_at = ?,
         snapshot_state = 'PENDING', snapshot_completed_at = NULL,
         snapshot_error = NULL, snapshot_count = 0,
         row_count = (SELECT COUNT(*) FROM staging_observations WHERE run_id = ?),
         series_count = (SELECT COUNT(*) FROM ingest_series_attempts
                         WHERE run_id = ? AND status = 'SUCCEEDED')
       WHERE run_id = ? AND state = 'RUNNING'`
    ).bind(completedAt, runId, runId, runId),
  ]);
  if (Number((results[2]?.meta as any)?.changes ?? 0) !== 1) {
    throw new Error(`ingest run ${runId} must be RUNNING before activation`);
  }
}

export async function completeIngestSnapshots(
  db: D1Database,
  runId: string,
  snapshotCount: number,
  completedAt: string,
): Promise<void> {
  const result = await db.prepare(
    `UPDATE ingest_runs SET
       snapshot_state = 'SUCCEEDED', snapshot_completed_at = ?,
       snapshot_error = NULL, snapshot_count = ?
     WHERE run_id = ? AND state = 'ACTIVE' AND snapshot_state = 'PENDING'`
  ).bind(completedAt, snapshotCount, runId).run();
  if (Number((result.meta as any)?.changes ?? 0) !== 1) {
    throw new Error(`active ingest run ${runId} has no pending snapshot outcome`);
  }
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
     WHERE run_id = ? AND state IN ('ACTIVE', 'SUPERSEDED') AND snapshot_state = 'PENDING'`
  ).bind(completedAt, `${failure.step}: ${failure.error}`, failure.snapshotCount, runId).run();
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

export async function upsertOfficialSnapshot(db: D1Database, s: Snapshot, spx: number | null): Promise<void> {
  const placeholders = Array.from({ length: 28 }, () => '?').join(',');
  await db.prepare(
    `INSERT INTO model_snapshot_weekly (date, decision_week, ${SNAPSHOT_COLUMNS})
     VALUES (${placeholders})
     ON CONFLICT(decision_week) DO UPDATE SET date=excluded.date,
       ${SNAPSHOT_UPDATE}`
  ).bind(s.date, decisionWeek(s.date), ...snapshotValues(s, spx)).run();
}

export async function upsertNowcastSnapshot(db: D1Database, s: Snapshot, spx: number | null): Promise<void> {
  const placeholders = Array.from({ length: 28 }, () => '?').join(',');
  await db.prepare(
    `INSERT INTO nowcast_snapshot_daily (date, channel_status, ${SNAPSHOT_COLUMNS})
     VALUES (${placeholders})
     ON CONFLICT(date) DO UPDATE SET channel_status='PROVISIONAL',
       ${SNAPSHOT_UPDATE}`
  ).bind(s.date, 'PROVISIONAL', ...snapshotValues(s, spx)).run();
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

export async function countOfficialSnapshots(db: D1Database): Promise<number> {
  const row = await db.prepare('SELECT COUNT(*) AS n FROM model_snapshot_weekly').first<{ n: number }>();
  return row?.n ?? 0;
}

export async function officialSnapshotOnOrBefore(db: D1Database, date: string) {
  return db.prepare("SELECT * FROM model_snapshot_weekly WHERE date <= ? AND decision_status = 'OK' ORDER BY date DESC LIMIT 1")
    .bind(date).first();
}

export async function setMeta(db: D1Database, key: string, value: string): Promise<void> {
  await db.prepare(
    'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).bind(key, value).run();
}

export async function getAllMeta(db: D1Database): Promise<Record<string, string>> {
  const rs = await db.prepare('SELECT key, value FROM meta').all<{ key: string; value: string }>();
  const m: Record<string, string> = {};
  for (const r of rs.results ?? []) m[r.key] = r.value;
  return m;
}
