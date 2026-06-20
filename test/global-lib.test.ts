// @ts-nocheck — imports a .mjs file; logic is tested, types not needed here
import { describe, it, expect } from 'vitest';
import {
  rank,
  pearson,
  spearman,
  asOf,
  buildGlobalLiquidity,
  pctChangeWeeks,
  leadLagIC,
} from '../scripts/global-lib.mjs';

// ---------- rank ----------

describe('rank', () => {
  it('ranks unique values 1-based', () => {
    // [3,1,2] → positions: 3→rank3, 1→rank1, 2→rank2
    expect(rank([3, 1, 2])).toEqual([3, 1, 2]);
  });
  it('ties get average rank', () => {
    // [10, 10, 20] → sorted: 10(pos1),10(pos2),20(pos3) → avg rank for 10 = 1.5
    const r = rank([10, 10, 20]);
    expect(r[0]).toBeCloseTo(1.5);
    expect(r[1]).toBeCloseTo(1.5);
    expect(r[2]).toBeCloseTo(3);
  });
  it('empty array → empty', () => {
    expect(rank([])).toEqual([]);
  });
  it('single element → rank 1', () => {
    expect(rank([42])).toEqual([1]);
  });
  it('all ties get same average rank', () => {
    // [5,5,5] → sorted positions 1,2,3 → avg = 2
    const r = rank([5, 5, 5]);
    expect(r[0]).toBeCloseTo(2);
    expect(r[1]).toBeCloseTo(2);
    expect(r[2]).toBeCloseTo(2);
  });
});

// ---------- pearson ----------

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
  it('n < 3 → 0', () => {
    expect(pearson([1, 2], [1, 2])).toBe(0);
  });
  it('unequal length → 0', () => {
    expect(pearson([1, 2, 3], [1, 2])).toBe(0);
  });
  it('zero denominator (both constant) → 0', () => {
    expect(pearson([1, 1, 1], [2, 2, 2])).toBe(0);
  });
});

// ---------- spearman ----------

describe('spearman', () => {
  it('monotone non-linear (quadratic) → ≈1', () => {
    expect(spearman([1, 2, 3, 4], [1, 4, 9, 16])).toBeCloseTo(1);
  });
  it('perfect monotone decrease → ≈-1', () => {
    expect(spearman([1, 2, 3], [3, 2, 1])).toBeCloseTo(-1);
  });
  it('delegates constant guard to pearson → 0', () => {
    expect(spearman([1, 1, 1], [1, 2, 3])).toBe(0);
  });
  it('perfect positive monotone → ≈1', () => {
    expect(spearman([10, 20, 30, 40], [100, 200, 300, 400])).toBeCloseTo(1);
  });
});

// ---------- asOf ----------

describe('asOf', () => {
  const series = [
    { date: '2024-01-01', value: 10 },
    { date: '2024-01-08', value: 20 },
    { date: '2024-01-15', value: 30 },
  ];

  it('returns exact match value', () => {
    expect(asOf(series, '2024-01-08')).toBe(20);
  });
  it('forward-fills: returns last value on/before date', () => {
    expect(asOf(series, '2024-01-10')).toBe(20);
  });
  it('date before all series → null', () => {
    expect(asOf(series, '2023-12-31')).toBeNull();
  });
  it('date after all series → last value', () => {
    expect(asOf(series, '2024-12-31')).toBe(30);
  });
  it('exact last date → last value', () => {
    expect(asOf(series, '2024-01-15')).toBe(30);
  });
  it('empty series → null', () => {
    expect(asOf([], '2024-01-01')).toBeNull();
  });
});

// ---------- buildGlobalLiquidity (hand-computed unit-conversion test) ----------

