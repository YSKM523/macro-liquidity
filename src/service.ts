import { fetchFredSeriesPit } from './fred';
import {
  SERIES_IDS,
  MAIN_CRON,
  RETRY_MAX_AGE_HOURS,
  ALERT_MIN_INTERVAL_HOURS,
  INGEST_LOCK_LEASE_SECONDS,
} from './config';
import {
  upsertOfficialSnapshot,
  upsertNowcastSnapshot,
  setIngestMeta,
  getAllMeta,
  officialSnapshotBefore,
  officialVerdictAnchors,
  decisionWeek,
  acquireIngestLock,
  releaseIngestLock,
  renewIngestLock,
  createIngestRun,
  startSeriesAttempt,
  stageSeriesAttempt,
  failSeriesAttempt,
  validateSeriesRows,
  validateIngestRun,
  activateIngestRun,
  failIngestRun,
  completeIngestSuccess,
  failIngestSnapshots,
  IngestSeriesValidationError,
  maxPitVintageDate,
  loadReleaseRules,
  stagePitObservations,
  loadPitObservations,
  officialPitDecisionEvents,
} from './db';
import { computeSnapshot, asOf } from './metrics';
import type { Verdict } from './metrics';
import { shouldRetryIngest, shouldAlert, buildAlertEmail } from './pipeline';
import { spliceSeries, fetchDxyDaily } from './prices';
import { compareIsoTimestamps, isoTimestampMs, iteratePitFrames } from './pit';

export interface Env {
  DB: D1Database; ASSETS: Fetcher;
  FRED_API_KEY: string; ADMIN_TOKEN: string; START_DATE: string;
  RESEND_API_KEY?: string; EMAIL_FROM?: string; ALERT_EMAIL_TO?: string;
}

export type IngestResult =
  | { status: 'active'; runId: string; updated: number; snapshots: number }
  | { status: 'conflict'; runId: string; updated: 0; snapshots: 0 };

function eachDay(from: string, to: string): string[] {
  const out: string[] = []; const d = new Date(from + 'T00:00:00Z'); const end = new Date(to + 'T00:00:00Z');
  while (d <= end) { out.push(d.toISOString().slice(0, 10)); d.setUTCDate(d.getUTCDate() + 1); }
  return out;
}

function oneDecisionPerWeek(dates: string[]): string[] {
  const latestByWeek = new Map<string, string>();
  for (const date of dates.slice().sort()) latestByWeek.set(decisionWeek(date), date);
  return [...latestByWeek.values()];
}

function newRunId(now: Date): string {
  return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `ingest-${now.getTime()}-${Math.random().toString(36).slice(2)}`;
}

function validationSeriesId(error: unknown): string | undefined {
  if (error instanceof IngestSeriesValidationError) return error.seriesId;
  if (error != null && typeof error === 'object' && typeof (error as any).seriesId === 'string') {
    return (error as any).seriesId;
  }
  return undefined;
}

async function renewOwnedLease(db: D1Database, runId: string): Promise<void> {
  if (!await renewIngestLock(db, runId, INGEST_LOCK_LEASE_SECONDS)) {
    throw new Error(`ingest lease lost for run ${runId}`);
  }
}

