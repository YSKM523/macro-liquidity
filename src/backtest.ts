export interface BtSnap {
  date: string;
  score: number;
  spx: number;
  factors: Record<string, number>;
  regime?: string;
  vix?: number;
}

export interface BacktestResult {
  window: { from: string; to: string; n_snapshots: number; years: number };
  horizons: Record<string, { n: number; ic_spearman: number; ic_pearson: number; hit_rate: number }>;
  factor_ic_spearman: Record<string, Record<string, number>>;
  strategy_long_flat: { ann_return: number; buyhold_ann: number; sharpe: number; n_periods: number };
  caveats: string[];
}

// ---------- primitives ----------

export function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

/** Sample standard deviation (ddof=1). Returns 0 for n < 2. */
export function std(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  const v = xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1);
  return Math.sqrt(v);
}

/** Pearson correlation. Returns 0 for n < 3, unequal lengths, or zero std. */
export function pearson(xs: number[], ys: number[]): number {
  if (xs.length !== ys.length || xs.length < 3) return 0;
  const mx = mean(xs), my = mean(ys);
  let num = 0, dx2 = 0, dy2 = 0;
  for (let i = 0; i < xs.length; i++) {
    const dx = xs[i] - mx, dy = ys[i] - my;
    num += dx * dy;
    dx2 += dx * dx;
    dy2 += dy * dy;
  }
  const denom = Math.sqrt(dx2 * dy2);
  if (denom === 0) return 0;
  return fin(num / denom);
}

/** Average-rank ranking (1-based). Ties get the average of their ranks. */
export function rank(xs: number[]): number[] {
  if (xs.length === 0) return [];
  const indexed = xs.map((v, i) => ({ v, i }));
  indexed.sort((a, b) => a.v - b.v);
  const out = new Array<number>(xs.length);
  let p = 0;
  while (p < indexed.length) {
    let q = p;
    while (q + 1 < indexed.length && indexed[q + 1].v === indexed[p].v) q++;
    const avgRank = (p + 1 + q + 1) / 2; // 1-based average
    for (let k = p; k <= q; k++) out[indexed[k].i] = avgRank;
    p = q + 1;
  }
  return out;
}

export function spearman(xs: number[], ys: number[]): number {
  return pearson(rank(xs), rank(ys));
}

/** Add days to a UTC date string (YYYY-MM-DD). */
export function addDays(date: string, days: number): string {
  const d = new Date(date + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function daysBetween(a: string, b: string): number {
  const ta = new Date(a + 'T00:00:00Z').getTime();
  const tb = new Date(b + 'T00:00:00Z').getTime();
  return Math.round((tb - ta) / 86_400_000);
}

/** Guard NaN/Infinity → 0. */
function fin(x: number): number {
  return Number.isFinite(x) ? x : 0;
}

// ---------- forwardReturns ----------

export function forwardReturns(
  snaps: BtSnap[],
  horizonWeeks: number,
): { idx: number; fwd: number }[] {
  const hDays = horizonWeeks * 7;
  const results: { idx: number; fwd: number }[] = [];
  for (let i = 0; i < snaps.length; i++) {
    const target = addDays(snaps[i].date, hDays);
    // find smallest j >= i+1 where snaps[j].date >= target
    let j = -1;
    for (let k = i + 1; k < snaps.length; k++) {
      if (snaps[k].date >= target) { j = k; break; }
    }
    if (j === -1) continue;
    const actual = daysBetween(snaps[i].date, snaps[j].date);
    if (actual > hDays + 14) continue;
    const fwd = fin(snaps[j].spx / snaps[i].spx - 1);
    results.push({ idx: i, fwd });
  }
  return results;
}

// ---------- runBacktest ----------

const DEFAULT_HORIZONS = [4, 8, 13];
const DEFAULT_FACTOR_KEYS = ['netliqTrend', 'impulse', 'credit', 'funding', 'rates', 'dollar', 'vol', 'reserveAdequacy', 'curve'];

export function runBacktest(
  snaps: BtSnap[],
  horizons = DEFAULT_HORIZONS,
  factorKeys = DEFAULT_FACTOR_KEYS,
): BacktestResult {
  // ---- window ----
  const n_snapshots = snaps.length;
  const from = snaps[0]?.date ?? '';
  const to = snaps.at(-1)?.date ?? '';
  const years = fin(n_snapshots >= 2 ? daysBetween(from, to) / 365.25 : 0);

  // ---- horizons ----
  const horizonResult: BacktestResult['horizons'] = {};
  const factorIcResult: BacktestResult['factor_ic_spearman'] = {};

  for (const h of horizons) {
    const pairs = forwardReturns(snaps, h);
    const n = pairs.length;
    const scores = pairs.map(p => snaps[p.idx].score);
    const fwds = pairs.map(p => p.fwd);

    const ic_spearman = fin(spearman(scores, fwds));
    const ic_pearson = fin(pearson(scores, fwds));

    let hit = 0;
    for (const p of pairs) {
      if ((snaps[p.idx].score >= 50) === (p.fwd >= 0)) hit++;
    }
    const hit_rate = fin(n > 0 ? hit / n : 0);

    horizonResult[`${h}w`] = { n, ic_spearman, ic_pearson, hit_rate };

    // per-factor IC
    for (const fk of factorKeys) {
      const factorVals = pairs.map(p => snaps[p.idx].factors[fk] ?? 0);
      factorIcResult[fk] ??= {};
      factorIcResult[fk][`${h}w`] = fin(spearman(factorVals, fwds));
    }
  }

  // ---- strategy_long_flat ----
  const strat = (() => {
    if (snaps.length < 2) {
      return { ann_return: 0, buyhold_ann: 0, sharpe: 0, n_periods: 0 };
    }
    const n_periods = snaps.length - 1;
    const stratRets: number[] = [];
    for (let i = 0; i < n_periods; i++) {
      const position = snaps[i].score > 55 ? 1 : 0;
      const period_ret = fin(snaps[i + 1].spx / snaps[i].spx - 1);
      stratRets.push(position * period_ret);
    }
    const total_strat = fin(stratRets.reduce((acc, r) => acc * (1 + r), 1) - 1);
    const total_buyhold = fin(snaps.at(-1)!.spx / snaps[0].spx - 1);

    const safeYears = years > 0 ? years : 1;
    const ann_return = fin(Math.pow(1 + total_strat, 1 / safeYears) - 1);
    const buyhold_ann = fin(Math.pow(1 + total_buyhold, 1 / safeYears) - 1);

    const ppy = fin(n_periods / safeYears);
    const s = std(stratRets);
    const sharpe = fin(s > 0 ? (mean(stratRets) / s) * Math.sqrt(ppy) : 0);

    return { ann_return, buyhold_ann, sharpe, n_periods };
  })();

  return {
    window: { from, to, n_snapshots, years },
    horizons: horizonResult,
    factor_ic_spearman: factorIcResult,
    strategy_long_flat: strat,
    caveats: [
      'history 2020+ short & COVID-biased — directional evidence not proof',
      'overlapping forward windows overstate significance — n reported',
      'uneven snapshot spacing — strategy Sharpe approximate',
    ],
  };
}
