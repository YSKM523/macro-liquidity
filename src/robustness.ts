import type { BtSnap } from './backtest';
import { spearman, forwardReturns, addDays, mean, std } from './backtest';

const fin = (x: number): number => (Number.isFinite(x) ? x : 0);

function daysBetween(a: string, b: string): number {
  return Math.round((new Date(b + 'T00:00:00Z').getTime() - new Date(a + 'T00:00:00Z').getTime()) / 86_400_000);
}

// Deterministic PRNG (no Math.random/Date) → reproducible, testable bootstrap.
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Non-overlapping IC: greedy stride — take a start, jump to/after its horizon end, repeat.
export function nonOverlappingIC(snaps: BtSnap[], horizonWeeks: number): { n: number; ic_spearman: number } {
  const hDays = horizonWeeks * 7;
  const scores: number[] = [];
  const fwds: number[] = [];
  let i = 0;
  while (i < snaps.length) {
    const target = addDays(snaps[i].date, hDays);
    let j = -1;
    for (let k = i + 1; k < snaps.length; k++) {
      if (snaps[k].date >= target) { j = k; break; }
    }
    if (j === -1) break;
    if (daysBetween(snaps[i].date, snaps[j].date) <= hDays + 14) {
      scores.push(snaps[i].score);
      fwds.push(fin(snaps[j].spx / snaps[i].spx - 1));
    }
    i = j; // next start at/after this window's end → non-overlapping
  }
  return { n: scores.length, ic_spearman: fin(spearman(scores, fwds)) };
}

// Max drawdown on a return series → positive fraction [0,1].
export function maxDrawdown(rets: number[]): number {
  let equity = 1, peak = 1, mdd = 0;
  for (const r of rets) {
    equity *= (1 + r);
    if (equity > peak) peak = equity;
    const dd = peak > 0 ? (peak - equity) / peak : 0;
    if (dd > mdd) mdd = dd;
  }
  return fin(mdd);
}

// Turnover: per-period flip rate for 0/1 positions → [0,1].
export function turnover(positions: number[]): number {
  if (positions.length < 2) return 0;
  let chg = 0;
  for (let i = 1; i < positions.length; i++) chg += Math.abs(positions[i] - positions[i - 1]);
  return fin(chg / (positions.length - 1));
}

// Per-regime IC over overlapping forward returns, grouped by label(snap) (null → excluded).
export function regimeBreakdown(
  snaps: BtSnap[], horizonWeeks: number, label: (s: BtSnap) => string | null,
): Record<string, { n: number; ic_spearman: number }> {
  const pairs = forwardReturns(snaps, horizonWeeks);
  const groups: Record<string, { s: number[]; f: number[] }> = {};
  for (const p of pairs) {
    const lab = label(snaps[p.idx]);
    if (lab == null) continue;
    (groups[lab] ??= { s: [], f: [] });
    groups[lab].s.push(snaps[p.idx].score);
    groups[lab].f.push(p.fwd);
  }
  const out: Record<string, { n: number; ic_spearman: number }> = {};
  for (const [lab, g] of Object.entries(groups)) {
    out[lab] = { n: g.s.length, ic_spearman: fin(spearman(g.s, g.f)) };
  }
  return out;
}

export interface BootStat { point: number; ci_lo: number; ci_hi: number; p_value: number; iters: number }

function percentile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const idx = (sorted.length - 1) * q;
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

// Resample n indices by concatenating circular blocks of length blockLen.
function blockResampleIndices(n: number, blockLen: number, rng: () => number): number[] {
  const out: number[] = [];
  while (out.length < n) {
    const start = Math.floor(rng() * n);
    for (let k = 0; k < blockLen && out.length < n; k++) out.push((start + k) % n);
  }
  return out;
}

const MIN_BOOT = 20;

export function blockBootstrapIC(
  pairs: { score: number; fwd: number }[], blockLen: number, iters: number, rng: () => number,
): BootStat {
  const n = pairs.length;
  const scores = pairs.map(p => p.score);
  const fwds = pairs.map(p => p.fwd);
  const point = fin(spearman(scores, fwds));
  if (n < Math.max(blockLen, MIN_BOOT)) {
    return { point, ci_lo: point, ci_hi: point, p_value: point > 0 ? 0 : 1, iters: 0 };
  }
  const stats: number[] = [];
  for (let b = 0; b < iters; b++) {
    const idx = blockResampleIndices(n, blockLen, rng);
    stats.push(fin(spearman(idx.map(i => scores[i]), idx.map(i => fwds[i]))));
  }
  stats.sort((a, b) => a - b);
  const p_value = stats.filter(s => s <= 0).length / stats.length;
  return { point, ci_lo: percentile(stats, 0.025), ci_hi: percentile(stats, 0.975), p_value, iters };
}

export function blockBootstrapSharpe(
  rets: number[], blockLen: number, iters: number, rng: () => number, periodsPerYear: number,
): BootStat {
  const n = rets.length;
  const sharpe = (xs: number[]): number => {
    const s = std(xs);
    return fin(s > 0 ? (mean(xs) / s) * Math.sqrt(periodsPerYear) : 0);
  };
  const point = sharpe(rets);
  if (n < Math.max(blockLen, MIN_BOOT)) {
    return { point, ci_lo: point, ci_hi: point, p_value: point > 0 ? 0 : 1, iters: 0 };
  }
  const stats: number[] = [];
  for (let b = 0; b < iters; b++) {
    stats.push(sharpe(blockResampleIndices(n, blockLen, rng).map(i => rets[i])));
  }
  stats.sort((a, b) => a - b);
  const p_value = stats.filter(s => s <= 0).length / stats.length;
  return { point, ci_lo: percentile(stats, 0.025), ci_hi: percentile(stats, 0.975), p_value, iters };
}
