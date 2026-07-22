import { describe, expect, it } from 'vitest';
// @ts-ignore -- isolated Node research module
import { renderNetLiquidityReport } from '../scripts/netliq-report.mjs';

describe('net-liquidity challenger report renderer', () => {
  it('renders evidence limits, all three diagnostics, decision, and rollback status', () => {
    const diagnostic = {
      overlapping: { ic: 0.12, n: 100 },
      nonOverlapping: { ic: 0.08, n: 12 },
      bootstrap: { ciLow: -0.02, ciHigh: 0.2, pValue: 0.12, iterations: 2_000, seed: 11_011, blockLength: 13 },
      positiveFoldCount: 4,
      signStability: 0.67,
      folds: [{ fold: 1, trainN: 0, evaluationN: 10, evaluationStart: '2005-01-01', evaluationEndExclusive: '2009-01-01', ic: null }],
      quintiles: [{ quintile: 1, count: 20, mean: 0.01, median: 0.02, negativeProbability: 0.4, tail10: -0.1 }],
    };
    const markdown = renderNetLiquidityReport({
      snapshotId: 'snapshot-1', snapshotSha256: 'abc', retrievedAt: '2026-07-22T00:00:00Z',
      evidenceClass: 'RESEARCH_CURRENT_VINTAGE', replacementEligible: false,
      sample: { weeklyPointCount: 100, firstWeeklyDate: '2003-01-01', lastWeeklyDate: '2026-01-01', rawScoredCount: 80, smoothScoredCount: 80, highAgreementCount: 60, lowAgreementCount: 20 },
      decision: { evidenceConclusion: 'INCONCLUSIVE', decision: 'DROP_RESEARCH', replacementEligible: false },
      oos: {
        raw: diagnostic, smooth: diagnostic, agreementConfirmed: diagnostic,
        agreement: { comparableCount: 80, confirmedCount: 60, disagreementCount: 20, rate: 0.75 },
        disagreement: { count: 20, meanForwardReturn: 0.01, medianForwardReturn: 0.02, negativeProbability: 0.4 },
      },
    });
    expect(markdown).toContain('RESEARCH_CURRENT_VINTAGE');
    expect(markdown).toContain('replacementEligible: `false`');
    expect(markdown).toContain('Raw');
    expect(markdown).toContain('Smooth');
    expect(markdown).toContain('Agreement-confirmed');
    expect(markdown).toContain('DROP_RESEARCH');
    expect(markdown).toContain('Champion');
    expect(markdown).toContain('无需数据库回滚');
  });
});
