import type { Obs } from './fred';
export type { Obs };
export type SeriesMap = Record<string, Obs[]>;

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
