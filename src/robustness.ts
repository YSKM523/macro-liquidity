import type { BtSnap } from './backtest';
import { spearman, forwardReturns, addDays, mean, std } from './backtest';
import { QT_END_DATE } from './config';

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

export const COVID_SPLIT = '2020-03-01';

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export interface RobustnessResult {
  window: { from: string; to: string; n_snapshots: number; years: number };
  horizon_weeks: number;
  ic: {
    overlapping: { n: number; ic_spearman: number };
    non_overlapping: { n: number; ic_spearman: number };
    bootstrap: BootStat;
  };
  strategy: {
    methodology: 'LEGACY_WEEKLY';
    ann_return: number; buyhold_ann: number; n_periods: number;
    sharpe: BootStat;
    max_drawdown: number;
    turnover_per_period: number; turnover_annual: number;
  };
  regimes: {
    balance_sheet: Record<string, { n: number; ic_spearman: number }>;
    covid: Record<string, { n: number; ic_spearman: number }>;
    qt: Record<string, { n: number; ic_spearman: number }>;
    vix: Record<string, { n: number; ic_spearman: number }>;
  };
  caveats: string[];
}

export function runRobustness(
  snaps: BtSnap[],
  opts?: { horizonWeeks?: number; iters?: number; blockLen?: number; seed?: number },
): RobustnessResult {
  const horizon = opts?.horizonWeeks ?? 13;
  const iters = opts?.iters ?? 2000;
  const blockLen = opts?.blockLen ?? horizon;
  const seed = opts?.seed ?? 12345;
  const rng = mulberry32(seed);

  const from = snaps[0]?.date ?? '';
  const to = snaps.at(-1)?.date ?? '';
  const n_snapshots = snaps.length;
  const years = fin(n_snapshots >= 2 ? daysBetween(from, to) / 365.25 : 0);

  // ---- IC: overlapping + non-overlapping + bootstrap ----
  const olPairs = forwardReturns(snaps, horizon).map(p => ({ score: snaps[p.idx].score, fwd: p.fwd }));
  const overlapping = {
    n: olPairs.length,
    ic_spearman: fin(spearman(olPairs.map(p => p.score), olPairs.map(p => p.fwd))),
  };
  const non_overlapping = nonOverlappingIC(snaps, horizon);
  const bootstrap = blockBootstrapIC(olPairs, blockLen, iters, rng);

  // ---- strategy (long-flat score>55) ----
  const positions: number[] = [];
  const stratRets: number[] = [];
  for (let i = 0; i < snaps.length - 1; i++) {
    const pos = snaps[i].score > 55 ? 1 : 0;
    positions.push(pos);
    stratRets.push(pos * fin(snaps[i + 1].spx / snaps[i].spx - 1));
  }
  const n_periods = stratRets.length;
  const total_strat = fin(stratRets.reduce((a, r) => a * (1 + r), 1) - 1);
  const total_buyhold = n_snapshots >= 2 ? fin(snaps.at(-1)!.spx / snaps[0].spx - 1) : 0;
  const safeYears = years > 0 ? years : 1;
  const ann_return = fin(Math.pow(1 + total_strat, 1 / safeYears) - 1);
  const buyhold_ann = fin(Math.pow(1 + total_buyhold, 1 / safeYears) - 1);
  const ppy = fin(n_periods / safeYears);
  const sharpe = blockBootstrapSharpe(stratRets, blockLen, iters, rng, ppy);
  const tpp = turnover(positions);

  // ---- regimes ----
  const med = median(snaps.filter(s => s.vix != null).map(s => s.vix as number));
  const regimes = {
    balance_sheet: regimeBreakdown(snaps, horizon, s => s.regime ?? null),
    covid: regimeBreakdown(snaps, horizon, s => (s.date < COVID_SPLIT ? 'pre' : 'post')),
    qt: regimeBreakdown(snaps, horizon, s => (s.date < QT_END_DATE ? 'pre' : 'post')),
    vix: regimeBreakdown(snaps, horizon, s => (s.vix == null ? null : (s.vix < med ? 'low' : 'high'))),
  };

  return {
    window: { from, to, n_snapshots, years },
    horizon_weeks: horizon,
    ic: { overlapping, non_overlapping, bootstrap },
    strategy: {
      methodology: 'LEGACY_WEEKLY',
      ann_return, buyhold_ann, n_periods,
      sharpe, max_drawdown: maxDrawdown(stratRets),
      turnover_per_period: tpp, turnover_annual: fin(tpp * ppy),
    },
    regimes,
    caveats: [
      'block bootstrap (seed-fixed) — CI/p quantify overlap autocorrelation; non-overlapping n is the honest independent count',
      'regime splits are descriptive (in-sample) — small-n buckets (esp. post-QT) are noisy',
      'LEGACY_WEEKLY long-flat (score>55) is a coarse proxy; turnover ignores trading costs',
    ],
  };
}
