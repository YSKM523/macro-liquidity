import { describe, it, expect } from 'vitest';
import { mulberry32, nonOverlappingIC, maxDrawdown, turnover, regimeBreakdown } from '../src/robustness';

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
