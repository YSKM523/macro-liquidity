import { describe, expect, it } from 'vitest';
import { computeSnapshot } from '../src/metrics';
import type { SeriesMap } from '../src/metrics';
import { WEIGHTS } from '../src/config';

const DATE = '2024-07-24';

const weekly = (start: number, step: number, count = 30) =>
  Array.from({ length: count }, (_, index) => ({
    date: new Date(Date.UTC(2024, 0, 3 + index * 7)).toISOString().slice(0, 10),
    value: start + index * step,
  }));

const daily = (start: number, step = 0, count = 206) =>
  Array.from({ length: count }, (_, index) => ({
    date: new Date(Date.UTC(2024, 0, 1 + index)).toISOString().slice(0, 10),
    value: start + index * step,
  }));

function completeMap(): SeriesMap {
  return {
    WALCL: weekly(6000, 15),
    WDTGAL: weekly(700, 1),
    RRPONTSYD: daily(500, -0.4),
    RPONTSYD: daily(0),
    SOFR: daily(5.3, -0.0002),
    IORB: daily(5.4),
    BAMLH0A0HYM2: daily(3.8, -0.001),
    DGS10: daily(4.2, 0.001),
    VIXCLS: daily(14),
    DTWEXBGS: daily(120, 0.01),
    SP500: daily(5000, 1),
    WRBWFRBL: weekly(3200, 8),
    T10Y2Y: daily(0.3, 0.001),
  };
}

