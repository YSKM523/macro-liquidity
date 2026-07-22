import { describe, expect, it } from 'vitest';
// @ts-ignore -- isolated Node research module
import { PREREGISTRATION } from '../scripts/netliq-preregistration.mjs';

describe('net-liquidity challenger preregistration', () => {
  it('freezes the formula, evidence class, timing, OOS design, and decision rule before data fetch', () => {
    expect(PREREGISTRATION).toMatchObject({
      status: 'PREREGISTERED_BEFORE_FETCH',
      evidenceClass: 'RESEARCH_CURRENT_VINTAGE',
      series: ['WALCL', 'WDTGAL', 'WTREGEN', 'RRPONTSYD', 'SP500'],
      weights: { gap13: 0.45, impulse4: 0.35, impulse13: 0.20 },
      normalization: { method: 'PRIOR_ONLY_MAD', capWeeks: 156, minimumPriorWeeks: 52 },
      availability: { anchor: 'WALCL_WEDNESDAY', nominalTradableDay: 'FRIDAY' },
      target: { series: 'SP500', horizonWeeks: 13, direction: 'POSITIVE' },
      bootstrap: { method: 'SEEDED_MOVING_BLOCK', seed: 11_011, blockLength: 13, iterations: 2_000 },
      folds: { count: 6 },
      replacementEligible: false,
      allowedDecisions: ['KEEP_SHADOW', 'DROP_RESEARCH'],
    });
    expect(PREREGISTRATION.folds.ranges).toHaveLength(6);
    expect(PREREGISTRATION.decisionRule).toContain('nonOverlappingIc > 0');
  });
});
