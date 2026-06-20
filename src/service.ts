import { fetchFredSeries } from './fred';
import { SERIES_IDS } from './config';
import { maxObsDate, upsertObservations, loadSeriesMap, upsertSnapshot, setMeta } from './db';
import { computeSnapshot, asOf } from './metrics';
import type { Verdict } from './metrics';

export interface Env {
  DB: D1Database; ASSETS: Fetcher;
  FRED_API_KEY: string; ADMIN_TOKEN: string; START_DATE: string;
}

function eachDay(from: string, to: string): string[] {
  const out: string[] = []; const d = new Date(from + 'T00:00:00Z'); const end = new Date(to + 'T00:00:00Z');
  while (d <= end) { out.push(d.toISOString().slice(0, 10)); d.setUTCDate(d.getUTCDate() + 1); }
  return out;
}

export async function runIngest(env: Env, rebuildAll = false): Promise<{ updated: number; snapshots: number }> {
  await setMeta(env.DB, 'last_attempt_at', new Date().toISOString());
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
    const lastWalcl = (m.WALCL ?? []).at(-1)?.date;
    let snapshots = 0;
    if (lastWalcl) {
      const lastDate = lastWalcl;
      // Full rebuild samples at the weekly WALCL cadence the macro data actually moves on.
      // The daily cron (rebuildAll=false) keeps the most recent 14 days at daily granularity.
      const dates = rebuildAll
        ? (m.WALCL ?? []).map(o => o.date).filter(d => d <= lastDate)
        : eachDay(addDays(lastDate, -14), lastDate);
      let prev: Verdict | undefined;
      for (const date of dates) {
        if (asOf(m.WALCL ?? [], date) == null) continue;
        const snap = computeSnapshot(m, date, prev);
        await upsertSnapshot(env.DB, snap, asOf(m.SP500 ?? [], date));
        prev = snap.verdict; snapshots++;
      }
    }
    await setMeta(env.DB, 'last_ingest_at', new Date().toISOString());
    await setMeta(env.DB, 'last_status', 'ok');
    await setMeta(env.DB, 'last_error', '');
    await setMeta(env.DB, 'last_updated', String(updated));
    await setMeta(env.DB, 'last_snapshots', String(snapshots));
    return { updated, snapshots };
  } catch (e) {
    await setMeta(env.DB, 'last_status', 'error');
    await setMeta(env.DB, 'last_error', String((e as any)?.message ?? e));
    throw e;
  }
}

function addDays(date: string, days: number): string {
  const d = new Date(date + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
