import { describe, it, expect } from 'vitest';
import { mulberry32, nonOverlappingIC, maxDrawdown, turnover, regimeBreakdown, blockBootstrapIC, blockBootstrapSharpe, runRobustness } from '../src/robustness';

function wkSnaps(n: number, scoreFn: (i: number) => number, spxFn: (i: number) => number, extra: (i: number) => any = () => ({})): any[] {
  return Array.from({ length: n }, (_, i) => ({
    date: new Date(Date.UTC(2020, 0, 6 + i * 7)).toISOString().slice(0, 10),
    score: scoreFn(i), spx: spxFn(i), factors: {}, ...extra(i),
  }));
}

describe('mulberry32', () => {
  it('same seed → same sequence, values in [0,1)', () => {
    const a = mulberry32(42), b = mulberry32(42);
    const sa = [a(), a(), a()], sb = [b(), b(), b()];
    expect(sa).toEqual(sb);
    sa.forEach(x => { expect(x).toBeGreaterThanOrEqual(0); expect(x).toBeLessThan(1); });
  });
  it('different seeds → different first draw', () => {
    expect(mulberry32(1)()).not.toBe(mulberry32(2)());
  });
});

describe('nonOverlappingIC', () => {
  it('independent sample count is far below the overlapping count', () => {
    const snaps = wkSnaps(60, i => 50 + (i % 10), i => 100 + i);
    const no = nonOverlappingIC(snaps, 13);
    expect(no.n).toBeGreaterThan(0);
    expect(no.n).toBeLessThan(60 - 13);
  });
});

describe('maxDrawdown', () => {
  it('monotonic up → 0', () => { expect(maxDrawdown([0.01, 0.02, 0.01])).toBeCloseTo(0); });
  it('+100% then −50% → 0.5', () => { expect(maxDrawdown([1.0, -0.5])).toBeCloseTo(0.5); });
  it('within [0,1]', () => {
    const m = maxDrawdown([0.1, -0.3, 0.05, -0.2]);
    expect(m).toBeGreaterThanOrEqual(0); expect(m).toBeLessThanOrEqual(1);
  });
});

describe('turnover', () => {
  it('alternating → 1, constant → 0', () => {
    expect(turnover([0, 1, 0, 1])).toBeCloseTo(1);
    expect(turnover([1, 1, 1])).toBeCloseTo(0);
  });
  it('within [0,1]', () => {
    const t = turnover([0, 0, 1, 1, 0]);
    expect(t).toBeGreaterThanOrEqual(0); expect(t).toBeLessThanOrEqual(1);
  });
});

describe('regimeBreakdown', () => {
  it('non-null labels grouped; null excluded', () => {
    const snaps = wkSnaps(60, i => 50 + (i % 7), i => 100 + i, i => ({ regime: i < 30 ? 'A' : (i < 50 ? 'B' : null) }));
    const out = regimeBreakdown(snaps, 13, s => s.regime ?? null);
    expect(Object.keys(out).sort()).toEqual(['A', 'B']);
    expect(Object.values(out).reduce((a, g) => a + g.n, 0)).toBeGreaterThan(0);
  });
});

function noisyPairs(n: number, rng: () => number): { score: number; fwd: number }[] {
  return Array.from({ length: n }, (_, i) => ({ score: i, fwd: i * 0.001 + (rng() - 0.5) * 0.05 }));
}

describe('blockBootstrapIC', () => {
  it('ci ordered, p in [0,1], iters honored, positive synthetic edge', () => {
    const r = blockBootstrapIC(noisyPairs(150, mulberry32(3)), 13, 500, mulberry32(7));
    expect(r.ci_lo).toBeLessThanOrEqual(r.ci_hi);
    expect(r.p_value).toBeGreaterThanOrEqual(0);
    expect(r.p_value).toBeLessThanOrEqual(1);
    expect(r.iters).toBe(500);
    expect(r.point).toBeGreaterThan(0);
  });
  it('same seed → identical (reproducible)', () => {
    const data = noisyPairs(150, mulberry32(3));
    const a = blockBootstrapIC(data, 13, 300, mulberry32(99));
    const b = blockBootstrapIC(data, 13, 300, mulberry32(99));
    expect(a).toEqual(b);
  });
  it('n below threshold → iters 0, degenerate CI = point', () => {
    const r = blockBootstrapIC(noisyPairs(10, mulberry32(3)), 13, 500, mulberry32(1));
    expect(r.iters).toBe(0);
    expect(r.ci_lo).toBe(r.point);
    expect(r.ci_hi).toBe(r.point);
  });
});

describe('blockBootstrapSharpe', () => {
  it('ci ordered, reproducible, p in [0,1]', () => {
    const rets = Array.from({ length: 150 }, (_, i) => 0.001 + ((i % 5) - 2) * 0.002);
    const a = blockBootstrapSharpe(rets, 13, 300, mulberry32(5), 52);
    const b = blockBootstrapSharpe(rets, 13, 300, mulberry32(5), 52);
    expect(a).toEqual(b);
    expect(a.ci_lo).toBeLessThanOrEqual(a.ci_hi);
    expect(a.p_value).toBeGreaterThanOrEqual(0);
    expect(a.p_value).toBeLessThanOrEqual(1);
  });
});

function bigSnaps(n: number): any[] {
  return Array.from({ length: n }, (_, i) => ({
    date: new Date(Date.UTC(2018, 0, 5 + i * 7)).toISOString().slice(0, 10),
    score: 45 + (i % 20),
    spx: 2000 * Math.pow(1.001, i) * (1 + ((i % 7) - 3) * 0.01),
    factors: {},
    regime: ['EXPANDING', 'CONTRACTING', 'FLAT'][i % 3],
    vix: 12 + (i % 25),
  }));
}

describe('runRobustness', () => {
  const r = runRobustness(bigSnaps(300), { iters: 200 });
  it('all four regime axes present with expected buckets', () => {
    expect(Object.keys(r.regimes).sort()).toEqual(['balance_sheet', 'covid', 'qt', 'vix']);
    expect(Object.keys(r.regimes.balance_sheet).sort()).toEqual(['CONTRACTING', 'EXPANDING', 'FLAT']);
    expect(Object.keys(r.regimes.vix).sort()).toEqual(['high', 'low']);
  });
  it('non-overlapping n < overlapping n; bootstrap iters honored', () => {
    expect(r.ic.non_overlapping.n).toBeLessThan(r.ic.overlapping.n);
    expect(r.ic.bootstrap.iters).toBe(200);
  });
  it('strategy stats present and in range', () => {
    expect(r.strategy.methodology).toBe('LEGACY_WEEKLY');
    expect(r.strategy.max_drawdown).toBeGreaterThanOrEqual(0);
    expect(r.strategy.max_drawdown).toBeLessThanOrEqual(1);
    expect(r.strategy.turnover_per_period).toBeGreaterThanOrEqual(0);
    expect(r.strategy.turnover_per_period).toBeLessThanOrEqual(1);
    expect(r.strategy.sharpe.ci_lo).toBeLessThanOrEqual(r.strategy.sharpe.ci_hi);
    expect(r.caveats.join(' ')).toContain('LEGACY_WEEKLY');
  });
  it('reproducible (fixed default seed)', () => {
    expect(runRobustness(bigSnaps(300), { iters: 200 })).toEqual(r);
  });
  it('tiny sample does not throw, returns safe zeros', () => {
    const small = runRobustness(bigSnaps(3), { iters: 200 });
    expect(small.ic.bootstrap.iters).toBe(0);
    expect(Number.isFinite(small.strategy.ann_return)).toBe(true);
  });
});
