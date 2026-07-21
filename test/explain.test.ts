import { describe, it, expect } from 'vitest';
import { factorContributions, attributeScoreChange, decomposeNetliq } from '../src/explain';
import { weightedScore } from '../src/metrics';

// 中段因子,保证 weightedScore 不被 clamp 到 0/100 → 恒等式可精确交叉验证
const F: any = { netliqTrend: 62, impulse: 48, credit: 55, funding: 50, rates: 44, dollar: 58, vol: 30, reserveAdequacy: 47, curve: 66 };
const G: any = { netliqTrend: 55, impulse: 50, credit: 52, funding: 50, rates: 46, dollar: 63, vol: 40, reserveAdequacy: 51, curve: 60 };

describe('factorContributions', () => {
  it('sums to weightedScore − 50 (cross-checks explain against the real scorer)', () => {
    const sum = factorContributions(F).reduce((a, c) => a + c.contribution, 0);
    expect(sum).toBeCloseTo(weightedScore(F) - 50, 6);
  });
  it('excludes vol (weight 0) and returns the 8 scoring factors', () => {
    const r = factorContributions(F);
    expect(r.length).toBe(8);
    expect(r.some(c => c.key === 'vol')).toBe(false);
  });
  it('sorted by |contribution| descending', () => {
    const xs = factorContributions(F).map(c => Math.abs(c.contribution));
    for (let i = 1; i < xs.length; i++) expect(xs[i - 1]).toBeGreaterThanOrEqual(xs[i]);
  });
  it('uses only real finite factors and renormalizes their configured positive weights', () => {
    const r = factorContributions({ netliqTrend: 80, credit: Number.NaN });
    expect(r).toEqual([{ key: 'netliqTrend', factor: 80, weight: 1, contribution: 30 }]);
  });
});

describe('attributeScoreChange', () => {
  it('sums to weightedScore(cur) − weightedScore(ref)', () => {
    const sum = attributeScoreChange(F, G).reduce((a, c) => a + c.deltaContribution, 0);
    expect(sum).toBeCloseTo(weightedScore(F) - weightedScore(G), 6);
  });
  it('excludes vol and sorts by |deltaContribution| desc', () => {
    const arr = attributeScoreChange(F, G);
    expect(arr.some(c => c.key === 'vol')).toBe(false);
    const xs = arr.map(c => Math.abs(c.deltaContribution));
    for (let i = 1; i < xs.length; i++) expect(xs[i - 1]).toBeGreaterThanOrEqual(xs[i]);
  });
  it('attributes only real factors common to both snapshots and renormalizes them', () => {
    const arr = attributeScoreChange(
      { netliqTrend: 80, credit: 20 },
      { netliqTrend: 60, funding: 90 },
    );
    expect(arr).toEqual([{ key: 'netliqTrend', deltaFactor: 20, weight: 1, deltaContribution: 20 }]);
  });

  it('withholds attribution when there is no real common scoring factor', () => {
    expect(attributeScoreChange({ credit: 20 }, { funding: 90 })).toEqual([]);
  });
});

describe('decomposeNetliq', () => {
  it('netliq identity holds for current and delta', () => {
    const d = decomposeNetliq({ walcl: 6736, tga: 957, rrp: 7 }, { walcl: 6731, tga: 897, rrp: 0 });
    expect(d.current.netliq).toBeCloseTo(6736 - 957 - 7);
    expect(d.delta!.netliq).toBeCloseTo(d.delta!.walcl - d.delta!.tga - d.delta!.rrp);
  });
  it('reference null → reference and delta null', () => {
    const d = decomposeNetliq({ walcl: 6736, tga: 957, rrp: 7 }, null);
    expect(d.reference).toBeNull();
    expect(d.delta).toBeNull();
  });
});
