import type { Obs } from './fred';
export type { Obs };
export type SeriesMap = Record<string, Obs[]>;

import { QEQT_EPSILON_B, NETLIQ_TREND_WEEKS, WEIGHTS, RATES_LOOKBACK_DAYS } from './config';

export type Regime = 'QE' | 'QT' | 'NEUTRAL';
export type Direction = 'UP' | 'DOWN' | 'FLAT';

export const clamp = (x: number, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, x));
export const linMap = (x: number, a: number, b: number) => clamp(((x - a) / (b - a)) * 100);

export function sma(values: number[], n: number): number | null {
  if (values.length < n || n <= 0) return null;
  const slice = values.slice(values.length - n);
  return slice.reduce((s, v) => s + v, 0) / n;
}

export function asOf(series: Obs[], date: string): number | null {
  let val: number | null = null;
  for (const o of series) { if (o.date <= date) val = o.value; else break; }
  return val;
}

export function buildWeeklyNetliq(m: SeriesMap, upTo: string): number[] {
  const walcl = m.WALCL ?? [];
  const out: number[] = [];
  for (const w of walcl) {
    if (w.date > upTo) break;
    const tga = asOf(m.WTREGEN ?? [], w.date);
    const rrp = asOf(m.RRPONTSYD ?? [], w.date);
    if (tga == null || rrp == null) continue;
    out.push(w.value - tga - rrp);
  }
  return out;
}

export function changeOverDays(series: Obs[], date: string, days: number): number | null {
  const latest = asOf(series, date);
  if (latest == null) return null;
  const d = new Date(date + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - days);
  const past = asOf(series, d.toISOString().slice(0, 10));
  return past == null ? null : latest - past;
}

export function classifyQeQt(walclWeekly: number[]): Regime {
  if (walclWeekly.length < 14) return 'NEUTRAL';
  const latest = walclWeekly[walclWeekly.length - 1];
  const past = walclWeekly[walclWeekly.length - 14]; // 13 weeks back
  const d = latest - past;
  if (d > QEQT_EPSILON_B) return 'QE';
  if (d < -QEQT_EPSILON_B) return 'QT';
  return 'NEUTRAL';
}

export function netliqDirection(netliqWeekly: number[]): Direction {
  const n = NETLIQ_TREND_WEEKS;
  const ma = sma(netliqWeekly, n);
  if (ma == null) return 'FLAT';
  const latest = netliqWeekly[netliqWeekly.length - 1];
  const rel = (latest - ma) / Math.max(1, Math.abs(ma)); // relative gap
  if (rel > 0.002) return 'UP';
  if (rel < -0.002) return 'DOWN';
  return 'FLAT';
}

export interface Factors {
  netliqTrend: number; qeqt: number; credit: number; funding: number;
  rates: number; dollar: number; vol: number;
}

export function percentileRank(value: number, history: number[]): number {
  if (history.length === 0) return 0.5;
  const below = history.filter(h => h <= value).length;
  return below / history.length;
}

export function scoreNetliqTrend(netliqWeekly: number[], n = NETLIQ_TREND_WEEKS): number {
  if (netliqWeekly.length < n + 1) return 50;
  const latest = netliqWeekly[netliqWeekly.length - 1];
  const ma = sma(netliqWeekly, n)!;
  const aboveMa = latest > ma ? 60 : 40;
  const idx4 = Math.max(0, netliqWeekly.length - 1 - 4);
  const slope = latest - netliqWeekly[idx4];       // ~4-week $B change
  const slopeScore = linMap(slope, -200, 200);
  return clamp(0.5 * aboveMa + 0.5 * slopeScore);
}

export function scoreQeQt(regime: Regime): number {
  return regime === 'QE' ? 80 : regime === 'QT' ? 30 : 55;
}

export function scoreCredit(hyLatest: number, hyHistory: number[]): number {
  // low OAS percentile = calm credit = bullish → invert percentile
  const pct = percentileRank(hyLatest, hyHistory); // 0 low .. 1 high
  return clamp((1 - pct) * 100);
}

export function scoreFunding(sofrIorb: number): number {
  // <=0 calm → 100; rises through +0.10 → 0
  return linMap(sofrIorb, 0.10, 0.0);
}

export function scoreRates(delta10y: number | null): number {
  if (delta10y == null) return 50;
  // +0.5pp over lookback = strong headwind (0); -0.5pp = tailwind (100)
  return linMap(delta10y, 0.5, -0.5);
}

export function scoreDollar(dxySeries: Obs[], date: string): number {
  const n = 200;
  const vals = dxySeries.filter(o => o.date <= date).map(o => o.value);
  if (vals.length < n) return 50;
  const ma = sma(vals, n)!;
  const slice = vals.slice(vals.length - n);
  const mean = slice.reduce((s, v) => s + v, 0) / n;
  const sd = Math.sqrt(slice.reduce((s, v) => s + (v - mean) ** 2, 0) / n);
  const latest = vals[vals.length - 1];
  const z = sd > 0 ? (latest - ma) / sd : 0;
  // strong dollar (z high) = headwind; below mean = tailwind
  return linMap(z, 1.0, -1.0);
}

export function scoreVol(vix: number | null): number {
  if (vix == null) return 50;
  // VIX 12 → 100, 30 → 0
  return linMap(vix, 30, 12);
}

export function weightedScore(f: Factors): number {
  const s =
    f.netliqTrend * WEIGHTS.netliqTrend + f.qeqt * WEIGHTS.qeqt +
    f.credit * WEIGHTS.credit + f.funding * WEIGHTS.funding +
    f.rates * WEIGHTS.rates + f.dollar * WEIGHTS.dollar + f.vol * WEIGHTS.vol;
  return clamp(s);
}
