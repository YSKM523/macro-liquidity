import type { Obs, SeriesMap, Snapshot } from './metrics';
import { SERIES_IDS } from './config';

export async function maxObsDate(db: D1Database, seriesId: string): Promise<string | null> {
  const row = await db.prepare('SELECT MAX(date) AS d FROM observations WHERE series_id = ?')
    .bind(seriesId).first<{ d: string | null }>();
  return row?.d ?? null;
}

export async function upsertObservations(db: D1Database, seriesId: string, rows: Obs[]): Promise<void> {
  if (rows.length === 0) return;
  const stmt = db.prepare(
    'INSERT INTO observations (series_id, date, value) VALUES (?, ?, ?) ' +
    'ON CONFLICT(series_id, date) DO UPDATE SET value = excluded.value'
  );
  const batch = rows.map(r => stmt.bind(seriesId, r.date, r.value));
  for (let i = 0; i < batch.length; i += 100) await db.batch(batch.slice(i, i + 100));
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

export async function upsertSnapshot(db: D1Database, s: Snapshot, spx: number | null): Promise<void> {
  await db.prepare(
    `INSERT INTO daily_snapshot
      (date, walcl, tga, rrp, repo, netliq, netliq_trend, sofr_iorb, hy_oas, dgs10,
       dxy_eod, vix_eod, qe_qt_regime, netliq_dir, verdict, score, p0, p1, p2, p3, spx, reason, factors_json)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(date) DO UPDATE SET
       walcl=excluded.walcl, tga=excluded.tga, rrp=excluded.rrp, repo=excluded.repo,
       netliq=excluded.netliq, netliq_trend=excluded.netliq_trend, sofr_iorb=excluded.sofr_iorb,
       hy_oas=excluded.hy_oas, dgs10=excluded.dgs10, dxy_eod=excluded.dxy_eod, vix_eod=excluded.vix_eod,
       qe_qt_regime=excluded.qe_qt_regime, netliq_dir=excluded.netliq_dir, verdict=excluded.verdict,
       score=excluded.score, p0=excluded.p0, p1=excluded.p1, p2=excluded.p2, p3=excluded.p3,
       spx=excluded.spx, reason=excluded.reason, factors_json=excluded.factors_json`
  ).bind(
    s.date, s.walcl, s.tga, s.rrp, s.repo, s.netliq, s.netliqTrend, s.sofrIorb, s.hyOas, s.dgs10,
    s.dxy, s.vix, s.bsImpulse, s.netliqDir, s.verdict, s.score,
    s.p0 ? 1 : 0, s.p1 ? 1 : 0, s.p2 ? 1 : 0, s.p3 ? 1 : 0,
    spx, s.reason, JSON.stringify(s.factors)
  ).run();
}

export async function latestSnapshot(db: D1Database) {
  return db.prepare('SELECT * FROM daily_snapshot ORDER BY date DESC LIMIT 1').first();
}

export async function snapshotHistory(db: D1Database, from: string, to: string) {
  const rs = await db.prepare(
    'SELECT date, netliq, walcl, score, verdict, qe_qt_regime, spx FROM daily_snapshot WHERE date BETWEEN ? AND ? ORDER BY date'
  ).bind(from, to).all();
  return rs.results ?? [];
}

export async function distinctSnapshotDates(db: D1Database, lastN: number): Promise<string[]> {
  const rs = await db.prepare('SELECT date FROM daily_snapshot ORDER BY date DESC LIMIT ?')
    .bind(lastN).all<{ date: string }>();
  return (rs.results ?? []).map(r => r.date).reverse();
}
