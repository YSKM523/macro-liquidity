import type { BtSnap } from './backtest';
import { spearman, forwardReturns } from './backtest';
import { WEIGHTS } from './config';

const FACTOR_KEYS = ['netliqTrend','impulse','credit','funding','rates','dollar','vol','reserveAdequacy','curve'];

// Weighted sum of factors (each 0-100, weights sum ≈ 1 → result 0-100)
export function weightedFrom(factors: Record<string, number>, weights: Record<string, number>): number {
  let s = 0;
  for (const k of FACTOR_KEYS) s += (factors[k] ?? 50) * (weights[k] ?? 0);
  return s;
}

// Derive IC-based weights from a training window.
// w_f = max(0, IC_f) normalised; all IC ≤ 0 → equal weights.
export function icWeights(window: BtSnap[], horizonWeeks: number): Record<string, number> {
  const pairs = forwardReturns(window, horizonWeeks);
  const fwds = pairs.map(p => p.fwd);
  const raw: Record<string, number> = {};
  let sum = 0;
  for (const k of FACTOR_KEYS) {
    const xs = pairs.map(p => window[p.idx].factors[k] ?? 50);
    const w = Math.max(0, spearman(xs, fwds));
    raw[k] = w;
    sum += w;
  }
  if (!(sum > 0)) {
    const eq = 1 / FACTOR_KEYS.length;
    return Object.fromEntries(FACTOR_KEYS.map(k => [k, eq]));
  }
  return Object.fromEntries(FACTOR_KEYS.map(k => [k, raw[k] / sum]));
}

function hitRate(scores: number[], fwds: number[]): number {
  if (!scores.length) return 0;
  let h = 0;
  for (let i = 0; i < scores.length; i++) {
    if ((scores[i] >= 50) === (fwds[i] >= 0)) h++;
  }
  return h / scores.length;
}

const fin = (x: number): number => (Number.isFinite(x) ? x : 0);

function topWeights(w: Record<string, number>): string[] {
  return Object.entries(w)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([k, v]) => `${k} ${v.toFixed(2)}`);
}

export interface WalkForwardResult {
  config: {
    horizon_weeks: number;
    initialTrain: number;
    testN: number;
    embargo: number;
    folds: number;
  };
  n_snapshots: number;
  oos: {
    wf_fitted: { ic_spearman: number; hit_rate: number; n: number };
    current_weights: { ic_spearman: number; hit_rate: number; n: number };
    equal_weight: { ic_spearman: number; hit_rate: number; n: number };
  };
  folds: Array<{
    train_to: string;
    test_from: string;
    n: number;
    ic_wf: number;
    wf_top: string[];
  }>;
  caveats: string[];
}

export function runWalkForward(
  snaps: BtSnap[],
  opts?: { horizonWeeks?: number; initialTrain?: number; testN?: number; embargo?: number },
): WalkForwardResult {
  const horizon = opts?.horizonWeeks ?? 13;
  const initialTrain = opts?.initialTrain ?? 200;
  const testN = opts?.testN ?? 52;
  const embargo = opts?.embargo ?? horizon;
  const current = WEIGHTS as unknown as Record<string, number>;
  const equal = Object.fromEntries(FACTOR_KEYS.map(k => [k, 1 / FACTOR_KEYS.length]));

  const acc = {
    wf:  { s: [] as number[], f: [] as number[] },
    cur: { s: [] as number[], f: [] as number[] },
    eq:  { s: [] as number[], f: [] as number[] },
  };
  const folds: WalkForwardResult['folds'] = [];

  let trainEnd = initialTrain;
  while (trainEnd + embargo < snaps.length) {
    const train = snaps.slice(0, trainEnd);
    const testStart = trainEnd + embargo;
    const tail = snaps.slice(testStart);
    // Forward-return pairs where the starting index is within the first testN snaps of this test window
    const pairs = forwardReturns(tail, horizon).filter(p => p.idx < testN);
    if (pairs.length < 5) { trainEnd += testN; continue; }

    const wfW = icWeights(train, horizon);
    const fs: number[] = [];
    const ff: number[] = [];

    for (const p of pairs) {
      const fac = tail[p.idx].factors;
      const wfScore  = weightedFrom(fac, wfW);
      const curScore = weightedFrom(fac, current);
      const eqScore  = weightedFrom(fac, equal);

      acc.wf.s.push(wfScore);   acc.wf.f.push(p.fwd);
      acc.cur.s.push(curScore); acc.cur.f.push(p.fwd);
      acc.eq.s.push(eqScore);   acc.eq.f.push(p.fwd);
      fs.push(wfScore);
      ff.push(p.fwd);
    }

    folds.push({
      train_to:  train[train.length - 1].date,
      test_from: tail[0].date,
      n:         pairs.length,
      ic_wf:     fin(spearman(fs, ff)),
      wf_top:    topWeights(wfW),
    });

    trainEnd += testN;
  }

  const arm = (a: { s: number[]; f: number[] }) => ({
    ic_spearman: fin(spearman(a.s, a.f)),
    hit_rate:    fin(hitRate(a.s, a.f)),
    n:           a.s.length,
  });

  return {
    config: { horizon_weeks: horizon, initialTrain, testN, embargo, folds: folds.length },
    n_snapshots: snaps.length,
    oos: {
      wf_fitted:       arm(acc.wf),
      current_weights: arm(acc.cur),
      equal_weight:    arm(acc.eq),
    },
    folds,
    caveats: [
      'short sample (2016+) & weak signal → OOS IC very noisy; treat as directional, not proof',
      'overlapping forward windows (embargo applied) still leave residual autocorrelation',
      'icWeights uses in-train factor IC (non-negative normalized) — a simple, low-overfit fit',
    ],
  };
}
