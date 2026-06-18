import { fetchFredSeries } from './fred';
import { SERIES_IDS } from './config';
import { maxObsDate, upsertObservations, loadSeriesMap, upsertSnapshot } from './db';
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
  if (!lastWalcl) return { updated, snapshots: 0 };

  const lastDate = lastWalcl;
  const dates = rebuildAll
    ? eachDay((m.WALCL ?? [])[0]?.date ?? env.START_DATE, lastDate)
    : eachDay(addDays(lastDate, -14), lastDate);

  let prev: Verdict | undefined;
  let snapshots = 0;
  for (const date of dates) {
    if (asOf(m.WALCL ?? [], date) == null) continue;
    const snap = computeSnapshot(m, date, prev);
    await upsertSnapshot(env.DB, snap, asOf(m.SP500 ?? [], date));
    prev = snap.verdict; snapshots++;
  }
  return { updated, snapshots };
}

function addDays(date: string, days: number): string {
  const d = new Date(date + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
