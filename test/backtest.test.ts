import { describe, it, expect } from 'vitest';
import {
  mean, std, pearson, rank, spearman, addDays, forwardReturns, runBacktest,
} from '../src/backtest';
import type { BtSnap } from '../src/backtest';

// ---------- helpers ----------

describe('mean', () => {
  it('computes arithmetic mean', () => {
    expect(mean([1, 2, 3])).toBeCloseTo(2);
  });
  it('returns 0 for empty', () => {
    expect(mean([])).toBe(0);
  });
});

describe('std', () => {
  it('sample std dev', () => {
    expect(std([2, 4, 4, 4, 5, 5, 7, 9])).toBeCloseTo(2.138, 2);
  });
  it('returns 0 for n < 2', () => {
    expect(std([])).toBe(0);
    expect(std([5])).toBe(0);
  });
});

describe('pearson', () => {
  it('perfect positive correlation', () => {
    expect(pearson([1, 2, 3], [2, 4, 6])).toBeCloseTo(1);
  });
  it('perfect negative correlation', () => {
    expect(pearson([1, 2, 3], [6, 4, 2])).toBeCloseTo(-1);
  });
  it('constant series → 0', () => {
    expect(pearson([1, 1, 1], [1, 2, 3])).toBe(0);
  });
  it('length < 3 → 0', () => {
    expect(pearson([1, 2], [1, 2])).toBe(0);
  });
  it('unequal length → 0', () => {
    expect(pearson([1, 2, 3], [1, 2])).toBe(0);
  });
});

describe('rank', () => {
  it('ranks unique values 1-based', () => {
    expect(rank([3, 1, 2])).toEqual([3, 1, 2]);
  });
  it('ties get average rank', () => {
    // [10, 10, 20] → ranks 1.5, 1.5, 3
    const r = rank([10, 10, 20]);
    expect(r[0]).toBeCloseTo(1.5);
    expect(r[1]).toBeCloseTo(1.5);
    expect(r[2]).toBeCloseTo(3);
  });
  it('empty array → empty', () => {
    expect(rank([])).toEqual([]);
  });
});

describe('spearman', () => {
  it('monotone non-linear → ≈1', () => {
    expect(spearman([1, 2, 3, 4], [1, 4, 9, 16])).toBeCloseTo(1);
  });
  it('perfect monotone decrease → ≈-1', () => {
    expect(spearman([1, 2, 3], [3, 2, 1])).toBeCloseTo(-1);
  });
  it('delegates length/constant guards to pearson → 0', () => {
    expect(spearman([1, 1, 1], [1, 2, 3])).toBe(0);
  });
});

describe('addDays', () => {
  it('adds positive days', () => {
    expect(addDays('2024-01-01', 7)).toBe('2024-01-08');
  });
  it('crosses month boundary', () => {
    expect(addDays('2024-01-28', 7)).toBe('2024-02-04');
  });
  it('crosses year boundary', () => {
    expect(addDays('2023-12-28', 7)).toBe('2024-01-04');
  });
  it('adds 0 days is identity', () => {
    expect(addDays('2024-06-15', 0)).toBe('2024-06-15');
  });
});

// ---------- forwardReturns ----------

describe('forwardReturns', () => {
  // Build a weekly sequence of 10 snaps
  function makeSnaps(n: number, startDate = '2024-01-01', startSpx = 1000, step = 10): BtSnap[] {
    const snaps: BtSnap[] = [];
    for (let i = 0; i < n; i++) {
      snaps.push({
        date: addDays(startDate, i * 7),
        score: 50,
        spx: startSpx + i * step,
        factors: {},
      });
    }
    return snaps;
  }

  it('returns pairs for each snap that has a horizon match', () => {
    const snaps = makeSnaps(10); // weekly, 4w horizon = 28 days
    const pairs = forwardReturns(snaps, 4);
    expect(pairs.length).toBeGreaterThan(0);
  });

  it('fwd return for i=0 with h=4w is spx[4]/spx[0]-1', () => {
    const snaps = makeSnaps(10, '2024-01-01', 1000, 100);
    // spx[0]=1000, spx[4]=1400 → fwd = 0.4
    const pairs = forwardReturns(snaps, 4);
    const pair0 = pairs.find(p => p.idx === 0);
    expect(pair0).toBeDefined();
    expect(pair0!.fwd).toBeCloseTo(0.4);
  });

  it('skips snaps too near the end (no target within tolerance)', () => {
    const snaps = makeSnaps(6); // 4w horizon needs ~4 more snaps ahead
    const pairs = forwardReturns(snaps, 4);
    // The last 3 snaps (indices 3,4,5) won't have a target 28 days out
    const indices = pairs.map(p => p.idx);
    // snap at index 5 (last) cannot have 4w forward
    expect(indices).not.toContain(5);
  });
});

