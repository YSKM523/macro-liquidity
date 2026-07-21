import { fetchFredSeries } from './fred';
import { SERIES_IDS, MAIN_CRON, RETRY_MAX_AGE_HOURS, ALERT_MIN_INTERVAL_HOURS } from './config';
import { maxObsDate, upsertObservations, loadSeriesMap, upsertSnapshot, setMeta, getAllMeta, snapshotBefore } from './db';
import { computeSnapshot, asOf } from './metrics';
import type { Verdict } from './metrics';
import { shouldRetryIngest, shouldAlert, buildAlertEmail } from './pipeline';
import { spliceSeries, fetchDxyDaily } from './prices';

export interface Env {
  DB: D1Database; ASSETS: Fetcher;
  FRED_API_KEY: string; ADMIN_TOKEN: string; START_DATE: string;
  RESEND_API_KEY?: string; EMAIL_FROM?: string; ALERT_EMAIL_TO?: string;
}

function eachDay(from: string, to: string): string[] {
  const out: string[] = []; const d = new Date(from + 'T00:00:00Z'); const end = new Date(to + 'T00:00:00Z');
  while (d <= end) { out.push(d.toISOString().slice(0, 10)); d.setUTCDate(d.getUTCDate() + 1); }
  return out;
}

export async function runIngest(
  env: Env,
  rebuildAll = false,
  now = new Date(),
): Promise<{ updated: number; snapshots: number }> {
  const prevMeta = await getAllMeta(env.DB);
  await setMeta(env.DB, 'last_attempt_at', now.toISOString());
  try {
    // 1) pull FRED incrementally
    let updated = 0;
    for (const id of SERIES_IDS) {
      const last = await maxObsDate(env.DB, id);
      const from = last ?? env.START_DATE;
      const rows = await fetchFredSeries(id, from, env.FRED_API_KEY);
      await upsertObservations(env.DB, id, rows);
      updated += rows.length;
    }
    // 2) rebuild snapshots
    const m = await loadSeriesMap(env.DB);
    // DTWEXBGS 官方发布滞后约一周;用 DXY 日线按比例链到末端参与打分(仅内存,行情失败则跳过)。
    m.DTWEXBGS = spliceSeries(m.DTWEXBGS ?? [], await fetchDxyDaily());
    const lastWalcl = (m.WALCL ?? []).at(-1)?.date;
    let snapshots = 0;
    if (lastWalcl) {
      // Full rebuild samples at the weekly WALCL cadence the macro data actually moves on.
      // The daily cron (rebuildAll=false) keeps the most recent 14 days at daily granularity.
      const currentAsOf = now.toISOString().slice(0, 10);
      const dates = rebuildAll
        ? (m.WALCL ?? []).map(o => o.date).filter(d => d <= lastWalcl)
        : eachDay(addDays(currentAsOf, -14), currentAsOf);
      const prior = rebuildAll ? null : await snapshotBefore(env.DB, dates[0]);
      let prev: Verdict | undefined = prior?.verdict ?? undefined;
      for (const date of dates) {
        if (asOf(m.WALCL ?? [], date) == null) continue;
        const snap = computeSnapshot(m, date, prev);
        await upsertSnapshot(env.DB, snap, asOf(m.SP500 ?? [], date));
        if (snap.verdict != null) prev = snap.verdict;
        snapshots++;
      }
    }
    await setMeta(env.DB, 'last_ingest_at', now.toISOString());
    await setMeta(env.DB, 'last_status', 'ok');
    await setMeta(env.DB, 'last_error', '');
    await setMeta(env.DB, 'last_updated', String(updated));
    await setMeta(env.DB, 'last_snapshots', String(snapshots));
    return { updated, snapshots };
  } catch (e) {
    const errMsg = String((e as any)?.message ?? e);
    await setMeta(env.DB, 'last_status', 'error');
    await setMeta(env.DB, 'last_error', errMsg);
    const nowIso = now.toISOString();
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
      if (sent) await setMeta(env.DB, 'last_alert_at', nowIso);
    }
    throw e;
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
export async function scheduledIngest(cron: string, env: Env): Promise<void> {
  if (cron !== MAIN_CRON) {
    const meta = await getAllMeta(env.DB);
    const retry = shouldRetryIngest({
      lastStatus: meta.last_status ?? null,
      lastIngestAt: meta.last_ingest_at ?? null,
      now: new Date().toISOString(),
      maxAgeHours: RETRY_MAX_AGE_HOURS,
    });
    if (!retry) return;
  }
  await runIngest(env, false);
}

function addDays(date: string, days: number): string {
  const d = new Date(date + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
