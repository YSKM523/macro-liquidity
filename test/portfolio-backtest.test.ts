import { describe, expect, it } from 'vitest';
import {
  buildBenchmarkTargets,
  computePortfolioMetrics,
  simulateDailyPortfolio,
} from '../src/event-backtest';

const provenance = {
  source: 'FRED:SP500', fetchedAt: '2024-12-31T00:00:00Z', dataRunId: 'raw',
  activationRunId: 'activation', activatedAt: '2024-12-31T01:00:00Z', provenanceStatus: 'PIT_RAW' as const,
};

function priceSeries(length: number) {
  return Array.from({ length }, (_, index) => ({
    date: new Date(Date.UTC(2024, 0, 1 + index)).toISOString().slice(0, 10),
    adjustedClose: 100 + index, ...provenance,
  }));
}

describe('fair portfolio benchmark targets', () => {
  it('beta-matches the static benchmark to strategy average exposure', () => {
    const prices = priceSeries(4);
    const targets = buildBenchmarkTargets(prices, [0.25, 0.75, 1, 0.5]);
    expect(targets.betaMatchedStatic).toEqual([0.625, 0.625, 0.625, 0.625]);
    expect(targets.spxBuyHold).toEqual([1, 1, 1, 1]);
  });

  it('uses 20 completed prior returns for volatility targeting and never the current price', () => {
    const prices = priceSeries(24);
    const original = buildBenchmarkTargets(prices, prices.map(() => 0.75)).volatilityTarget;
    const shocked = prices.map((row, index) => index === 21 ? { ...row, adjustedClose: row.adjustedClose * 10 } : row);
    const rerun = buildBenchmarkTargets(shocked, shocked.map(() => 0.75)).volatilityTarget;
    expect(original.slice(0, 21)).toEqual(Array(21).fill(0));
    expect(original[21]).toBeGreaterThan(0);
    expect(rerun[21]).toBe(original[21]);
    expect(rerun[22]).not.toBe(original[22]);
    expect(Math.max(...rerun)).toBeLessThanOrEqual(1);
  });

  it('uses only the prior 200 closes for the moving-average control', () => {
    const prices = priceSeries(202);
    const original = buildBenchmarkTargets(prices, prices.map(() => 0.75)).movingAverage200;
    const shocked = prices.map((row, index) => index === 200 ? { ...row, adjustedClose: 1 } : row);
    const rerun = buildBenchmarkTargets(shocked, shocked.map(() => 0.75)).movingAverage200;
    expect(original.slice(0, 200)).toEqual(Array(200).fill(0));
    expect(original[200]).toBe(1);
    expect(rerun[200]).toBe(original[200]);
    expect(rerun[201]).toBe(0);
  });
});

describe('reusable daily long/cash simulator and analytics', () => {
  it('applies prior-date cash carry and the same turnover costs', () => {
    const prices = priceSeries(3).map((row, index) => ({ ...row, adjustedClose: [100, 110, 110][index] }));
    const result = simulateDailyPortfolio({
      prices,
      targetExposures: [0.5, 1, 1],
      vix: [{ date: '2024-01-01', value: 20, ...provenance, source: 'FRED:VIXCLS' }],
      cashRates: [{ date: '2023-12-31', rate: 5, ...provenance, source: 'FRED:SOFR' }],
    });
    expect(result.status).toBe('OK');
    expect(result.nav[0]).toMatchObject({ exposure: 0.5, turnover: 0.5, tradeCost: 0.00015 });
    expect(result.nav[1].assetReturn).toBeCloseTo(0.05, 12);
    expect(result.nav[1].cashReturn).toBeCloseTo(0.5 * 0.05 / 360, 12);
    expect(result.nav[1].tradeCost).toBeCloseTo(0.00015, 12);
  });

  it('reports return, beta, annualized risk, downside risk and drawdown duration', () => {
    const metrics = computePortfolioMetrics([
      { date: '2024-01-01', nav: 1, exposure: 0.5 },
      { date: '2024-01-02', nav: 0.9, exposure: 0.5 },
      { date: '2024-01-03', nav: 0.8, exposure: 0.5 },
      { date: '2024-01-04', nav: 0.85, exposure: 0.5 },
    ]);
    expect(metrics.totalReturn).toBeCloseTo(-0.15, 12);
    expect(metrics.averageBeta).toBe(0.5);
    expect(metrics.annualizedVolatility).toBeGreaterThan(0);
    expect(metrics.sharpe).not.toBeNull();
    expect(metrics.sortino).not.toBeNull();
    expect(metrics.maxDrawdown).toBeCloseTo(-0.2, 12);
    expect(metrics.maxDrawdownDurationSessions).toBe(3);
  });

  it('returns null rather than invented performance for insufficient history', () => {
    expect(computePortfolioMetrics([{ date: '2024-01-01', nav: 1, exposure: 0.5 }])).toEqual({
      totalReturn: null, averageBeta: null, annualizedVolatility: null,
      sharpe: null, sortino: null, maxDrawdown: null, maxDrawdownDurationSessions: null,
    });
  });
});
