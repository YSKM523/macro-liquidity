import { describe, it, expect } from 'vitest';
import { weightedFrom, icWeights, runWalkForward } from '../src/walkforward';
import type { WalkForwardResult } from '../src/walkforward';
import { addDays } from '../src/backtest';
import type { BtSnap } from '../src/backtest';

// ---------- helpers ----------

/** Build a weekly snap sequence of length N starting from startDate.
 *  factor `netliqTrend` equals `netliqValue` for each snap.
 *  SPX rises proportionally when netliqValue is high.
 */
function makeSnaps(
  n: number,
  opts: {
    startDate?: string;
    startSpx?: number;
    /** netliqTrend value (0-100) for each index; defaults to 50 */
    netliqFn?: (i: number) => number;
    /** spx value for each index; defaults to linear 1000 + i*10 */
    spxFn?: (i: number) => number;
  } = {},
): BtSnap[] {
  const startDate = opts.startDate ?? '2010-01-01';
  const startSpx = opts.startSpx ?? 1000;
  const netliqFn = opts.netliqFn ?? (() => 50);
  const spxFn = opts.spxFn ?? ((i) => startSpx + i * 10);

  return Array.from({ length: n }, (_, i) => ({
    date: addDays(startDate, i * 7),
    score: 50,
    spx: spxFn(i),
    factors: {
      netliqTrend: netliqFn(i),
      impulse: 50,
      credit: 50,
      funding: 50,
      rates: 50,
      dollar: 50,
      vol: 50,
      reserveAdequacy: 50,
    },
  }));
}

// ---------- weightedFrom ----------

describe('weightedFrom', () => {
  const FACTOR_KEYS = ['netliqTrend','impulse','credit','funding','rates','dollar','vol','reserveAdequacy'];

  it('computes weighted sum correctly with equal weights', () => {
    const factors: Record<string, number> = {};
    for (const k of FACTOR_KEYS) factors[k] = 80;
    const weights: Record<string, number> = {};
    for (const k of FACTOR_KEYS) weights[k] = 1 / FACTOR_KEYS.length;
    expect(weightedFrom(factors, weights)).toBeCloseTo(80);
  });

  it('respects non-uniform weights', () => {
    const factors = {
      netliqTrend: 100,
      impulse: 0,
      credit: 0,
      funding: 0,
      rates: 0,
      dollar: 0,
      vol: 0,
      reserveAdequacy: 0,
    };
    const weights = {
      netliqTrend: 0.5,
      impulse: 0.5,
      credit: 0, funding: 0, rates: 0, dollar: 0, vol: 0, reserveAdequacy: 0,
    };
    // 100*0.5 + 0*0.5 = 50
    expect(weightedFrom(factors, weights)).toBeCloseTo(50);
  });

  it('renormalizes unchanged positive weights across real finite factors', () => {
    expect(weightedFrom({ netliqTrend: 80 }, { netliqTrend: 0.25, credit: 0.75 })).toBe(80);
  });

  it('returns null when no positively weighted real factor is available', () => {
    const factors: Record<string, number> = {};
    for (const k of FACTOR_KEYS) factors[k] = 90;
    const weights: Record<string, number> = {};
    for (const k of FACTOR_KEYS) weights[k] = 0;
    expect(weightedFrom(factors, weights)).toBeNull();
    expect(weightedFrom({}, { netliqTrend: 1 })).toBeNull();
  });
});

// ---------- icWeights ----------