export async function runIngest(
  env: Env,
  rebuildAll = false,
  now = new Date(),
  clock: () => string = () => new Date().toISOString(),
): Promise<IngestResult> {
  const runId = newRunId(now);
  const nowIso = now.toISOString();
  const acquired = await acquireIngestLock(env.DB, runId, INGEST_LOCK_LEASE_SECONDS);
  if (!acquired) return { status: 'conflict', runId, updated: 0, snapshots: 0 };

  let prevMeta: Record<string, string> = {};
  let runCreated = false;
  let activated = false;
  let snapshots = 0;
  let failedStep = 'initialization';
  let failedSeries: string | undefined;
  try {
    prevMeta = await getAllMeta(env.DB);
    await renewOwnedLease(env.DB, runId);
    failedStep = 'metadata';
    await renewOwnedLease(env.DB, runId);
    await setIngestMeta(env.DB, runId, 'last_attempt_at', nowIso);
    failedStep = 'initialization';
    await renewOwnedLease(env.DB, runId);
    await createIngestRun(env.DB, runId, rebuildAll ? 'FULL' : 'INCREMENTAL', nowIso);
    runCreated = true;

    // 1) Fetch and stage every configured series without touching production.
    let updated = 0;
    let latestObservedFetchAt = nowIso;
    for (const id of SERIES_IDS) {
      failedSeries = id;
      failedStep = 'lock';
      await renewOwnedLease(env.DB, runId);
      failedStep = 'attempt-start';
      await startSeriesAttempt(env.DB, runId, id, new Date().toISOString());
      try {
        failedStep = 'series-read';
        const lastPitVintage = rebuildAll ? null : await maxPitVintageDate(env.DB, id);
        const releaseRules = await loadReleaseRules(env.DB);
        const realtimeStart = lastPitVintage ?? env.START_DATE;
        const releaseRule = releaseRules.get(id);
        if (releaseRule == null || releaseRule.length === 0) {
          throw new Error(`${id} has no release calendar rule`);
        }
        failedStep = 'lock';
        await renewOwnedLease(env.DB, runId);
        failedStep = 'fetch';
        const fetched = await fetchFredSeriesPit(
          id, env.START_DATE, realtimeStart, nowIso, env.FRED_API_KEY, releaseRule, new Map(),
          () => {
            const observedAt = clock();
            isoTimestampMs(observedAt, 'observed fetch time');
            if (compareIsoTimestamps(observedAt, latestObservedFetchAt) > 0) {
              latestObservedFetchAt = observedAt;
            }
            return observedAt;
          },
        );
        failedStep = 'lock';
        await renewOwnedLease(env.DB, runId);
        failedStep = 'structural';
        validateSeriesRows(id, fetched.latestRows);
        failedStep = 'staging';
        await stagePitObservations(env.DB, runId, fetched.vintages);
        await stageSeriesAttempt(env.DB, runId, id, fetched.latestRows);
        updated += fetched.latestRows.length;
      } catch (error) {
        const originalMessage = String((error as any)?.message ?? error);
        try {
          await failSeriesAttempt(env.DB, runId, id, originalMessage, new Date().toISOString());
        } catch {
          // Attempt auditing is best-effort here; never replace the operation failure.
        }
        throw error;
      }
    }
    failedStep = 'validation';
    try {
      await validateIngestRun(env.DB, runId, SERIES_IDS);
    } catch (error) {
      const invalidSeries = validationSeriesId(error);
      if (invalidSeries) {
        failedSeries = invalidSeries;
        const originalMessage = String((error as any)?.message ?? error);
        try {
          await failSeriesAttempt(
            env.DB,
            runId,
            invalidSeries,
            originalMessage,
            new Date().toISOString(),
          );
        } catch {
          // Preserve the semantic validation error if attempt auditing fails.
        }
      }
      throw error;
    }
    failedSeries = undefined;

    // 2) Promote staging and switch ACTIVE in one transactional D1 batch.
    failedStep = 'lock';
    await renewOwnedLease(env.DB, runId);
    failedStep = 'activation';
    await activateIngestRun(env.DB, runId, new Date().toISOString());
    activated = true;

    const releaseResolutionAt = clock();
    isoTimestampMs(releaseResolutionAt, 'release resolutionAt');
    if (compareIsoTimestamps(releaseResolutionAt, latestObservedFetchAt) < 0) {
      throw new Error('release resolutionAt precedes an observed fetch time');
    }

    // 3) Rebuild snapshots only from the newly activated production view.
    failedStep = 'snapshot-read';
    const pitRows = await loadPitObservations(env.DB, releaseResolutionAt);
    failedStep = 'lock';
    await renewOwnedLease(env.DB, runId);
    // DTWEXBGS 官方发布滞后约一周;用 DXY 日线按比例链到末端参与打分(仅内存,行情失败则跳过)。
    failedStep = 'dxy-fetch';
    const dxy = await fetchDxyDaily({ fredApiKey: env.FRED_API_KEY });
    failedStep = 'lock';
    await renewOwnedLease(env.DB, runId);
    const currentAsOf = now.toISOString().slice(0, 10);
    const rawOfficialEvents = rebuildAll
      ? await officialPitDecisionEvents(env.DB, releaseResolutionAt) : [];
    const officialDates = new Set(oneDecisionPerWeek(rawOfficialEvents.map(event => event.modelDate)));
    const events = rebuildAll
      ? rawOfficialEvents.filter(event => officialDates.has(event.modelDate))
      : eachDay(addDays(currentAsOf, -14), currentAsOf).map(modelDate => {
          const modelDateEnd = `${modelDate}T23:59:59Z`;
          const decisionAt = compareIsoTimestamps(modelDateEnd, releaseResolutionAt) < 0
            ? modelDateEnd : releaseResolutionAt;
          return { modelDate, decisionAt, tradableAt: decisionAt };
        });
    if (events.length > 0) {
      const dates = events.slice()
        .sort((a, b) => compareIsoTimestamps(a.decisionAt, b.decisionAt))
        .map(event => event.modelDate);
      let prev: Verdict | undefined;
      let officialAnchors = new Map<string, Verdict>();
      if (!rebuildAll && dates.length > 0) {
        failedStep = 'snapshot-read';
        const prior = await officialSnapshotBefore(env.DB, dates[0]);
        failedStep = 'lock';
        await renewOwnedLease(env.DB, runId);
        prev = prior?.verdict ?? undefined;
        failedStep = 'snapshot-read';
        const anchors = await officialVerdictAnchors(env.DB, dates[0], dates.at(-1)!);
        failedStep = 'lock';
        await renewOwnedLease(env.DB, runId);
        officialAnchors = new Map(anchors.map(anchor => [anchor.date, anchor.verdict]));
      }
      for (const frame of iteratePitFrames(pitRows, events)) {
        const date = frame.event.modelDate;
        const m = frame.seriesMap;
        if (!rebuildAll) m.DTWEXBGS = spliceSeries(m.DTWEXBGS ?? [], dxy);
        if (asOf(m.WALCL ?? [], date) == null) continue;
        prev = officialAnchors.get(date) ?? prev;
        const snap = computeSnapshot(m, date, prev);
        failedStep = 'lock';
        await renewOwnedLease(env.DB, runId);
        failedStep = 'snapshot';
        if (rebuildAll) {
          const outcome = await upsertOfficialSnapshot(env.DB, runId, snap, asOf(m.SP500 ?? [], date), {
            dataRunId: runId,
            dataCutoff: frame.dataCutoff,
            decisionAt: frame.event.decisionAt,
            tradableAt: frame.event.tradableAt,
            releaseResolutionAt,
            inputs: frame.inputs,
          });
          if (outcome === 'FROZEN') {
            const frozenWeek = decisionWeek(date);
            const frozen = await officialVerdictAnchors(
              env.DB, frozenWeek, addDays(frozenWeek, 6),
            );
            prev = frozen[0]?.verdict ?? prev;
            snapshots++;
            continue;
          }
        } else {
          await upsertNowcastSnapshot(env.DB, runId, snap, asOf(m.SP500 ?? [], date), {
            dataRunId: runId,
            dataCutoff: frame.dataCutoff,
            decisionAt: frame.event.decisionAt,
            tradableAt: frame.event.tradableAt,
            releaseResolutionAt,
          });
        }
        if (snap.verdict != null) prev = snap.verdict;
        snapshots++;
      }
    }
    const successAt = new Date().toISOString();
    const successMeta: Array<[string, string]> = [
      ['last_ingest_at', successAt],
      ['last_status', 'ok'],
      ['last_error', ''],
      ['last_updated', String(updated)],
      ['last_snapshots', String(snapshots)],
    ];
    failedStep = 'lock';
    await renewOwnedLease(env.DB, runId);
    failedStep = 'snapshot-finalization';
    await completeIngestSuccess(env.DB, runId, snapshots, successAt, successMeta);
    return { status: 'active', runId, updated, snapshots };
  } catch (e) {
    const errMsg = String((e as any)?.message ?? e);
    if (runCreated) {
      try {
        if (activated) {
          await failIngestSnapshots(env.DB, runId, {
            step: failedStep,
            error: errMsg,
            snapshotCount: snapshots,
          }, new Date().toISOString());
        } else {
          await failIngestRun(env.DB, runId, {
            step: failedStep,
            seriesId: failedSeries,
            error: errMsg,
          }, new Date().toISOString());
        }
      } catch {
        // Preserve the original failure; the lease expiry prevents a permanent lock.
      }
    }
    let stillOwnsLease = false;
    try {
      await renewOwnedLease(env.DB, runId);
      stillOwnsLease = true;
    } catch {
      // A former owner must not overwrite the current owner's global health metadata.
    }
    if (stillOwnsLease) {
      try {
        await renewOwnedLease(env.DB, runId);
        await setIngestMeta(env.DB, runId, 'last_status', 'error');
        await renewOwnedLease(env.DB, runId);
        await setIngestMeta(env.DB, runId, 'last_error', errMsg);
        if (shouldAlert({
          prevStatus: prevMeta.last_status ?? null,
          attemptOk: false,
          lastAlertAt: prevMeta.last_alert_at ?? null,
          now: nowIso,
          minIntervalHours: ALERT_MIN_INTERVAL_HOURS,
        })) {
          const sent = await sendAlertEmail(env, buildAlertEmail({
            error: errMsg, lastIngestAt: prevMeta.last_ingest_at ?? null, now: nowIso,
          }));
          if (sent) {
            await renewOwnedLease(env.DB, runId);
            await setIngestMeta(env.DB, runId, 'last_alert_at', new Date().toISOString());
          }
        }
      } catch {
        // Preserve the original ingest failure if health metadata or alert auditing fails.
      }
    }
    throw e;
  } finally {
    try {
      await releaseIngestLock(env.DB, runId);
    } catch {
      // Release failures must not mask ingest results; the lease expires automatically.
    }
  }
}

