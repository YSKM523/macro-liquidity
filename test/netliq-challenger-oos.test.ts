import { describe, expect, it } from 'vitest';
// @ts-ignore -- isolated Node research module
import { alignForwardReturns, decideNetLiquidityResearch, evaluateNetLiquidityOos, evaluateScorePairs, movingBlockBootstrapIc, nonOverlappingPairs } from '../scripts/netliq-oos.mjs';
// @ts-ignore -- isolated Node research module
import { buildWeeklyNetLiquidity } from '../scripts/netliq-challenger.mjs';

const pair = (index: number, score = index, forwardReturn = index / 100) => ({
  availableDate: new Date(Date.parse('2020-01-03T00:00:00Z') + index * 7 * 86_400_000).toISOString().slice(0, 10),
  startDate: new Date(Date.parse('2020-01-03T00:00:00Z') + index * 7 * 86_400_000).toISOString().slice(0, 10),
  endDate: new Date(Date.parse('2020-04-03T00:00:00Z') + index * 7 * 86_400_000).toISOString().slice(0, 10),
  score,
  forwardReturn,
});

const historicPair = (index: number) => {
  const start = Date.parse('2005-01-07T00:00:00Z') + index * 7 * 86_400_000;
  return {
    availableDate: new Date(start).toISOString().slice(0, 10),
    startDate: new Date(start).toISOString().slice(0, 10),
    endDate: new Date(start + 13 * 7 * 86_400_000).toISOString().slice(0, 10),
    score: index % 23,
    forwardReturn: (index % 23) / 100,
  };
};

