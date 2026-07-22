import { describe, expect, it } from 'vitest';
import { scheduleExecutions } from '../src/event-backtest';

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
