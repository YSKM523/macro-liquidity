import { describe, expect, it } from 'vitest';
// @ts-ignore -- isolated Node research module
import { classifyReserveState, scoreReserveFeatures, strictlyPriorPercentile } from '../scripts/reserve-challenger.mjs';

const feature = (index: number, overrides: any = {}) => ({
  anchorDate: new Date(Date.parse('2020-01-03T00:00:00Z') + index * 7 * 86_400_000).toISOString().slice(0, 10),
  decisionStatus: 'OK',
  relativeReserves: { status: 'OK', value: index },
  reserveChange13: { status: 'OK', value: index },
  sofrIorb: { status: 'OK', medianBps: 100 - index, p95Bps: 100 - index },
  auxiliaryFunding: { status: 'OK', effrMedianBps: 100 - index, tgcrMedianBps: 100 - index, srfMaxB: 100 - index },
  provenance: { evidenceClass: 'RESEARCH_CURRENT_VINTAGE' },
  ...overrides,
});

describe('dynamic reserve adequacy prior-only score', () => {
  it('uses a strictly-prior tie-midrank percentile and requires 52 complete prior weeks', () => {
    expect(strictlyPriorPercentile([1, 2, 2, 4], 2)).toBe(50);
    const scored = scoreReserveFeatures(Array.from({ length: 53 }, (_, index) => feature(index)));
    expect(scored[51].score).toBeNull();
    expect(scored[52]).toMatchObject({ score: 100, state: 'ABUNDANT', priorCompleteWeeks: 52 });
  });

  it('applies exactly 30/25/25/20 and worse funding lowers otherwise identical high reserves', () => {
    const history = Array.from({ length: 52 }, (_, index) => feature(index));
    const good = feature(52);
    const bad = feature(53, {
      anchorDate: '2021-01-08',
      relativeReserves: good.relativeReserves,
      reserveChange13: good.reserveChange13,
      sofrIorb: { status: 'OK', medianBps: 1_000, p95Bps: 1_000 },
      auxiliaryFunding: { status: 'OK', effrMedianBps: 1_000, tgcrMedianBps: 1_000, srfMaxB: 1_000 },
    });
    const [goodScored] = scoreReserveFeatures([...history, good]).slice(-1);
    const [badScored] = scoreReserveFeatures([...history, bad]).slice(-1);
    expect(goodScored.components).toEqual({ relativeReserves: 100, reserveChange13: 100, sofrIorb: 100, auxiliaryFunding: 100 });
    expect(goodScored.score).toBe(100);
    expect(badScored.score).toBe(55);
    expect(badScored.score).toBeLessThan(goodScored.score);
  });

  it('is prefix invariant and excludes incomplete rows from percentile history', () => {
    const rows = Array.from({ length: 70 }, (_, index) => feature(index));
    rows[20] = feature(20, { decisionStatus: 'DATA_INCOMPLETE' });
    const prefix = scoreReserveFeatures(rows.slice(0, 60));
    const extended = scoreReserveFeatures(rows);
    expect(extended.slice(0, 60)).toEqual(prefix);
    expect(extended[52].priorCompleteWeeks).toBe(51);
    expect(extended[53].priorCompleteWeeks).toBe(52);
  });

  it.each([[80, 'ABUNDANT'], [79.999, 'AMPLE'], [60, 'AMPLE'], [40, 'TRANSITION'], [20, 'SCARCE'], [19.999, 'STRESSED']])('classifies %s as %s', (score, state) => {
    expect(classifyReserveState(score)).toBe(state);
  });
});
