import type { Obs } from './fred';
export type { Obs };
export type SeriesMap = Record<string, Obs[]>;

import { QEQT_EPSILON_B, NETLIQ_TREND_WEEKS } from './config';

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