// ---------- runBacktest ----------

describe('runBacktest', () => {
  /**
   * Synthetic sequence where high score predicts higher future SPX.
   * Strategy: score = 80 for first half, 30 for second half;
   * SPX rises strongly in the first half then falls in second half.
   * This gives a clear IC_spearman > 0 for any horizon.
   */
  function makeBullishSnaps(): BtSnap[] {
    const snaps: BtSnap[] = [];
    const baseDate = '2020-01-01';
    const N = 60;
    for (let i = 0; i < N; i++) {
      const firstHalf = i < N / 2;
      const score = firstHalf ? 80 : 30;
      // SPX rises 20/week first half, falls 5/week second half
      const spx = firstHalf
        ? 3000 + i * 20
        : 3000 + (N / 2) * 20 - (i - N / 2) * 5;
      snaps.push({
        date: addDays(baseDate, i * 7),
        score,
        spx,
        factors: {
          netliqTrend: score,
          impulse: score,
          credit: score,
          funding: score,
          rates: score,
          dollar: score,
          vol: score,
        },
      });
    }
    return snaps;
  }

  const snaps = makeBullishSnaps();
  let result: ReturnType<typeof runBacktest>;

  it('runs without error and produces expected shape', () => {
    result = runBacktest(snaps);
    expect(result).toBeDefined();
    expect(result.window).toBeDefined();
    expect(result.horizons).toBeDefined();
    expect(result.factor_ic_spearman).toBeDefined();
    expect(result.strategy_long_flat).toBeDefined();
    expect(result.caveats).toBeInstanceOf(Array);
  });

  it('window fields are correct', () => {
    result = runBacktest(snaps);
    expect(result.window.n_snapshots).toBe(snaps.length);
    expect(result.window.from).toBe(snaps[0].date);
    expect(result.window.to).toBe(snaps[snaps.length - 1].date);
    expect(result.window.years).toBeGreaterThan(0);
  });

  it('ic_spearman > 0 when score predicts forward returns', () => {
    result = runBacktest(snaps);
    expect(result.horizons['4w']).toBeDefined();
    expect(result.horizons['4w'].ic_spearman).toBeGreaterThan(0);
  });

  it('hit_rate >= 0.5 for positive-IC signal', () => {
    result = runBacktest(snaps);
    expect(result.horizons['4w'].hit_rate).toBeGreaterThanOrEqual(0.5);
  });

  it('n is reported in each horizon', () => {
    result = runBacktest(snaps);
    for (const h of ['4w', '8w', '13w']) {
      expect(result.horizons[h].n).toBeGreaterThan(0);
    }
  });

  it('factor_ic_spearman has keys for each factor and horizon', () => {
    result = runBacktest(snaps);
    const factorKeys = ['netliqTrend', 'impulse', 'credit', 'funding', 'rates', 'dollar', 'vol'];
    for (const fk of factorKeys) {
      expect(result.factor_ic_spearman[fk]).toBeDefined();
      for (const h of ['4w', '8w', '13w']) {
        expect(result.factor_ic_spearman[fk][h]).toBeDefined();
      }
    }
  });

  it('strategy_long_flat has required fields', () => {
    result = runBacktest(snaps);
    const s = result.strategy_long_flat;
    expect(s).toHaveProperty('ann_return');
    expect(s).toHaveProperty('buyhold_ann');
    expect(s).toHaveProperty('sharpe');
    expect(s).toHaveProperty('n_periods');
    expect(s.n_periods).toBe(snaps.length - 1);
  });

  it('all numeric output is finite', () => {
    result = runBacktest(snaps);
    const checkFinite = (obj: unknown, path = ''): void => {
      if (typeof obj === 'number') {
        expect(Number.isFinite(obj)).toBe(true);
      } else if (Array.isArray(obj)) {
        // caveats is string array — skip
      } else if (obj !== null && typeof obj === 'object') {
        for (const [k, v] of Object.entries(obj)) {
          if (typeof v !== 'string') checkFinite(v, `${path}.${k}`);
        }
      }
    };
    checkFinite(result);
  });

  it('caveats is a non-empty string array', () => {
    result = runBacktest(snaps);
    expect(result.caveats.length).toBeGreaterThan(0);
    expect(typeof result.caveats[0]).toBe('string');
  });

  it('handles empty snaps gracefully', () => {
    const r = runBacktest([]);
    expect(r.window.n_snapshots).toBe(0);
    expect(r.window.years).toBe(0);
    expect(r.strategy_long_flat.n_periods).toBe(0);
  });

  it('handles single snap gracefully', () => {
    const r = runBacktest([snaps[0]]);
    expect(r.window.n_snapshots).toBe(1);
    expect(r.strategy_long_flat.n_periods).toBe(0);
    expect(r.strategy_long_flat.sharpe).toBe(0);
  });
});
