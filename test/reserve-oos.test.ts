import { describe, expect, it } from 'vitest';
// @ts-ignore -- isolated Node research module
import { alignReserveForwardReturns, decideReserveResearch, evaluateReserveOos, movingBlockBootstrapIc, nonOverlappingPairs } from '../scripts/reserve-oos.mjs';

const DAY = 86_400_000;
const date = (base: string, days: number) => new Date(Date.parse(`${base}T00:00:00Z`) + days * DAY).toISOString().slice(0, 10);

describe('dynamic reserve adequacy OOS evaluator', () => {
  it('enters first SPX close on/after next Monday and exits first close on/after 91 days with seven-day caps', () => {
    const pairs = alignReserveForwardReturns([{ anchorDate: '2024-01-05', score: 70, state: 'AMPLE' }], [
      { date: '2024-01-05', value: 99 }, { date: '2024-01-08', value: 100 },
      { date: '2024-04-07', value: 109 }, { date: '2024-04-08', value: 110 },
    ]);
    expect(pairs).toEqual([expect.objectContaining({ entryDate: '2024-01-08', endDate: '2024-04-08', forwardReturn: 0.1 })]);
    expect(alignReserveForwardReturns([{ anchorDate: '2010-01-08', score: 70, state: 'AMPLE' }], [{ date: '2016-01-01', value: 100 }])).toEqual([]);
  });

  it('selects chronological interval-non-overlapping outcomes', () => {
    const pairs = Array.from({ length: 30 }, (_, index) => ({ entryDate: date('2020-01-06', index * 7), endDate: date('2020-04-06', index * 7), score: index, forwardReturn: index / 100 }));
    const selected = nonOverlappingPairs(pairs);
    expect(selected.length).toBeLessThan(pairs.length);
    for (let index = 1; index < selected.length; index += 1) expect(selected[index].entryDate >= selected[index - 1].endDate).toBe(true);
  });

  it('uses a deterministic seeded moving-block bootstrap', () => {
    const pairs = Array.from({ length: 80 }, (_, index) => ({ score: index % 17, forwardReturn: (index % 17) / 100 }));
    const first = movingBlockBootstrapIc(pairs, { iterations: 200 });
    expect(movingBlockBootstrapIc(pairs, { iterations: 200 })).toEqual(first);
    expect(first).toMatchObject({ seed: 12012, blockLength: 13, iterations: 200 });
  });

  it('reports overlapping/non-overlapping IC, six fixed folds, counts, quintile tails, and monotonicity', () => {
    const friday = Date.parse('2018-01-05T00:00:00Z');
    const signals = Array.from({ length: 420 }, (_, index) => ({
      anchorDate: new Date(friday + index * 7 * DAY).toISOString().slice(0, 10),
      score: index % 101,
      state: index % 2 ? 'AMPLE' : 'TRANSITION',
    }));
    const spx = Array.from({ length: 3_100 }, (_, index) => ({ date: date('2018-01-08', index), value: 1_000 + index ** 2 }));
    const report = evaluateReserveOos(signals, spx, { bootstrapIterations: 50 });
    expect(report.overlapping.n).toBeGreaterThan(350);
    expect(report.nonOverlapping.n).toBeLessThan(report.overlapping.n);
    expect(report.folds).toHaveLength(6);
    expect(report.folds.map((fold: any) => fold.evaluationStart)).toEqual(['2018-01-01', '2020-01-01', '2022-01-01', '2023-01-01', '2024-01-01', '2025-01-01']);
    expect(report.quintiles).toHaveLength(5);
    expect(report.quintiles.reduce((sum: number, bucket: any) => sum + bucket.count, 0)).toBe(report.overlapping.n);
    expect(report.quintiles[0]).toMatchObject({ mean: expect.any(Number), median: expect.any(Number), negativeProbability: expect.any(Number), tail10: expect.any(Number) });
    expect(report.scoreCounts.total).toBe(signals.length);
    expect(report.stateCounts).toMatchObject({ AMPLE: 210, TRANSITION: 210 });
    expect(report.monotonicity).toMatchObject({ adjacentMeanNonDecreasing: expect.any(Boolean), topNoWorseMean: expect.any(Boolean), topNoWorseTail10: expect.any(Boolean) });
  });

  it('keeps shadow only when every frozen gate passes and always blocks replacement', () => {
    const passing = {
      nonOverlapping: { ic: 0.1, n: 20 }, positiveFoldCount: 4,
      bootstrap: { pValue: 0.05 },
      monotonicity: { topNoWorseMean: true, topNoWorseTail10: true },
    };
    expect(decideReserveResearch(passing, 'RESEARCH_CURRENT_VINTAGE')).toEqual({ decision: 'KEEP_SHADOW', replacementEligible: false });
    expect(decideReserveResearch({ ...passing, monotonicity: { ...passing.monotonicity, topNoWorseTail10: false } }, 'RESEARCH_CURRENT_VINTAGE')).toEqual({ decision: 'DROP_RESEARCH', replacementEligible: false });
    expect(() => decideReserveResearch(passing, 'PIT')).toThrow(/RESEARCH_CURRENT_VINTAGE/);
  });
});
