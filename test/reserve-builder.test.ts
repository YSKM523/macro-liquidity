import { describe, expect, it } from 'vitest';
// @ts-ignore -- isolated Node research module
import { buildWeeklyReserveFeatures } from '../scripts/reserve-challenger.mjs';

const row = (date: string, value: number) => ({ date, value });
const base = () => ({
  WRESBAL: [row('2024-01-03', 3_500_000), row('2024-04-03', 3_400_000)],
  GDP: [row('2023-10-01', 28_000), row('2024-01-01', 28_500)],
  SOFR: [row('2024-04-01', 5.31), row('2024-04-02', 5.32), row('2024-04-03', 5.33)],
  IORB: [row('2024-04-01', 5.40), row('2024-04-02', 5.40), row('2024-04-03', 5.40)],
  EFFR: [row('2024-04-01', 5.32), row('2024-04-02', 5.33), row('2024-04-03', 5.34)],
  TGCRRATE: [row('2024-04-01', 5.30), row('2024-04-02', 5.31), row('2024-04-03', 5.32)],
  NYFED_SRF_ACCEPTED: [row('2024-04-01', 0), row('2024-04-03', 2)],
});

describe('dynamic reserve adequacy weekly builder', () => {
  it('anchors Friday, converts units, pairs rates only on identical trailing-week dates, and reports provenance', () => {
    const [feature] = buildWeeklyReserveFeatures(base(), ['2024-04-05']);
    expect(feature.decisionStatus).toBe('OK');
    expect(feature.relativeReserves).toMatchObject({ status: 'OK', reserveAsOf: '2024-04-03', reserveAgeDays: 2, gdpAsOf: '2024-01-01', gdpAgeDays: 95, reserveB: 3_400, gdpB: 28_500 });
    expect(feature.relativeReserves.value).toBeCloseTo(11.92982456);
    expect(feature.reserveChange13).toMatchObject({ status: 'OK', currentAsOf: '2024-04-03', priorTargetDate: '2024-01-05', priorAsOf: '2024-01-03', priorAgeDays: 2, value: -100 });
    expect(feature.sofrIorb).toMatchObject({ status: 'OK', pairCount: 3, latestPairDate: '2024-04-03', ageDays: 2, medianBps: -8, p95Bps: -7.1 });
    expect(feature.auxiliaryFunding).toMatchObject({ status: 'OK', effrPairCount: 3, tgcrPairCount: 3, srfCount: 2, latestEffrPairDate: '2024-04-03', latestTgcrPairDate: '2024-04-03', latestSrfDate: '2024-04-03', effrMedianBps: -7, tgcrMedianBps: -9, srfMaxB: 2 });
    expect(feature.provenance).toMatchObject({ evidenceClass: 'RESEARCH_CURRENT_VINTAGE', source: 'FRED_AND_NYFED_CURRENT_VINTAGE' });
  });

  it('does not pair rates across dates and fails closed for missing or stale independent components', () => {
    const missing = base();
    missing.IORB = [row('2024-04-01', 5.4), row('2024-04-02', 5.4), row('2024-04-04', 5.4)];
    const [feature] = buildWeeklyReserveFeatures(missing, ['2024-04-05']);
    expect(feature.decisionStatus).toBe('DATA_INCOMPLETE');
    expect(feature.sofrIorb).toMatchObject({ status: 'INSUFFICIENT_PAIRS', pairCount: 2 });

    const stale = base();
    stale.NYFED_SRF_ACCEPTED = [row('2024-03-31', 0)];
    const [staleFeature] = buildWeeklyReserveFeatures(stale, ['2024-04-05']);
    expect(staleFeature.auxiliaryFunding.status).toBe('STALE_SRF');
    expect(staleFeature.decisionStatus).toBe('DATA_INCOMPLETE');
  });

  it('contains a one-day quarter-end spike in its own weekly maximum', () => {
    const input = base();
    input.NYFED_SRF_ACCEPTED = [row('2024-04-01', 50), row('2024-04-03', 0), row('2024-04-08', 0), row('2024-04-10', 0)];
    input.WRESBAL.push(row('2024-04-10', 3_400_000));
    for (const series of ['SOFR', 'IORB', 'EFFR', 'TGCRRATE'] as const) {
      input[series].push(row('2024-04-08', input[series].at(-1)!.value), row('2024-04-09', input[series].at(-1)!.value), row('2024-04-10', input[series].at(-1)!.value));
    }
    const [first, next] = buildWeeklyReserveFeatures(input, ['2024-04-05', '2024-04-12']);
    expect(first.auxiliaryFunding.srfMaxB).toBe(50);
    expect(next.auxiliaryFunding.srfMaxB).toBe(0);
  });

  it('fails closed instead of indefinitely forward-filling a stale 13-week prior reserve', () => {
    const input = base();
    input.WRESBAL = [row('2020-01-01', 3_500_000), row('2024-04-03', 3_400_000)];
    const [feature] = buildWeeklyReserveFeatures(input, ['2024-04-05']);
    expect(feature.reserveChange13).toMatchObject({
      status: 'STALE_PRIOR_WRESBAL', priorTargetDate: '2024-01-05',
      priorAsOf: '2020-01-01', priorAgeDays: 1465, value: null,
    });
    expect(feature.decisionStatus).toBe('DATA_INCOMPLETE');
  });

  it.each([
    ['unsorted', [row('2024-04-03', 1), row('2024-01-03', 2)]],
    ['duplicate', [row('2024-04-03', 1), row('2024-04-03', 2)]],
    ['non-finite', [row('2024-04-03', Number.NaN)]],
  ])('rejects %s source data and non-Friday anchors', (_label, WRESBAL) => {
    expect(() => buildWeeklyReserveFeatures({ ...base(), WRESBAL }, ['2024-04-05'])).toThrow();
    expect(() => buildWeeklyReserveFeatures(base(), ['2024-04-04'])).toThrow(/Friday/);
  });
});
