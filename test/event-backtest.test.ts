import { describe, expect, it } from 'vitest';
import { runEventTimeBacktest, scheduleExecutions, simulateDailyPortfolio } from '../src/event-backtest';
import type { DailyMarketPrice } from '../src/event-backtest';
import { EVENT_BACKTEST_ASSUMPTIONS } from '../src/config';

const prices = [
  { date: '2024-01-05', adjustedClose: 100, source: 'FRED:SP500', fetchedAt: '2024-01-10T00:00:00Z', dataRunId: 'run-a', activationRunId: 'run-a', activatedAt: '2024-01-10T01:00:00Z', provenanceStatus: 'PIT_RAW' as const },
  { date: '2024-01-08', adjustedClose: 102, source: 'FRED:SP500', fetchedAt: '2024-01-10T00:00:00Z', dataRunId: 'run-a', activationRunId: 'run-a', activatedAt: '2024-01-10T01:00:00Z', provenanceStatus: 'PIT_RAW' as const },
  { date: '2024-01-09', adjustedClose: 101, source: 'FRED:SP500', fetchedAt: '2024-01-10T00:00:00Z', dataRunId: 'run-a', activationRunId: 'run-a', activatedAt: '2024-01-10T01:00:00Z', provenanceStatus: 'PIT_RAW' as const },
];