describe('icWeights', () => {
  it('returns equal weights across actually available factors when all available ICs are non-positive', () => {
    // Build snaps where netliqTrend is negatively correlated with future returns
    // and all other factors too — so all ICs <= 0 → fall back to equal weight
    const N = 60;
    // High netliqTrend → SPX goes DOWN (negative IC) for all factors
    const snaps = makeSnaps(N, {
      netliqFn: (i) => (i < N / 2 ? 90 : 10),  // high then low
      spxFn: (i) =>
        i < N / 2
          ? 1000 - i * 10   // falls when netliqTrend=90
          : 1000 - (N / 2) * 10 + (i - N / 2) * 10, // rises when netliqTrend=10
    });
    // All other factors are constant 50 → IC ≈ 0 except netliqTrend (negative)
    const w = icWeights(snaps, 4);
    const AVAILABLE_KEYS = ['netliqTrend','impulse','credit','funding','rates','dollar','vol','reserveAdequacy'];
    for (const k of AVAILABLE_KEYS) {
      expect(w[k]).toBeCloseTo(1 / AVAILABLE_KEYS.length, 5);
    }
    expect(w.curve).toBe(0);
  });

  it('gives the highest weight to the factor most positively correlated with forward returns', () => {
    const N = 80;
    // netliqTrend: high in first half, low in second half
    // SPX: rises sharply in first half, falls in second — so netliqTrend IC > 0
    // all other factors are constant 50 → their IC ≈ 0
    const snaps = makeSnaps(N, {
      netliqFn: (i) => (i < N / 2 ? 90 : 10),
      spxFn: (i) =>
        i < N / 2
          ? 1000 + i * 20   // rises when netliqTrend=90
          : 1000 + (N / 2) * 20 - (i - N / 2) * 10, // falls when netliqTrend=10
    });
    const w = icWeights(snaps, 4);
    const FACTOR_KEYS = ['netliqTrend','impulse','credit','funding','rates','dollar','vol','reserveAdequacy'];
    // netliqTrend should dominate
    for (const other of FACTOR_KEYS.filter(k => k !== 'netliqTrend')) {
      expect(w['netliqTrend']).toBeGreaterThan(w[other]);
    }
    // weights sum to ≈ 1
    const total = FACTOR_KEYS.reduce((s, k) => s + w[k], 0);
    expect(total).toBeCloseTo(1, 5);
  });

  it('all weights are non-negative', () => {
    const N = 60;
    const snaps = makeSnaps(N);
    const w = icWeights(snaps, 4);
    for (const v of Object.values(w)) {
      expect(v).toBeGreaterThanOrEqual(0);
    }
  });

  it('trains each factor IC from only its real finite factor-return pairs', () => {
    const snaps: BtSnap[] = Array.from({ length: 7 }, (_, i) => ({
      date: addDays('2024-01-01', i * 7),
      score: 50,
      spx: [100, 110, 132, 171.6, 240.24, 360.36, 576.576][i],
      factors: (i < 3 ? { credit: [10, 20, 30][i] } : {}) as Record<string, number>,
    }));

    const w = icWeights(snaps, 1);

    expect(w.credit).toBe(1);
    expect(Object.entries(w).filter(([key]) => key !== 'credit').every(([, value]) => value === 0)).toBe(true);
  });
});

// ---------- runWalkForward ----------

