import { describe, expect, it } from 'vitest';
// @ts-ignore -- isolated Node research module
import { renderReserveReport } from '../scripts/reserve-report.mjs';

describe('reserve challenger report disclosure', () => {
  it('labels source correction, current-vintage evidence, frozen gate, freshness, and no production impact', () => {
    const report: any = {
      snapshotId: 'fixture', snapshotSha256: 'a'.repeat(64), retrievedAt: '2026-07-22T00:00:00.000Z',
      methodologyVersion: 'PR12_RESEARCH_V1_SOURCE_CORRECTED', evidenceClass: 'RESEARCH_CURRENT_VINTAGE', replacementEligible: false,
      sample: { weeklyCount: 100, completeCount: 80, scoredCount: 20, firstAnchor: '2020-01-03', lastAnchor: '2026-01-02', stateCounts: { AMPLE: 10 } },
      decision: { decision: 'DROP_RESEARCH', replacementEligible: false },
      oos: {
        overlapping: { ic: 0.1, n: 20 }, nonOverlapping: { ic: 0.05, n: 6 }, positiveFoldCount: 2,
        bootstrap: { ciLow: -0.1, ciHigh: 0.2, pValue: 0.2, iterations: 2000 },
        folds: Array.from({ length: 6 }, (_, i) => ({ fold: i + 1, evaluationStart: `${2018 + i}-01-01`, evaluationEndExclusive: `${2019 + i}-01-01`, trainN: i, evaluationN: 2, ic: 0.1 })),
        quintiles: Array.from({ length: 5 }, (_, i) => ({ quintile: i + 1, count: 4, mean: 0.01, median: 0.01, negativeProbability: 0.25, tail10: -0.02 })),
        monotonicity: { adjacentMeanNonDecreasing: true, adjacentMeanViolations: 0, topNoWorseMean: true, topNoWorseTail10: true },
      },
    };
    const markdown = renderReserveReport(report);
    for (const phrase of ['A-001', 'A-002', 'TGCRRATE', 'NY Fed', '2021-07-29', 'small-value exercises', 'RESEARCH_CURRENT_VINTAGE', 'not ALFRED/PIT', 'DATA_INCOMPLETE', 'replacementEligible: `false`', 'Champion: unchanged', 'DROP_RESEARCH']) expect(markdown).toContain(phrase);
  });
});
