import { describe, expect, it } from 'vitest';
// @ts-ignore -- isolated Node research module
import { PREREGISTRATION } from '../scripts/reserve-preregistration.mjs';

describe('dynamic reserve adequacy preregistration', () => {
  it('freezes the formula, state boundaries, OOS gate, and exact primary series before fetch', () => {
    expect(PREREGISTRATION).toMatchObject({
      status: 'PREREGISTERED_BEFORE_FETCH',
      evidenceClass: 'RESEARCH_CURRENT_VINTAGE',
      series: ['WRESBAL', 'GDP', 'SOFR', 'IORB', 'EFFR', 'TGCR', 'SRFONTSYD', 'SP500'],
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
    expect(Object.isFrozen(PREREGISTRATION)).toBe(true);
  });
});
