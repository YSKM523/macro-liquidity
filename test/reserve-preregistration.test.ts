import { describe, expect, it } from 'vitest';
// @ts-ignore -- isolated Node research module
import { PREREGISTRATION } from '../scripts/reserve-preregistration.mjs';

describe('dynamic reserve adequacy preregistration', () => {
  it('freezes the formula, state boundaries, OOS gate, and exact primary series before fetch', () => {
    expect(PREREGISTRATION).toMatchObject({
      status: 'AMENDED_AFTER_REVIEW_BEFORE_CORRECTED_FETCH',
      methodologyVersion: 'PR12_RESEARCH_V2_SRF_BOUNDARY',
      evidenceClass: 'RESEARCH_CURRENT_VINTAGE',
      series: ['WRESBAL', 'GDP', 'SOFR', 'IORB', 'EFFR', 'TGCRRATE', 'NYFED_SRF_ACCEPTED', 'SP500'],
      weights: { relativeReserves: 0.30, reserveChange13: 0.25, sofrIorb: 0.25, auxiliaryFunding: 0.20 },
      minimumPriorWeeks: 52,
      states: { abundant: 80, ample: 60, transition: 40, scarce: 20 },
      replacementEligible: false,
      allowedDecisions: ['KEEP_SHADOW', 'DROP_RESEARCH'],
    });
    expect(PREREGISTRATION.folds.boundaries).toEqual([
      '2018-01-01', '2020-01-01', '2022-01-01', '2023-01-01',
      '2024-01-01', '2025-01-01', '2100-01-01',
    ]);
    expect(PREREGISTRATION.decisionRule).toContain('top score quintile');
    expect(PREREGISTRATION.amendments).toEqual([expect.objectContaining({
      id: 'A-001', kind: 'PRIMARY_SOURCE_CORRECTION', tuning: false,
      formulaChanged: false, replacementEligibleChanged: false,
    }), expect.objectContaining({ id: 'A-002', kind: 'POST_FETCH_CORRECTNESS', tuning: false, invalidatedSnapshotId: 'reserve-current-vintage-2026-07-22-v1' })]);
    expect(PREREGISTRATION.sources.NYFED_SRF_ACCEPTED).toMatchObject({
      endpoint: 'https://markets.newyorkfed.org/api/rp/results/search.json',
      operationTypes: 'Repo',
      aggregation: 'SUM_TOTAL_AMT_ACCEPTED_BY_OPERATION_DATE_FOR_OVERNIGHT_SRP',
      launchDate: '2021-07-29',
    });
    expect(Object.isFrozen(PREREGISTRATION)).toBe(true);
  });
});
