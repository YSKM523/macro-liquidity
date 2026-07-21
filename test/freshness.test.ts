import { describe, expect, it } from 'vitest';
import { SERIES, type FreshnessRule } from '../src/config';
import * as metrics from '../src/metrics';

const obs = (pairs: [string, number][]) => pairs.map(([date, value]) => ({ date, value }));

const forwardFillRule: FreshnessRule = {
  expectedFrequency: 'DAILY',
  maxStaleCalendarDays: 4,
  maxStaleBusinessDays: 2,
  releaseLag: 1,
  requiredForScore: true,
  fallbackPolicy: 'FORWARD_FILL',
};

function asOfFresh(
  series: ReturnType<typeof obs>,
  date: string,
  rule: FreshnessRule,
) {
  expect(metrics).toHaveProperty('asOfFresh');
  return metrics.asOfFresh(series, date, rule);
}

describe('series freshness configuration', () => {
  it('gives every registered series a complete, bounded freshness rule', () => {
    for (const rule of Object.values(SERIES)) {
      expect(['DAILY', 'WEEKLY', 'MONTHLY', 'IRREGULAR']).toContain(rule.expectedFrequency);
      expect(Number.isInteger(rule.maxStaleCalendarDays)).toBe(true);
      expect(rule.maxStaleCalendarDays).toBeGreaterThan(0);
      expect(Number.isInteger(rule.maxStaleBusinessDays)).toBe(true);
      expect(rule.maxStaleBusinessDays).toBeGreaterThan(0);
      expect(Number.isInteger(rule.releaseLag)).toBe(true);
      expect(rule.releaseLag).toBeGreaterThanOrEqual(0);
      expect(typeof rule.requiredForScore).toBe('boolean');
      expect(['NONE', 'FORWARD_FILL']).toContain(rule.fallbackPolicy);
    }
  });

  it('marks every critical net-liquidity input as required for scoring', () => {
    expect(SERIES.WALCL.requiredForScore).toBe(true);
    expect(SERIES.WDTGAL.requiredForScore).toBe(true);
    expect(SERIES.RRPONTSYD.requiredForScore).toBe(true);
  });
});

describe('asOfFresh', () => {
  it('returns an exact-date observation as fresh', () => {
    expect(asOfFresh(obs([['2024-01-08', 20]]), '2024-01-08', forwardFillRule)).toEqual({
      value: 20,
      observationDate: '2024-01-08',
      ageDays: 0,
      status: 'FRESH',
    });
  });

  it('forward-fills the latest observation within both freshness bounds', () => {
    const series = obs([['2024-01-04', 10], ['2024-01-05', 20], ['2024-01-09', 30]]);
    expect(asOfFresh(series, '2024-01-08', forwardFillRule)).toEqual({
      value: 20,
      observationDate: '2024-01-05',
      ageDays: 3,
      status: 'FRESH',
    });
  });

  it('returns missing diagnostics when there is no observation on or before the date', () => {
    expect(asOfFresh(obs([['2024-01-09', 30]]), '2024-01-08', forwardFillRule)).toEqual({
      value: null,
      observationDate: null,
      ageDays: null,
      status: 'MISSING',
    });
  });

  it('withholds a value that exceeds the calendar-day bound', () => {
    const rule = { ...forwardFillRule, maxStaleCalendarDays: 2, maxStaleBusinessDays: 10 };
    expect(asOfFresh(obs([['2024-01-05', 20]]), '2024-01-08', rule)).toEqual({
      value: null,
      observationDate: '2024-01-05',
      ageDays: 3,
      status: 'STALE',
    });
  });

  it('counts UTC business days across a weekend and applies that bound', () => {
    const rule = { ...forwardFillRule, maxStaleCalendarDays: 10, maxStaleBusinessDays: 1 };
    expect(asOfFresh(obs([['2024-01-04', 20]]), '2024-01-08', rule)).toEqual({
      value: null,
      observationDate: '2024-01-04',
      ageDays: 4,
      status: 'STALE',
    });
  });

  it('requires an exact-date observation when fallback is NONE', () => {
    const rule: FreshnessRule = { ...forwardFillRule, fallbackPolicy: 'NONE' };
    expect(asOfFresh(obs([['2024-01-05', 20]]), '2024-01-08', rule)).toEqual({
      value: null,
      observationDate: '2024-01-05',
      ageDays: 3,
      status: 'STALE',
    });
  });
});