describe('buildGlobalLiquidity', () => {
  /**
   * Hand-computed test for GL at t='2024-01-10':
   *
   * WALCL at 2024-01-10 = 7_000_000 (million USD) → 7000 billion USD
   * ECB at 2024-01-10  = 8_000_000 (million EUR), DEXUSEU=1.1 (USD/EUR)
   *   → ECB_USD = 8_000_000 × 1.1 = 8_800_000 million USD → 8800 billion USD
   * BOJ at 2024-01-10  = 600_000 (100-million JPY = 億円), × 100 = 60_000_000 million JPY
   *   DEXJPUS = 150 (JPY/USD)
   *   → BOJ_USD = 60_000_000 / 150 = 400_000 million USD → 400 billion USD
   *
   * GL = 7000 + 8800 + 400 = 16200 billion USD
   */
  const walcl = [
    { date: '2024-01-03', value: 6_900_000 },
    { date: '2024-01-10', value: 7_000_000 }, // WALCL in million USD
  ];
  const ecb = [
    { date: '2024-01-05', value: 8_000_000 }, // ECB assets in million EUR
  ];
  const dexuseu = [
    { date: '2024-01-02', value: 1.1 }, // USD per EUR
  ];
  const boj = [
    { date: '2024-01-07', value: 600_000 }, // BOJ assets in 億円 (100M JPY units)
  ];
  const dexjpus = [
    { date: '2024-01-02', value: 150 }, // JPY per USD
  ];

  it('computes GL at hand-checked date = 16200 billion USD', () => {
    const gl = buildGlobalLiquidity(walcl, ecb, dexuseu, boj, dexjpus);
    const point = gl.find((p) => p.date === '2024-01-10');
    expect(point).toBeDefined();
    expect(point!.gl).toBeCloseTo(16200, 1);
  });

  it('returns ascending date order', () => {
    const gl = buildGlobalLiquidity(walcl, ecb, dexuseu, boj, dexjpus);
    for (let i = 1; i < gl.length; i++) {
      expect(gl[i].date >= gl[i - 1].date).toBe(true);
    }
  });

  it('skips dates where any component is null (no data before series start)', () => {
    // WALCL has date 2024-01-03 — but no ECB/BOJ data before that date
    // so 2024-01-03 should be skipped (ECB first obs is 2024-01-05 which is > 2024-01-03)
    const gl = buildGlobalLiquidity(walcl, ecb, dexuseu, boj, dexjpus);
    const point = gl.find((p) => p.date === '2024-01-03');
    // ECB asOf 2024-01-03 returns null (first ECB point is 2024-01-05 > 2024-01-03)
    expect(point).toBeUndefined();
  });

  it('returns empty array if walcl is empty', () => {
    expect(buildGlobalLiquidity([], ecb, dexuseu, boj, dexjpus)).toEqual([]);
  });
});

// ---------- pctChangeWeeks ----------

describe('pctChangeWeeks', () => {
  // Build a series: week 0=1000, week 4=1200, week 8=1440, ...
  const series = [
    { date: '2024-01-01', value: 1000 },
    { date: '2024-01-29', value: 1200 }, // ~4 weeks (28 days) later
    { date: '2024-02-26', value: 1440 }, // ~4 more weeks (28 days)
  ];

  it('computes % change over 4 weeks correctly', () => {
    // At 2024-01-29, 4 weeks back = 2024-01-01 (asOf) → value=1000
    // pct = (1200/1000 - 1) = 0.20 = 20%
    const result = pctChangeWeeks(series, '2024-01-29', 4);
    expect(result).toBeCloseTo(0.2);
  });

  it('returns null when prior data does not exist', () => {
    // 4 weeks before 2024-01-01 = 2023-12-04, no data
    const result = pctChangeWeeks(series, '2024-01-01', 4);
    expect(result).toBeNull();
  });

  it('works for 8 weeks lookback', () => {
    // At 2024-02-26, 8 weeks back = 2024-01-01 → value=1000
    // pct = (1440/1000 - 1) = 0.44
    const result = pctChangeWeeks(series, '2024-02-26', 8);
    expect(result).toBeCloseTo(0.44);
  });

  it('handles same-value (no change) = 0', () => {
    const flat = [
      { date: '2024-01-01', value: 1000 },
      { date: '2024-02-01', value: 1000 },
    ];
    const result = pctChangeWeeks(flat, '2024-02-01', 4);
    expect(result).toBeCloseTo(0);
  });
});

// ---------- leadLagIC ----------