describe('snapshot data quality', () => {
  it('fails closed when WALCL is missing', () => {
    const snapshot = computeSnapshot({ ...completeMap(), WALCL: [] }, DATE, 'BULLISH') as any;

    expect(snapshot.decisionStatus).toBe('DATA_INCOMPLETE');
    expect(snapshot.score).toBeNull();
    expect(snapshot.verdict).toBeNull();
    expect(snapshot.factorResults.netliqTrend).toMatchObject({
      score: null,
      quality: 0,
      status: 'MISSING',
      asOf: null,
    });
    expect(snapshot.freshness.WALCL.status).toBe('MISSING');
  });

  it.each([
    ['WDTGAL', weekly(700, 1, 28)],
    ['RRPONTSYD', daily(500, -0.4, 198)],
  ] as const)('fails closed when critical %s is stale', (seriesId, staleSeries) => {
    const snapshot = computeSnapshot({ ...completeMap(), [seriesId]: staleSeries }, DATE, 'BEARISH') as any;

    expect(snapshot.decisionStatus).toBe('DATA_INCOMPLETE');
    expect(snapshot.score).toBeNull();
    expect(snapshot.verdict).toBeNull();
    expect(snapshot.factorResults.netliqTrend.status).toBe('STALE');
    expect(snapshot.factorResults.netliqTrend.score).toBeNull();
    expect(snapshot.freshness[seriesId].status).toBe('STALE');
  });

  it('fails closed when critical net-liquidity trend history is insufficient', () => {
    const shortWalcl = weekly(6000, 15, 13);
    const date = shortWalcl.at(-1)!.date;
    const snapshot = computeSnapshot({ ...completeMap(), WALCL: shortWalcl }, date, 'BULLISH') as any;

    expect(snapshot.freshness.WALCL.status).toBe('FRESH');
    expect(snapshot.factorResults.netliqTrend).toMatchObject({
      score: null,
      quality: 0,
      status: 'MISSING',
    });
    expect(snapshot.decisionStatus).toBe('DATA_INCOMPLETE');
    expect(snapshot.score).toBeNull();
    expect(snapshot.verdict).toBeNull();
  });

  it('excludes a missing noncritical factor and renormalizes the remaining configured positive weights', () => {
    const snapshot = computeSnapshot({ ...completeMap(), BAMLH0A0HYM2: [] }, DATE) as any;
    const available = Object.entries(WEIGHTS)
      .filter(([key, weight]) => weight > 0 && key !== 'credit')
      .map(([key, weight]) => [snapshot.factorResults[key].score, weight] as const);
    const expected = available.reduce((sum, [score, weight]) => sum + score * weight, 0)
      / available.reduce((sum, [, weight]) => sum + weight, 0);

    expect(snapshot.decisionStatus).toBe('OK');
    expect(snapshot.factorResults.credit).toMatchObject({ score: null, quality: 0, status: 'MISSING', asOf: null });
    expect(snapshot.score).toBeCloseTo(expected, 12);
    expect(snapshot.coverage).toBeCloseTo(7 / 8);
    expect(snapshot.factorResults.vol.score).not.toBeNull();
  });

  it('preserves the complete fresh pre-PR scores, thresholds, verdict, and reason exactly', () => {
    const snapshot = computeSnapshot(completeMap(), DATE, 'BEARISH') as any;

    expect(snapshot.decisionStatus).toBe('OK');
    expect(snapshot.score).toBe(54.46193058252426);
    expect(snapshot.verdict).toBe('BEARISH');
    expect(snapshot.reason).toBe('Fed 扩表、净流动性在升 → 环境偏空');
    expect(snapshot.coverage).toBe(1);
    expect(snapshot.factors).toEqual({
      netliqTrend: 63.39999999999998,
      impulse: 80,
      credit: 91.45300970873788,
      funding: 100,
      rates: 47.99999999999996,
      dollar: 0,
      vol: 88.88888888888889,
      reserveAdequacy: 71.8,
      curve: 51.791666666666664,
    });
    expect(Object.fromEntries(
      Object.entries(snapshot.factorResults).map(([key, result]: [string, any]) => [key, result.score]),
    )).toEqual(snapshot.factors);
    expect(snapshot.factorResults.funding.asOf).toBe(DATE);
    expect(snapshot.factorResults.funding.status).toBe('OK');
    expect(snapshot.factorResults.vol.quality).toBe(1);
  });

  it('uses the oldest required component observation as a factor as-of date', () => {
    const map = completeMap();
    map.SOFR = map.SOFR.filter(observation => observation.date <= '2024-07-22');
    const snapshot = computeSnapshot(map, DATE) as any;

    expect(snapshot.factorResults.funding.status).toBe('OK');
    expect(snapshot.factorResults.funding.asOf).toBe('2024-07-22');
    expect(snapshot.factorResults.funding.components.SOFR.observationDate).toBe('2024-07-22');
    expect(snapshot.factorResults.funding.components.IORB.observationDate).toBe(DATE);
  });

  it('uses the oldest reserve, SOFR, and IORB observation for complete reserve adequacy as-of', () => {
    const map = completeMap();
    map.SOFR = map.SOFR.filter(observation => observation.date <= '2024-07-22');
    const snapshot = computeSnapshot(map, DATE) as any;

    expect(snapshot.factorResults.reserveAdequacy.status).toBe('OK');
    expect(snapshot.factorResults.reserveAdequacy.asOf).toBe('2024-07-22');
  });

  it('keeps reserve adequacy explicitly partial from reserves when funding components are unavailable', () => {
    const snapshot = computeSnapshot({ ...completeMap(), SOFR: [], IORB: [] }, DATE) as any;

    expect(snapshot.factorResults.reserveAdequacy.status).toBe('PARTIAL');
    expect(snapshot.factorResults.reserveAdequacy.score).not.toBeNull();
    expect(snapshot.factorResults.reserveAdequacy.asOf).toBe(completeMap().WRBWFRBL.at(-1)!.date);
  });

  it('does not forward-fill old TGA and RRP forever into critical net-liquidity history', () => {
    const map = completeMap();
    const walcl = weekly(6000, 15, 14);
    const date = walcl.at(-1)!.date;
    map.WALCL = walcl;
    map.WDTGAL = [
      { date: walcl[0].date, value: 700 },
      { date, value: 713 },
    ];
    map.RRPONTSYD = [
      { date: walcl[0].date, value: 500 },
      { date, value: 450 },
    ];

    const snapshot = computeSnapshot(map, date) as any;

    expect(snapshot.freshness.WDTGAL.status).toBe('FRESH');
    expect(snapshot.freshness.RRPONTSYD.status).toBe('FRESH');
    expect(snapshot.factorResults.netliqTrend.components.historyObservations).toBeLessThan(14);
    expect(snapshot.decisionStatus).toBe('DATA_INCOMPLETE');
  });

  it.each([
    ['BAMLH0A0HYM2', 'credit'],
    ['DGS10', 'rates'],
    ['WRBWFRBL', 'reserveAdequacy'],
    ['T10Y2Y', 'curve'],
  ] as const)('does not fabricate a %s lookback delta from an arbitrarily old reference', (seriesId, factorKey) => {
    const map = completeMap();
    const current = map[seriesId].at(-1)!;
    map[seriesId] = [
      { date: '2024-01-01', value: current.value - 1 },
      current,
    ];

    const snapshot = computeSnapshot(map, DATE) as any;

    const components = snapshot.factorResults[factorKey].components;
    const lookbackChange = 'lookbackChange' in components
      ? components.lookbackChange
      : components.deltaReserves13w;
    expect(lookbackChange).toBeNull();
    expect(snapshot.factorResults[factorKey].status).not.toBe('OK');
  });
});
