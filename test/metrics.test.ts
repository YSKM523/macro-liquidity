import { describe, it, expect } from 'vitest';
import {
  clamp, linMap, sma, asOf, buildWeeklyNetliq, changeOverDays, classifyQeQt, netliqDirection,
  percentileRank, scoreNetliqTrend, scoreQeQt, scoreCredit, scoreFunding,
  scoreRates, scoreVol, weightedScore,
} from '../src/metrics';

const obs = (pairs: [string, number][]) => pairs.map(([date, value]) => ({ date, value }));

describe('primitives', () => {
  it('clamp bounds to [0,100] by default', () => {
    expect(clamp(-5)).toBe(0); expect(clamp(150)).toBe(100); expect(clamp(42)).toBe(42);
  });
  it('linMap maps range to 0..100 and clamps', () => {
    expect(linMap(0, -100, 100)).toBeCloseTo(50);
    expect(linMap(100, -100, 100)).toBe(100);
    expect(linMap(-200, -100, 100)).toBe(0);
  });
  it('sma averages last n, null if short', () => {
    expect(sma([1,2,3,4], 2)).toBeCloseTo(3.5);
    expect(sma([1], 2)).toBeNull();
  });
  it('asOf forward-fills last value on/before date', () => {
    const s = obs([['2024-01-01', 10], ['2024-01-08', 20]]);
    expect(asOf(s, '2024-01-05')).toBe(10);
    expect(asOf(s, '2024-01-08')).toBe(20);
    expect(asOf(s, '2023-12-31')).toBeNull();
  });
  it('buildWeeklyNetliq = WALCL - TGA - RRP at WALCL weekly dates', () => {
    const m = {
      WALCL: obs([['2024-01-03', 6000], ['2024-01-10', 6100]]),
      WTREGEN: obs([['2024-01-03', 700], ['2024-01-10', 700]]),
      RRPONTSYD: obs([['2024-01-02', 500], ['2024-01-09', 400]]),
    };
    expect(buildWeeklyNetliq(m, '2024-01-10')).toEqual([4800, 5000]);
  });
  it('changeOverDays returns latest minus value ~days ago', () => {
    const s = obs([['2024-01-01', 4.0], ['2024-01-29', 4.5]]);
    expect(changeOverDays(s, '2024-01-29', 20)).toBeCloseTo(0.5);
  });
});

describe('regime + direction', () => {
  it('QE when WALCL rose >epsilon over 13 weeks', () => {
    const w = Array.from({ length: 14 }, (_, i) => 6000 + i * 20); // +260 over 13
    expect(classifyQeQt(w)).toBe('QE');
  });
  it('QT when WALCL fell >epsilon over 13 weeks', () => {
    const w = Array.from({ length: 14 }, (_, i) => 7000 - i * 20);
    expect(classifyQeQt(w)).toBe('QT');
  });
  it('NEUTRAL inside dead-band', () => {
    const w = Array.from({ length: 14 }, () => 6000);
    expect(classifyQeQt(w)).toBe('NEUTRAL');
  });
  it('netliqDirection UP when latest above its SMA and rising', () => {
    const up = Array.from({ length: 20 }, (_, i) => 4000 + i * 30);
    expect(netliqDirection(up)).toBe('UP');
    const down = Array.from({ length: 20 }, (_, i) => 5000 - i * 30);
    expect(netliqDirection(down)).toBe('DOWN');
  });
});

describe('factor scores', () => {
  it('percentileRank ranks within history', () => {
    expect(percentileRank(5, [1,2,3,4,5,6,7,8,9,10])).toBeCloseTo(0.5, 1);
  });
  it('rising net liquidity scores higher than falling, all within [0,100]', () => {
    const rising = Array.from({ length: 20 }, (_, i) => 4000 + i * 30);
    const falling = Array.from({ length: 20 }, (_, i) => 5000 - i * 30);
    const r = scoreNetliqTrend(rising), f = scoreNetliqTrend(falling);
    expect(r).toBeGreaterThan(f);
    for (const s of [r, f]) { expect(s).toBeGreaterThanOrEqual(0); expect(s).toBeLessThanOrEqual(100); }
  });
  it('QE scores higher than QT', () => {
    expect(scoreQeQt('QE')).toBeGreaterThan(scoreQeQt('QT'));
  });
  it('tight credit (low OAS) scores higher than wide', () => {
    const hist = Array.from({ length: 50 }, (_, i) => 3 + i * 0.1); // 3..~8
    expect(scoreCredit(3.2, hist)).toBeGreaterThan(scoreCredit(7.5, hist));
  });
  it('funding stress (sofr-iorb>0) penalized', () => {
    expect(scoreFunding(-0.02)).toBeGreaterThan(scoreFunding(0.10));
  });
  it('fast-rising yields = headwind (lower score)', () => {
    expect(scoreRates(0.5)).toBeLessThan(scoreRates(-0.5));
  });
  it('low VIX scores higher than high VIX', () => {
    expect(scoreVol(14)).toBeGreaterThan(scoreVol(35));
  });
  it('weightedScore stays in [0,100]', () => {
    const f = { netliqTrend:80, qeqt:70, credit:60, funding:90, rates:40, dollar:55, vol:75 };
    const s = weightedScore(f);
    expect(s).toBeGreaterThanOrEqual(0); expect(s).toBeLessThanOrEqual(100);
  });
});