describe('runWalkForward', () => {
  /**
   * Build a synthetic series where netliqTrend is high → SPX rises.
   * Use small initialTrain/testN so the test completes quickly and
   * exercises ≥ 1 fold.
   */
  function makePredictiveSnaps(total = 120): BtSnap[] {
    // Block structure: alternate 30-snap blocks of high (90) / low (10)
    const blockSize = 30;
    return makeSnaps(total, {
      netliqFn: (i) => {
        const block = Math.floor(i / blockSize);
        return block % 2 === 0 ? 90 : 10;
      },
      spxFn: (i) => {
        // SPX rises during high-netliqTrend blocks, falls during low
        const block = Math.floor(i / blockSize);
        const posInBlock = i % blockSize;
        let base = 1000;
        for (let b = 0; b < block; b++) {
          if (b % 2 === 0) base += blockSize * 15; // +15/snap during bullish
          else base -= blockSize * 5;              // -5/snap during bearish
        }
        return base + (block % 2 === 0 ? posInBlock * 15 : -posInBlock * 5);
      },
    });
  }

  const SMALL_OPTS = { horizonWeeks: 4, initialTrain: 30, testN: 15, embargo: 4 };

  it('smoke: runs without error and returns expected shape', () => {
    const snaps = makePredictiveSnaps(120);
    const result = runWalkForward(snaps, SMALL_OPTS);
    expect(result).toBeDefined();
    expect(result.config).toBeDefined();
    expect(result.n_snapshots).toBe(snaps.length);
    expect(result.oos).toBeDefined();
    expect(result.folds).toBeInstanceOf(Array);
    expect(result.caveats).toBeInstanceOf(Array);
    expect(result.methodology).toBe('LEGACY_9_SIGNAL_DIAGNOSTIC');
    expect(result.signal_classification).toEqual({
      champion_positive_weight_factors: 8,
      legacy_zero_weight_diagnostics: ['vol'],
    });
  });

  it('produces at least 1 fold', () => {
    const snaps = makePredictiveSnaps(120);
    const result = runWalkForward(snaps, SMALL_OPTS);
    expect(result.folds.length).toBeGreaterThanOrEqual(1);
  });

  it('oos has all three arms', () => {
    const snaps = makePredictiveSnaps(120);
    const result = runWalkForward(snaps, SMALL_OPTS);
    expect(result.oos.wf_fitted).toBeDefined();
    expect(result.oos.current_weights).toBeDefined();
    expect(result.oos.equal_weight).toBeDefined();
  });

  it('all three arms have the same n > 0', () => {
    const snaps = makePredictiveSnaps(120);
    const result = runWalkForward(snaps, SMALL_OPTS);
    const { wf_fitted, current_weights, equal_weight } = result.oos;
    expect(wf_fitted.n).toBe(current_weights.n);
    expect(current_weights.n).toBe(equal_weight.n);
    expect(wf_fitted.n).toBeGreaterThan(0);
  });

  it('wf_fitted OOS IC is positive when signal is genuinely predictive', () => {
    const snaps = makePredictiveSnaps(200);
    // More data → more folds → clearer signal
    const result = runWalkForward(snaps, { horizonWeeks: 4, initialTrain: 40, testN: 20, embargo: 4 });
    expect(result.oos.wf_fitted.ic_spearman).toBeGreaterThan(0);
  });

  it('all numeric output is finite', () => {
    const snaps = makePredictiveSnaps(120);
    const result: WalkForwardResult = runWalkForward(snaps, SMALL_OPTS);
    const checkFinite = (obj: unknown): void => {
      if (typeof obj === 'number') {
        expect(Number.isFinite(obj)).toBe(true);
      } else if (Array.isArray(obj)) {
        for (const v of obj) {
          if (typeof v !== 'string') checkFinite(v);
        }
      } else if (obj !== null && typeof obj === 'object') {
        for (const [, v] of Object.entries(obj)) {
          if (typeof v !== 'string') checkFinite(v);
        }
      }
    };
    checkFinite(result);
  });

  it('config fields match opts passed in', () => {
    const snaps = makePredictiveSnaps(120);
    const result = runWalkForward(snaps, SMALL_OPTS);
    expect(result.config.horizon_weeks).toBe(SMALL_OPTS.horizonWeeks);
    expect(result.config.initialTrain).toBe(SMALL_OPTS.initialTrain);
    expect(result.config.testN).toBe(SMALL_OPTS.testN);
    expect(result.config.embargo).toBe(SMALL_OPTS.embargo);
  });

  it('folds have required fields', () => {
    const snaps = makePredictiveSnaps(120);
    const result = runWalkForward(snaps, SMALL_OPTS);
    for (const fold of result.folds) {
      expect(fold).toHaveProperty('train_to');
      expect(fold).toHaveProperty('test_from');
      expect(fold).toHaveProperty('n');
      expect(fold).toHaveProperty('ic_wf');
      expect(fold).toHaveProperty('wf_top');
      expect(Number.isFinite(fold.ic_wf)).toBe(true);
      expect(Array.isArray(fold.wf_top)).toBe(true);
    }
  });

  it('returns gracefully for too-small series (no folds)', () => {
    const snaps = makePredictiveSnaps(10);
    const result = runWalkForward(snaps, { horizonWeeks: 4, initialTrain: 30, testN: 15, embargo: 4 });
    // Not enough data for even 1 fold — should not throw
    expect(result.folds.length).toBe(0);
    expect(result.oos.wf_fitted.n).toBe(0);
  });

  it('caveats is non-empty array of strings', () => {
    const snaps = makePredictiveSnaps(120);
    const result = runWalkForward(snaps, SMALL_OPTS);
    expect(result.caveats.length).toBeGreaterThan(0);
    expect(typeof result.caveats[0]).toBe('string');
  });
});
