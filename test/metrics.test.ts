import { describe, it, expect } from 'vitest';
import { clamp, linMap, sma, asOf, buildWeeklyNetliq, changeOverDays, classifyQeQt, netliqDirection } from '../src/metrics';

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
