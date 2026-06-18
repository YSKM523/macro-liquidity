import { describe, it, expect } from 'vitest';
import { clamp, linMap, sma, asOf, buildWeeklyNetliq, changeOverDays } from '../src/metrics';

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
