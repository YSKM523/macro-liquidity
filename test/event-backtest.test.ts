import { describe, expect, it } from 'vitest';
import { runEventTimeBacktest, scheduleExecutions } from '../src/event-backtest';
import { EVENT_BACKTEST_ASSUMPTIONS } from '../src/config';

const prices = [
  { date: '2024-01-05', adjustedClose: 100, source: 'FRED:SP500' },
  { date: '2024-01-08', adjustedClose: 102, source: 'FRED:SP500' },
  { date: '2024-01-09', adjustedClose: 101, source: 'FRED:SP500' },
];

describe('event-time execution scheduler', () => {
  it('uses the first observed close strictly after tradableAt, never the model date', () => {
    const result = scheduleExecutions([
      { signalDate: '2024-01-03', decisionAt: '2024-01-05T12:00:00Z', tradableAt: '2024-01-05T20:00:00Z', score: 60 },
    ], prices);
    expect(result.executions[0]).toMatchObject({
      signalDate: '2024-01-03', executionDate: '2024-01-05',
      executionAt: '2024-01-05T23:59:59Z', price: 100,
      oldExposure: 0, newExposure: 1, source: 'FRED:SP500',
    });
  });

  it('waits for the next actual session when tradableAt is equal to a close', () => {
    const result = scheduleExecutions([
      { signalDate: '2024-01-05', decisionAt: '2024-01-05T20:00:00Z', tradableAt: '2024-01-05T23:59:59Z', score: 60 },
    ], prices);
    expect(result.executions[0].executionDate).toBe('2024-01-08');
  });

  it('compares mixed timestamp precision by epoch and skips weekend/holiday gaps', () => {
    const result = scheduleExecutions([
      { signalDate: '2024-01-06', decisionAt: '2024-01-06T12:00:00.500Z', tradableAt: '2024-01-06T12:00:00.500Z', score: 60 },
    ], prices);
    expect(result.executions[0].executionDate).toBe('2024-01-08');
  });

  it('collapses signals mapped to one close to the latest decisionAt', () => {
    const result = scheduleExecutions([
      { signalDate: '2024-01-03', decisionAt: '2024-01-05T10:00:00Z', tradableAt: '2024-01-05T20:00:00Z', score: 60 },
      { signalDate: '2024-01-04', decisionAt: '2024-01-05T11:00:00.500Z', tradableAt: '2024-01-05T21:00:00Z', score: 40 },
    ], prices);
    expect(result.executions).toHaveLength(1);
    expect(result.executions[0]).toMatchObject({ signalDate: '2024-01-04', newExposure: 0 });
  });

  it('reports signals after the final price as explicitly unexecuted', () => {
    const late = { signalDate: '2024-01-10', decisionAt: '2024-01-10T12:00:00Z', tradableAt: '2024-01-10T14:30:00Z', score: 60 };
    const result = scheduleExecutions([late], prices);
    expect(result.executions).toEqual([]);
    expect(result.unexecuted).toEqual([{ ...late, reason: 'NO_CLOSE_AFTER_TRADABLE_AT' }]);
  });

  it('fails closed on malformed timestamps, duplicate sessions, and invalid SPX prices', () => {
    const signal = { signalDate: '2024-01-03', decisionAt: 'bad', tradableAt: '2024-01-05T20:00:00Z', score: 60 };
    expect(() => scheduleExecutions([signal], prices)).toThrow(/decisionAt/i);
    expect(() => scheduleExecutions([], [...prices, prices[0]])).toThrow(/duplicate|ordered/i);
    expect(() => scheduleExecutions([], [{ ...prices[0], adjustedClose: 0 }])).toThrow(/price/i);
  });

  it('rejects reversed event time, impossible dates, non-finite scores, and missing sources', () => {
    const signal = { signalDate: '2024-01-03', decisionAt: '2024-01-05T20:00:00Z', tradableAt: '2024-01-05T19:59:59Z', score: 60 };
    expect(() => scheduleExecutions([signal], prices)).toThrow(/decisionAt after tradableAt/i);
    expect(() => scheduleExecutions([{ ...signal, signalDate: '2024-02-31' }], prices)).toThrow(/signal date/i);
    expect(() => scheduleExecutions([{ ...signal, decisionAt: '2024-01-05T18:00:00Z', score: Number.NaN }], prices)).toThrow(/score/i);
    expect(() => scheduleExecutions([], [{ ...prices[0], source: '' }])).toThrow(/source/i);
    expect(() => scheduleExecutions([], [{ ...prices[0], date: '2024-02-31' }])).toThrow(/market date/i);
  });
});

const daily = [
  { date: '2024-01-05', adjustedClose: 100, source: 'FRED:SP500' },
  { date: '2024-01-08', adjustedClose: 110, source: 'FRED:SP500' },
  { date: '2024-01-09', adjustedClose: 110, source: 'FRED:SP500' },
];
const longSignal = { signalDate: '2024-01-04', decisionAt: '2024-01-05T12:00:00Z', tradableAt: '2024-01-05T20:00:00Z', score: 60 };
const calmVix = [{ date: '2024-01-05', value: 20, source: 'FRED:VIXCLS' }];
const sofr = [{ date: '2024-01-05', rate: 5, source: 'FRED:SOFR' }];

