import { describe, expect, it } from 'vitest';
// @ts-ignore -- isolated Node research module
import { PREREGISTRATION } from '../scripts/netliq-preregistration.mjs';

describe('net-liquidity challenger preregistration', () => {
  it('freezes the formula, evidence class, timing, OOS design, and decision rule before data fetch', () => {
    expect(PREREGISTRATION).toMatchObject({
      status: 'AMENDED_AFTER_REVIEW',
      methodologyVersion: 'PR11_RESEARCH_V2_REVIEW_AMENDED',
      evidenceClass: 'RESEARCH_CURRENT_VINTAGE',
      series: ['WALCL', 'WDTGAL', 'WTREGEN', 'RRPONTSYD', 'SP500'],
      weights: { gap13: 0.45, impulse4: 0.35, impulse13: 0.20 },
      normalization: { method: 'PRIOR_ONLY_MAD', capWeeks: 156, minimumPriorWeeks: 52 },
      availability: {
        anchor: 'WALCL_WEDNESDAY',
        originalLagDays: 2,
        effectiveConservativeLagDays: 7,
      },
      dataHygiene: { maxStartGapDays: 7, maxEndGapDays: 7 },
      target: { series: 'SP500', horizonWeeks: 13, direction: 'POSITIVE' },
      bootstrap: { method: 'SEEDED_MOVING_BLOCK', seed: 11_011, blockLength: 13, iterations: 2_000 },
      folds: { count: 6 },
      replacementEligible: false,
      allowedDecisions: ['KEEP_SHADOW', 'DROP_RESEARCH'],
    });
    expect(PREREGISTRATION.folds.ranges).toHaveLength(6);
    expect(PREREGISTRATION.decisionRule).toContain('nonOverlappingIc > 0');
    expect(PREREGISTRATION.amendments).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'A-001', kind: 'REVIEW_CORRECTNESS', implementationCommit: '30f2ef9' }),
      expect.objectContaining({ id: 'A-002', kind: 'POST_FETCH_DATA_HYGIENE', implementationCommit: '47e2358' }),
      expect.objectContaining({ id: 'A-003', kind: 'REVIEW_TRUST_BOUNDARY', implementationCommit: '0fff138' }),
    ]));
    expect(PREREGISTRATION.initialReport).toMatchObject({ status: 'INVALIDATED_BY_REVIEW', publicationCommit: '47e2358' });
    expect(PREREGISTRATION.correctedReport).toMatchObject({ status: 'GENERATED_ONCE_AFTER_REVIEW', snapshotSchemaVersion: 2 });
    expect(PREREGISTRATION.formulaAmended).toBe(false);
  });
});