describe('leadLagIC', () => {
  /**
   * Synthetic scenario for leadLagIC:
   *
   * We directly construct N=20 "observation episodes" spaced 30 weeks apart.
   * For each episode t_k (k=0..19):
   *   - GL grows by (+1)^k * 10% over weeks [t_k-13, t_k]  (alternating up/down)
   *   - SPX level at t_k+LAG = 1000, at t_k+LAG+13 = 1000*(1 + (+1)^k * 0.10)
   *
   * So leadLagIC at lead=LAG pairs glGrowth[k] with spxReturn[k], both ≈ (+1)^k * 0.10.
   * Spearman IC should be ≈ 1.
   *
   * At lead=0: SPX return from t_k to t_k+13 is NOT set by our construction
   * (it's whatever value is between episodes), so IC should be low.
   *
   * LAG = 4 weeks.
   * Episode spacing = 30 weeks (> LAG + fwdWeeks = 17, no overlap between episodes).
   */
  const LAG = 4;
  const N_EPISODES = 20;
  const EPISODE_SPACING = 30; // weeks between episode anchor points
  const BASE_MS = new Date('2002-01-02').getTime();

  function weekDate(weekIdx: number): string {
    return new Date(BASE_MS + weekIdx * 7 * 86400000).toISOString().slice(0, 10);
  }

  function buildSyntheticData() {
    // Build sparse GL series: just enough points to compute pctChangeWeeks
    // Each episode anchor at week t_k = 14 + k * EPISODE_SPACING
    // We need GL at t_k and t_k-13.
    const glSeries: { date: string; gl: number }[] = [];
    const spxSeries: { date: string; value: number }[] = [];

    for (let k = 0; k < N_EPISODES; k++) {
      const anchor = 14 + k * EPISODE_SPACING; // GL date t_k
      const sign = k % 2 === 0 ? 1 : -1; // alternating

      // GL: level at t_k-13 = 10000, at t_k = 10000 * (1 + sign*0.10)
      const gl_prior = 10000;
      const gl_curr = gl_prior * (1 + sign * 0.10);
      glSeries.push({ date: weekDate(anchor - 13), gl: gl_prior });
      glSeries.push({ date: weekDate(anchor), gl: gl_curr });

      // SPX: at t_k+LAG = 1000, at t_k+LAG+13 = 1000*(1 + sign*0.10)
      // (same sign as GL growth → perfect correlation at lead=LAG)
      const spx_start = 1000 + k * 0.01; // small offset so Spearman has distinct ranks
      const spx_end = spx_start * (1 + sign * 0.10);
      spxSeries.push({ date: weekDate(anchor + LAG), value: spx_start });
      spxSeries.push({ date: weekDate(anchor + LAG + 13), value: spx_end });

      // For lead=0 test: SPX at t_k = some value with OPPOSITE sign,
      // so lead=0 actually anti-correlates slightly with GL growth.
      // (We don't set SPX at t_k+13 for the opposite, just leave it at the LAG window)
      // Actually we just leave the SPX series sparse — at t_k and t_k+13 for lead=0,
      // asOfWithTolerance would pick up the nearest point, which is the LAG window start.
      // That means lead=0 pairs glGrowth[k] with spx return from t_k to t_k+13,
      // but SPX at t_k is whatever asOf returns from the previous episode's LAG window end.
      // This is messy. Better: explicitly add SPX at t_k with a flat/noise return.
      // Use SPX value = constant for lead=0 window → return ≈ 0 → IC ≈ 0 at lead=0.
      spxSeries.push({ date: weekDate(anchor), value: 500 });
      spxSeries.push({ date: weekDate(anchor + 13), value: 500 });
    }

    // Sort both series by date
    glSeries.sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : 0);
    spxSeries.sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : 0);

    // Deduplicate by taking the last value for any duplicate dates in spxSeries
    const spxDeduped: { date: string; value: number }[] = [];
    for (const pt of spxSeries) {
      if (spxDeduped.length > 0 && spxDeduped[spxDeduped.length - 1].date === pt.date) {
        spxDeduped[spxDeduped.length - 1].value = pt.value; // keep last
      } else {
        spxDeduped.push({ ...pt });
      }
    }

    // Deduplicate GL by keeping last value for duplicate dates
    const glDeduped: { date: string; gl: number }[] = [];
    for (const pt of glSeries) {
      if (glDeduped.length > 0 && glDeduped[glDeduped.length - 1].date === pt.date) {
        glDeduped[glDeduped.length - 1].gl = pt.gl;
      } else {
        glDeduped.push({ ...pt });
      }
    }

    return { glSeries: glDeduped, spxSeries: spxDeduped };
  }

  it('IC at optimal lead (LAG=4) is higher than IC at lead=0', () => {
    const { glSeries, spxSeries } = buildSyntheticData();
    const icAtLag = leadLagIC(glSeries, spxSeries, LAG);
    const icAt0 = leadLagIC(glSeries, spxSeries, 0);

    // Both should have enough samples
    expect(icAtLag.n).toBeGreaterThan(5);

    // IC at lead=LAG should be clearly higher than lead=0
    expect(icAtLag.ic).toBeGreaterThan(icAt0.ic);
  });

  it('IC at lead=LAG is meaningfully positive (>0.5) for clear synthetic signal', () => {
    const { glSeries, spxSeries } = buildSyntheticData();
    const result = leadLagIC(glSeries, spxSeries, LAG);
    expect(result.ic).toBeGreaterThan(0.5);
  });

  it('returns {ic, n} shape', () => {
    const { glSeries, spxSeries } = buildSyntheticData(40);
    const result = leadLagIC(glSeries, spxSeries, 0);
    expect(result).toHaveProperty('ic');
    expect(result).toHaveProperty('n');
    expect(typeof result.ic).toBe('number');
    expect(typeof result.n).toBe('number');
  });

  it('returns n=0 and ic=0 when series is too short for any pairs', () => {
    const tinyGl = [{ date: '2024-01-01', gl: 100 }];
    const tinySpx = [{ date: '2024-01-01', value: 1000 }];
    const result = leadLagIC(tinyGl, tinySpx, 4);
    expect(result.n).toBe(0);
    expect(result.ic).toBe(0);
  });
});