describe('daily event-time NAV', () => {
  it('emits one NAV row per session from the first execution onward and charges base costs once', () => {
    const result = runEventTimeBacktest({ signals: [longSignal], prices: daily, vix: calmVix, cashRates: sofr });
    expect(result.status).toBe('OK');
    expect(result.nav.map(row => row.date)).toEqual(['2024-01-05', '2024-01-08', '2024-01-09']);
    expect(result.nav[0]).toMatchObject({ exposure: 1, turnover: 1, tradeCost: 0.0003 });
    expect(result.nav[1].assetReturn).toBeCloseTo(0.1, 12);
    expect(result.executions).toHaveLength(1);
    expect(result.totals.tradingCostRate).toBeCloseTo(0.0003, 12);
  });

  it('accrues positive SOFR ACT/360 cash carry across one-day and weekend gaps', () => {
    const flat = { ...longSignal, score: 40 };
    const result = runEventTimeBacktest({ signals: [flat], prices: daily, vix: calmVix, cashRates: sofr });
    expect(result.status).toBe('OK');
    expect(result.nav[1].cashReturn).toBeCloseTo(0.05 * 3 / 360, 12);
    expect(result.nav[2].cashReturn).toBeCloseTo(0.05 / 360, 12);
    expect(result.nav[2].nav).toBeGreaterThan(1);
  });

  it.each([
    ['missing', []],
    ['stale', [{ date: '2023-12-20', rate: 5, source: 'FRED:SOFR' }]],
  ] as const)('returns DATA_INCOMPLETE for %s cash rather than zero carry', (_name, cashRates) => {
    const result = runEventTimeBacktest({ signals: [longSignal], prices: daily, vix: calmVix, cashRates: [...cashRates] });
    expect(result.status).toBe('DATA_INCOMPLETE');
    expect(result.reason).toMatch(/SOFR.*(?:missing|stale)/i);
    expect(result.nav.length).toBeLessThan(daily.length);
  });

  it('adds conservative slippage for high, stale, or missing VIX', () => {
    const high = runEventTimeBacktest({ signals: [longSignal], prices: daily, vix: [{ date: '2024-01-05', value: 28, source: 'FRED:VIXCLS' }], cashRates: sofr });
    const stale = runEventTimeBacktest({ signals: [longSignal], prices: daily, vix: [{ date: '2023-12-20', value: 20, source: 'FRED:VIXCLS' }], cashRates: sofr });
    const missing = runEventTimeBacktest({ signals: [longSignal], prices: daily, vix: [], cashRates: sofr });
    expect(high.nav[0].tradeCost).toBeCloseTo(0.0006, 12);
    expect(stale.nav[0].tradeCost).toBeCloseTo(0.0006, 12);
    expect(missing.nav[0].tradeCost).toBeCloseTo(0.0006, 12);
  });

  it('charges cash rate plus financing spread for synthetic exposure above 100%', () => {
    const levered = { ...longSignal, targetExposure: 1.5 };
    const result = runEventTimeBacktest({ signals: [levered], prices: daily.map(row => ({ ...row, adjustedClose: 100 })), vix: calmVix, cashRates: sofr });
    expect(result.status).toBe('OK');
    expect(result.nav[1].financingReturn).toBeCloseTo(-0.5 * 0.06 * 3 / 360, 12);
    expect(result.nav[1].cashReturn).toBe(0);
  });

  it('returns finite deterministic outputs and discloses named assumptions verbatim', () => {
    const first = runEventTimeBacktest({ signals: [longSignal], prices: daily, vix: calmVix, cashRates: sofr });
    const second = runEventTimeBacktest({ signals: [longSignal], prices: daily, vix: calmVix, cashRates: sofr });
    expect(first).toEqual(second);
    expect(first.assumptions).toEqual(EVENT_BACKTEST_ASSUMPTIONS);
    for (const row of first.nav) {
      for (const value of Object.values(row)) if (typeof value === 'number') expect(Number.isFinite(value)).toBe(true);
    }
  });

  it('fails closed for negative VIX and insufficient executable sessions', () => {
    expect(() => runEventTimeBacktest({
      signals: [longSignal], prices: daily,
      vix: [{ date: '2024-01-05', value: -1, source: 'FRED:VIXCLS' }], cashRates: sofr,
    })).toThrow(/VIX/i);
    const oneSession = runEventTimeBacktest({ signals: [longSignal], prices: daily.slice(0, 1), vix: calmVix, cashRates: sofr });
    expect(oneSession.status).toBe('DATA_INCOMPLETE');
    expect(oneSession.reason).toMatch(/insufficient.*session/i);
  });
});