describe('event-time execution scheduler', () => {
  it('uses a same-day row only when tradableAt is strictly before the conservative close-eligibility bound', () => {
    const result = scheduleExecutions([
      { signalDate: '2024-01-03', decisionAt: '2024-01-05T12:00:00Z', tradableAt: '2024-01-05T16:59:59Z', score: 60 },
    ], prices);
    expect(result.executions[0]).toMatchObject({
      signalDate: '2024-01-03', executionDate: '2024-01-05',
      eligibilityAt: '2024-01-05T17:00:00Z',
      executionAt: '2024-01-05T23:59:59Z', price: 100,
      oldExposure: 0, newExposure: 1, source: 'FRED:SP500',
    });
  });

  it.each([
    ['equal conservative bound', '2024-01-05T17:00:00Z'],
    ['after conservative bound', '2024-01-05T17:00:00.001Z'],
    ['normal EST close', '2024-01-05T21:00:00Z'],
    ['normal EDT close', '2024-01-05T20:00:00Z'],
  ])('waits for the next actual row at %s', (_label, tradableAt) => {
    const result = scheduleExecutions([
      { signalDate: '2024-01-05', decisionAt: '2024-01-05T12:00:00Z', tradableAt, score: 60 },
    ], prices);
    expect(result.executions[0]).toMatchObject({
      executionDate: '2024-01-08', eligibilityAt: '2024-01-08T17:00:00Z',
      executionAt: '2024-01-08T23:59:59Z',
    });
  });

  it('waits past the real July 3 early-close bound when tradableAt is 17:00Z', () => {
    const julyPrices = [
      { ...prices[0], date: '2024-07-03' },
      { ...prices[1], date: '2024-07-05' },
    ];
    const result = scheduleExecutions([{
      signalDate: '2024-07-03', decisionAt: '2024-07-03T16:00:00Z',
      tradableAt: '2024-07-03T17:00:00Z', score: 60,
    }], julyPrices);
    expect(result.executions[0]).toMatchObject({
      executionDate: '2024-07-05', eligibilityAt: '2024-07-05T17:00:00Z',
    });
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
    expect(result.superseded).toEqual([expect.objectContaining({
      signalDate: '2024-01-03', executionDate: '2024-01-08', reason: 'SUPERSEDED_AT_SAME_CLOSE',
    })]);
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
  { ...prices[0], adjustedClose: 100 },
  { ...prices[1], adjustedClose: 110 },
  { ...prices[2], adjustedClose: 110 },
];
const longSignal = {
  signalDate: '2024-01-04', decisionAt: '2024-01-05T12:00:00Z', tradableAt: '2024-01-05T16:00:00Z',
  score: 60, verdict: 'BULLISH' as const, netliqDir: 'UP' as const, snapshotVixEod: 20,
  targetExposure: 1, portfolioTier: 'STRONG_TAILWIND' as const,
  portfolioMethodology: 'DASHBOARD_EXPOSURE_TIERS_V1' as const,
  stressMethodology: 'PIT_SNAPSHOT_VIX_PROXY' as const,
  recordedAt: '2024-01-10T00:30:00Z', dataRunId: 'run-a',
};
const calmVix = [{ date: '2024-01-05', value: 20, source: 'FRED:VIXCLS', fetchedAt: '2024-01-10T00:00:00Z', dataRunId: 'run-a', activationRunId: 'run-a', activatedAt: '2024-01-10T01:00:00Z', provenanceStatus: 'PIT_RAW' as const }];
const sofr = [{ date: '2024-01-04', rate: 5, source: 'FRED:SOFR', fetchedAt: '2024-01-10T00:00:00Z', dataRunId: 'run-a', activationRunId: 'run-a', activatedAt: '2024-01-10T01:00:00Z', provenanceStatus: 'PIT_RAW' as const }];
const asOfCutoff = '2024-01-10T01:00:00.001Z';

describe('daily event-time NAV', () => {
  it('fails closed instead of using the scheduler compatibility fallback for a formal signal', () => {
    const { targetExposure: _target, portfolioTier: _tier, portfolioMethodology: _methodology, ...implicit } = longSignal;
    const result = runEventTimeBacktest({ asOfCutoff, signals: [implicit], prices: daily, vix: calmVix, cashRates: sofr });
    expect(result.status).toBe('DATA_INCOMPLETE');
    expect(result.reason).toMatch(/explicit.*portfolio.*target/i);
    expect(result.nav).toEqual([]);
  });
  it('fails closed when no single D1 as-of cutoff is supplied', () => {
    const result = runEventTimeBacktest({ signals: [longSignal], prices: daily, vix: calmVix, cashRates: sofr });
    expect(result.status).toBe('DATA_INCOMPLETE');
    expect(result.reason).toMatch(/as-of cutoff/i);
    expect(result.nav).toEqual([]);
  });
  it('emits one NAV row per session from the first execution onward and charges base costs once', () => {
    const result = runEventTimeBacktest({ asOfCutoff, signals: [longSignal], prices: daily, vix: calmVix, cashRates: sofr });
    expect(result.status).toBe('OK');
    expect(result.nav.map(row => row.date)).toEqual(['2024-01-05', '2024-01-08', '2024-01-09']);
    expect(result.nav[0]).toMatchObject({ exposure: 1, turnover: 1, tradeCost: 0.0003 });
    expect(result.nav[1].assetReturn).toBeCloseTo(0.1, 12);
    expect(result.executions).toHaveLength(1);
    expect(result.totals.tradingCostRate).toBeCloseTo(0.0003, 12);
  });

  it('reports dashboard-tier portfolio metrics and four benchmarks over the identical window', () => {
    const result = runEventTimeBacktest({ asOfCutoff, signals: [longSignal], prices: daily, vix: calmVix, cashRates: sofr });
    expect(result.portfolio).toMatchObject({
      methodology: 'DASHBOARD_EXPOSURE_TIERS_V1',
      stressMethodology: 'PIT_SNAPSHOT_VIX_PROXY',
      strategy: { metrics: { averageBeta: 1 } },
      benchmarks: {
        spxBuyHold: { methodology: 'SPX_BUY_HOLD' },
        betaMatchedStatic: { methodology: 'STATIC_SPX_CASH_AVERAGE_BETA' },
        volatilityTarget: { methodology: 'PRIOR_20_SESSION_10PCT_VOL_TARGET_CAP_100' },
        movingAverage200: { methodology: 'PRIOR_CLOSE_200DMA_RISK_CONTROL' },
      },
    });
    expect(result.portfolio?.strategy.metrics).toHaveProperty('maxDrawdownDurationSessions');
    expect(result.portfolio?.cumulativeTimingReturnDifference).toBeCloseTo(0, 12);
    expect(result.portfolio?.timingComparisonMethodology)
      .toBe('CUMULATIVE_RETURN_DIFFERENCE_VS_BETA_MATCHED_STATIC');
    for (const benchmark of Object.values(result.portfolio!.benchmarks)) {
      expect(benchmark.metrics).toHaveProperty('sortino');
      expect(benchmark.sessions).toBe(result.totals.sessions);
    }
  });

  it('accrues positive SOFR ACT/360 cash carry across one-day and weekend gaps', () => {
    const flat = { ...longSignal, score: 40, targetExposure: 0.25, portfolioTier: 'HEADWIND' as const };
    const result = runEventTimeBacktest({ asOfCutoff, signals: [flat], prices: daily, vix: calmVix, cashRates: sofr });
    expect(result.status).toBe('OK');
    expect(result.nav[1].cashReturn).toBeCloseTo(0.75 * 0.05 * 3 / 360, 12);
    expect(result.nav[2].cashReturn).toBeCloseTo(0.75 * 0.05 / 360, 12);
    expect(result.nav[2].nav).toBeGreaterThan(1);
  });

  it('does not look ahead to a same-date SOFR fixing that was not known at interval start', () => {
    const flat = { ...longSignal, score: 40, targetExposure: 0.25, portfolioTier: 'HEADWIND' as const };
    const result = runEventTimeBacktest({
      asOfCutoff,
      signals: [flat], prices: daily, vix: calmVix,
      cashRates: [...sofr, { ...sofr[0], date: '2024-01-05', rate: 99 }],
    });
    expect(result.status).toBe('OK');
    expect(result.nav[1].cashReturn).toBeCloseTo(0.75 * 0.05 * 3 / 360, 12);
  });

  it.each([
    ['missing', []],
    ['stale', [{ ...sofr[0], date: '2023-12-20' }]],
  ] as const)('returns DATA_INCOMPLETE for %s cash rather than zero carry', (_name, cashRates) => {
    const result = runEventTimeBacktest({ asOfCutoff, signals: [longSignal], prices: daily, vix: calmVix, cashRates: [...cashRates] });
    expect(result.status).toBe('DATA_INCOMPLETE');
    expect(result.reason).toMatch(/SOFR.*(?:missing|stale)/i);
    expect(result.nav).toEqual([]);
    expect(result.totals).toEqual({ totalReturn: null, tradingCostRate: null, sessions: null });
  });

  it('adds conservative slippage for high, stale, or missing VIX', () => {
    const high = runEventTimeBacktest({ asOfCutoff, signals: [longSignal], prices: daily, vix: [{ ...calmVix[0], value: 28 }], cashRates: sofr });
    const stale = runEventTimeBacktest({ asOfCutoff, signals: [longSignal], prices: daily, vix: [{ ...calmVix[0], date: '2023-12-20' }], cashRates: sofr });
    const missing = runEventTimeBacktest({ asOfCutoff, signals: [longSignal], prices: daily, vix: [], cashRates: sofr });
    expect(high.nav[0].tradeCost).toBeCloseTo(0.0006, 12);
    expect(stale.nav[0].tradeCost).toBeCloseTo(0.0006, 12);
    expect(missing.nav[0].tradeCost).toBeCloseTo(0.0006, 12);
  });

  it('charges cash rate plus financing spread for synthetic exposure above 100%', () => {
    const result = simulateDailyPortfolio({
      prices: daily.map(row => ({ ...row, adjustedClose: 100 })),
      targetExposures: [1.5, 1.5, 1.5], vix: calmVix, cashRates: sofr,
    });
    expect(result.status).toBe('OK');
    expect(result.nav[1].financingReturn).toBeCloseTo(-0.5 * 0.06 * 3 / 360, 12);
    expect(result.nav[1].cashReturn).toBe(0);
  });

  it('returns finite deterministic outputs and discloses named assumptions verbatim', () => {
    const first = runEventTimeBacktest({ asOfCutoff, signals: [longSignal], prices: daily, vix: calmVix, cashRates: sofr });
    const second = runEventTimeBacktest({ asOfCutoff, signals: [longSignal], prices: daily, vix: calmVix, cashRates: sofr });
    expect(first).toEqual(second);
    expect(first.assumptions).toEqual(EVENT_BACKTEST_ASSUMPTIONS);
    for (const row of first.nav) {
      for (const value of Object.values(row)) if (typeof value === 'number') expect(Number.isFinite(value)).toBe(true);
    }
  });

  it('summarizes append-only as-of provenance using strict timestamp epochs', () => {
    const result = runEventTimeBacktest({
      signals: [longSignal],
      prices: daily.map((row, index) => ({ ...row, fetchedAt: index === 0 ? '2024-01-10T00:00:00.900Z' : '2024-01-10T00:00:00Z', dataRunId: index === 0 ? 'market-a' : 'market-b' })),
      vix: calmVix.map(row => ({ ...row, fetchedAt: '2024-01-09T00:00:00Z', dataRunId: 'market-a' })),
      cashRates: sofr.map(row => ({ ...row, fetchedAt: '2024-01-08T00:00:00Z', dataRunId: 'cash-a' })),
      asOfCutoff,
    });
    expect(result.provenance).toEqual({
      revisionPolicy: 'APPEND_ONLY_AS_OF', responseReproducible: true,
      asOfCutoff,
      maxFetchedAt: '2024-01-10T00:00:00.900Z',
      sourceLabels: ['FRED:SOFR', 'FRED:SP500', 'FRED:VIXCLS'],
      dataRunCount: 4, containsSynthetic: false,
      revisionRunCount: 1,
    });
  });

  it.each([
    ['synthetic backfill', { provenanceStatus: 'SYNTHETIC_BACKFILL' }],
    ['legacy row without PIT', { provenanceStatus: 'LEGACY_NO_PIT' }],
    ['missing activation time', { activatedAt: undefined }],
    ['missing run provenance', { dataRunId: undefined }],
  ] satisfies Array<[string, Partial<DailyMarketPrice>]>)('fails closed when a selected input has %s', (_label, patch) => {
    const result = runEventTimeBacktest({
      signals: [longSignal], prices: daily.map((row, index) => index === 0 ? { ...row, ...patch } : row),
      vix: calmVix, cashRates: sofr, asOfCutoff,
    });
    expect(result.status).toBe('DATA_INCOMPLETE');
    expect(result.reason).toMatch(/provenance|synthetic|legacy|activation/i);
    expect(result.nav).toEqual([]);
    expect(result.totals).toEqual({ totalReturn: null, tradingCostRate: null, sessions: null });
  });

  it('fails closed for negative VIX and insufficient executable sessions', () => {
    expect(() => runEventTimeBacktest({
      asOfCutoff,
      signals: [longSignal], prices: daily,
      vix: [{ ...calmVix[0], value: -1 }], cashRates: sofr,
    })).toThrow(/VIX/i);
    const oneSession = runEventTimeBacktest({ asOfCutoff, signals: [longSignal], prices: daily.slice(0, 1), vix: calmVix, cashRates: sofr });
    expect(oneSession.status).toBe('DATA_INCOMPLETE');
    expect(oneSession.reason).toMatch(/insufficient.*session/i);
    expect(oneSession.nav).toEqual([]);
    expect(oneSession.totals).toEqual({ totalReturn: null, tradingCostRate: null, sessions: null });
  });

  it.each([
    ['non-finite score', { score: Number.NaN }],
    ['invalid verdict', { verdict: 'UNKNOWN' }],
    ['missing verdict', { verdict: null }],
    ['invalid net liquidity direction', { netliqDir: 'SIDEWAYS' }],
    ['missing net liquidity direction', { netliqDir: null }],
    ['negative frozen VIX', { snapshotVixEod: -1 }],
    ['non-finite frozen VIX', { snapshotVixEod: Number.NaN }],
  ])('returns formal DATA_INCOMPLETE for %s instead of throwing', (_label, patch) => {
    const result = runEventTimeBacktest({
      asOfCutoff, signals: [{ ...longSignal, ...patch } as any], prices: daily, vix: calmVix, cashRates: sofr,
    });
    expect(result.status).toBe('DATA_INCOMPLETE');
    expect(result.reason).toMatch(/official.*portfolio.*field/i);
    expect(result.nav).toEqual([]);
  });
});
