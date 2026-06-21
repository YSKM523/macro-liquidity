/**
 * research-lib.mjs — pure stats for Phase R factor research.
 * Ported from src/robustness.ts + src/backtest.ts (research-only; no Date.now/Math.random).
 * Reuses spearman/rank/asOf from global-lib.mjs.
 */
import { spearman, rank } from './global-lib.mjs';

// Seeded PRNG (identical to robustness.ts mulberry32)
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function addDays(date, days) {
  const d = new Date(date + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// Forward return over horizonWeeks, target found within +14 days (mirrors backtest.ts).
export function forwardReturns(snaps, horizonWeeks) {
  const out = [];
  for (let i = 0; i < snaps.length; i++) {
    const target = addDays(snaps[i].date, horizonWeeks * 7);
    const limit = addDays(target, 14);
    let k = -1;
    for (let j = i + 1; j < snaps.length; j++) {
      if (snaps[j].date >= target && snaps[j].date <= limit) { k = j; break; }
      if (snaps[j].date > limit) break;
    }
    if (k < 0) continue;
    const base = snaps[i].spx;
    if (base == null || base === 0 || snaps[k].spx == null) continue;
    out.push({ idx: i, fwd: (snaps[k].spx - base) / base });
  }
  return out;
}

// Independent samples: greedy step by date >= last taken + horizonWeeks*7 days.
export function nonOverlappingIC(pairs, horizonWeeks) {
  const xs = [], ys = [];
  let lastDate = null;
  for (const p of pairs) {
    if (lastDate === null || p.date >= addDays(lastDate, horizonWeeks * 7)) {
      xs.push(p.x); ys.push(p.fwd); lastDate = p.date;
    }
  }
  return { n: xs.length, ic: xs.length >= 3 ? spearman(xs, ys) : 0 };
}

function percentile(sorted, q) {
  if (sorted.length === 0) return 0;
  const idx = (sorted.length - 1) * q;
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

// Moving-block bootstrap of IC. Circular blocks of length blockLen.
export function blockBootstrapIC(pairs, blockLen, iters, rng) {
  const n = pairs.length;
  const point = n >= 3 ? spearman(pairs.map(p => p.x), pairs.map(p => p.fwd)) : 0;
  const floor = Math.max(blockLen, 20);
  if (n < floor) {
    return { point, ci_lo: point, ci_hi: point, p_value: point > 0 ? 0 : 1, iters: 0 };
  }
  const stats = [];
  const nBlocks = Math.ceil(n / blockLen);
  for (let it = 0; it < iters; it++) {
    const xs = [], ys = [];
    for (let b = 0; b < nBlocks; b++) {
      const start = Math.floor(rng() * n);
      for (let j = 0; j < blockLen && xs.length < n; j++) {
        const p = pairs[(start + j) % n];
        xs.push(p.x); ys.push(p.fwd);
      }
    }
    stats.push(spearman(xs, ys));
  }
  stats.sort((a, b) => a - b);
  const le0 = stats.filter(s => s <= 0).length;
  return {
    point,
    ci_lo: percentile(stats, 0.025),
    ci_hi: percentile(stats, 0.975),
    p_value: le0 / stats.length,
    iters,
  };
}

// Group pairs by label(pair) (null excluded), spearman within each group.
export function regimeBreakdown(pairs, label) {
  const groups = {};
  for (const p of pairs) {
    const k = label(p);
    if (k == null) continue;
    (groups[k] ??= { xs: [], ys: [] });
    groups[k].xs.push(p.x); groups[k].ys.push(p.fwd);
  }
  const out = {};
  for (const [k, g] of Object.entries(groups)) {
    out[k] = { n: g.xs.length, ic: g.xs.length >= 3 ? spearman(g.xs, g.ys) : 0 };
  }
  return out;
}

// Expanding-window percentile → 0..100, oriented by sign. Zero-tuning research score.
export function percentileScore(value, history, sign) {
  if (!history || history.length === 0) return 50;
  const below = history.filter(h => h <= value).length;
  const p = below / history.length;          // 0..1
  return (sign < 0 ? 1 - p : p) * 100;
}

// Residual IC: rank-space OLS of candidate on composite, correlate residual with forward.
export function residualIC(xs, comps, fwds) {
  if (xs.length < 3) return 0;
  const rx = rank(xs), rc = rank(comps);
  const n = rx.length;
  const mc = rc.reduce((a, b) => a + b, 0) / n;
  const mx = rx.reduce((a, b) => a + b, 0) / n;
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) { num += (rc[i] - mc) * (rx[i] - mx); den += (rc[i] - mc) ** 2; }
  const b = den === 0 ? 0 : num / den;
  const a = mx - b * mc;
  const resid = rx.map((v, i) => v - (a + b * rc[i]));
  return spearman(resid, fwds);
}