describe('continuous net-liquidity OOS evaluator', () => {
  it('starts at the first SPX close on/after the explicit conservative bound and ends 13 weeks later', () => {
    const aligned = alignForwardReturns([
      { observationDate: '2024-01-03', availableDate: '2024-01-10', score: 60 },
    ], [
      { date: '2024-01-09', value: 100 },
      { date: '2024-01-10', value: 110 },
      { date: '2024-04-09', value: 120 },
      { date: '2024-04-10', value: 121 },
    ]);
    expect(aligned).toEqual([expect.objectContaining({
      startDate: '2024-01-10',
      endDate: '2024-04-10',
    })]);
    expect(aligned[0].forwardReturn).toBeCloseTo(0.1, 12);
  });

  it('drops signals without a start or complete 13-week end price', () => {
    expect(alignForwardReturns([
      { observationDate: '2024-01-03', availableDate: '2024-01-05', score: 60 },
    ], [{ date: '2024-01-04', value: 100 }])).toEqual([]);
  });

  it('does not bridge a long missing-price gap into a much later SPX history', () => {
    expect(alignForwardReturns([
      { observationDate: '2010-01-06', availableDate: '2010-01-08', score: 60 },
    ], [
      { date: '2016-07-22', value: 100 },
      { date: '2016-10-24', value: 110 },
    ])).toEqual([]);
  });

  it.each([
    {
      observationDate: '2016-11-23', expectedStart: '2016-11-30', preReleaseFriday: '2016-11-25',
      rrpDates: ['2016-11-16', '2016-11-17', '2016-11-18', '2016-11-21', '2016-11-23'],
      targetEnd: '2017-03-01',
    },
    {
      observationDate: '2024-11-27', expectedStart: '2024-12-04', preReleaseFriday: '2024-11-29',
      rrpDates: ['2024-11-20', '2024-11-21', '2024-11-22', '2024-11-25', '2024-11-27'],
      targetEnd: '2025-03-05',
    },
  ])('does not execute holiday-week observation $observationDate at pre-release Friday', ({ observationDate, expectedStart, preReleaseFriday, rrpDates, targetEnd }) => {
    const [weekly] = buildWeeklyNetLiquidity({
      WALCL: [{ date: observationDate, value: 8_100_000 }],
      WDTGAL: [{ date: observationDate, value: 710_000 }],
      WTREGEN: [{ date: observationDate, value: 660_000 }],
      RRPONTSYD: rrpDates.map((date, index) => ({ date, value: 500 - index * 10 })),
    });
    const aligned = alignForwardReturns([{ ...weekly, score: 60 }], [
      { date: preReleaseFriday, value: 100 },
      { date: expectedStart, value: 110 },
      { date: targetEnd, value: 121 },
    ]);
    expect(aligned[0]).toMatchObject({ startDate: expectedStart, endDate: targetEnd });
  });

  it('counts only fully matured outcomes in each fold training prefix', () => {
    const pairs = [
      { availableDate: '2020-01-03', startDate: '2020-01-03', endDate: '2020-04-03', score: 1, forwardReturn: 0.01 },
      { availableDate: '2020-12-04', startDate: '2020-12-04', endDate: '2021-03-05', score: 2, forwardReturn: 0.02 },
      { availableDate: '2021-01-08', startDate: '2021-01-08', endDate: '2021-04-09', score: 3, forwardReturn: 0.03 },
    ];
    const fold5 = evaluateScorePairs(pairs, { bootstrapIterations: 0 }).folds[4];
    expect(fold5.trainN).toBe(1);
  });

  it('selects a chronological interval-non-overlapping subset', () => {
    const selected = nonOverlappingPairs(Array.from({ length: 40 }, (_, index) => pair(index)));
    expect(selected.length).toBeLessThan(40);
    for (let index = 1; index < selected.length; index += 1) {
      expect(selected[index].startDate >= selected[index - 1].endDate).toBe(true);
    }
  });

  it('uses a fixed seeded moving-block bootstrap', () => {
    const pairs = Array.from({ length: 80 }, (_, index) => pair(index, index % 19, (index % 19) / 100));
    const first = movingBlockBootstrapIc(pairs, { seed: 11_011, blockLength: 13, iterations: 250 });
    const second = movingBlockBootstrapIc(pairs, { seed: 11_011, blockLength: 13, iterations: 250 });
    expect(first).toEqual(second);
    expect(first).toMatchObject({ iterations: 250, seed: 11_011, blockLength: 13 });
    expect(first.ciLow).not.toBeNull();
    expect(first.ciHigh).not.toBeNull();
  });

  it('reports overlapping/non-overlapping IC, six expanding folds, and five score quintiles', () => {
    const pairs = Array.from({ length: 1_130 }, (_, index) => historicPair(index));
    const report = evaluateScorePairs(pairs, { bootstrapIterations: 100 });
    expect(report.overlapping).toMatchObject({ n: 1_130, ic: 1 });
    expect(report.nonOverlapping.n).toBeLessThan(report.overlapping.n);
    expect(report.folds).toHaveLength(6);
    expect(report.folds.map((fold: any) => fold.evaluationStart)).toEqual([
      '2005-01-01', '2009-01-01', '2013-01-01', '2017-01-01', '2021-01-01', '2024-01-01',
    ]);
    expect(report.folds.map((fold: any) => fold.trainN)).toEqual([...report.folds.map((fold: any) => fold.trainN)].sort((a: number, b: number) => a - b));
    expect(report.positiveFoldCount).toBe(6);
    expect(report.signStability).toBe(1);
    expect(report.quintiles).toHaveLength(5);
    expect(report.quintiles.reduce((sum: number, quintile: any) => sum + quintile.count, 0)).toBe(1_130);
    expect(report.quintiles[0]).toEqual(expect.objectContaining({
      count: 226,
      mean: expect.any(Number),
      median: expect.any(Number),
      negativeProbability: 0,
      tail10: expect.any(Number),
    }));
  });

  it('hard-codes current-vintage evidence as ineligible to replace the Champion', () => {
    const strong = {
      nonOverlapping: { ic: 0.2, n: 20 },
      bootstrap: { pValue: 0.05 },
      positiveFoldCount: 5,
      agreementRate: 0.8,
    };
    expect(decideNetLiquidityResearch(strong, 'RESEARCH_CURRENT_VINTAGE')).toEqual({
      evidenceConclusion: 'IMPROVES',
      decision: 'KEEP_SHADOW',
      replacementEligible: false,
    });
    expect(decideNetLiquidityResearch({ ...strong, positiveFoldCount: 2 }, 'RESEARCH_CURRENT_VINTAGE')).toEqual({
      evidenceConclusion: 'INCONCLUSIVE',
      decision: 'DROP_RESEARCH',
      replacementEligible: false,
    });
    expect(() => decideNetLiquidityResearch(strong, 'PIT')).toThrow(/RESEARCH_CURRENT_VINTAGE/);
  });

  it('reports Raw, Smooth, agreement-confirmed, and disagreement diagnostics together', () => {
    const start = Date.parse('2018-01-05T00:00:00Z');
    const challenger = Array.from({ length: 180 }, (_, index) => {
      const availableDate = new Date(start + index * 7 * 86_400_000).toISOString().slice(0, 10);
      const high = index % 4 !== 0;
      return {
        observationDate: new Date(Date.parse(`${availableDate}T00:00:00Z`) - 2 * 86_400_000).toISOString().slice(0, 10),
        availableDate,
        raw: { score: index % 31 },
        smooth: { score: high ? index % 31 : 100 - index % 31 },
        agreement: { confidence: high ? 'HIGH' : 'LOW' },
      };
    });
    const spx = Array.from({ length: 200 }, (_, index) => ({
      date: new Date(start + index * 7 * 86_400_000).toISOString().slice(0, 10),
      value: 1_000 + index ** 2,
    }));
    const report = evaluateNetLiquidityOos(challenger, spx, { bootstrapIterations: 50 });
    expect(report.evidenceClass).toBe('RESEARCH_CURRENT_VINTAGE');
    expect(report.raw.overlapping.n).toBeGreaterThan(100);
    expect(report.smooth.overlapping.n).toBe(report.raw.overlapping.n);
    expect(report.agreementConfirmed.overlapping.n).toBeLessThan(report.raw.overlapping.n);
    expect(report.agreement.rate).toBeCloseTo(0.75);
    expect(report.disagreement).toMatchObject({ count: 45 });
    expect(report.decision.replacementEligible).toBe(false);
    expect(['KEEP_SHADOW', 'DROP_RESEARCH']).toContain(report.decision.decision);
  });
});