// Alerting must never mask the ingest error — swallow every failure here.
async function sendAlertEmail(env: Env, m: { subject: string; text: string }): Promise<boolean> {
  if (!env.RESEND_API_KEY || !env.EMAIL_FROM || !env.ALERT_EMAIL_TO) return false;
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: env.EMAIL_FROM, to: [env.ALERT_EMAIL_TO], subject: m.subject, text: m.text }),
    });
    return r.ok;
  } catch { return false; }
}

/** Cron entry: the main cron always ingests; the retry cron only when unhealthy/stale. */
export async function scheduledIngest(
  cron: string,
  env: Env,
  now = new Date(),
): Promise<IngestResult | { status: 'skipped' }> {
  if (cron !== MAIN_CRON) {
    const meta = await getAllMeta(env.DB);
    const retry = shouldRetryIngest({
      lastStatus: meta.last_status ?? null,
      lastIngestAt: meta.last_ingest_at ?? null,
      now: now.toISOString(),
      maxAgeHours: RETRY_MAX_AGE_HOURS,
    });
    if (!retry) return { status: 'skipped' };
  }
  const result = await runIngest(env, false, now);
  if (result.status === 'conflict') {
    console.warn(`[ingest] lease contention; skipped scheduled run ${result.runId}`);
  }
  return result;
}

function addDays(date: string, days: number): string {
  const d = new Date(date + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
