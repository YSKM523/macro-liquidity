const foldRanges = [
  ['2005-01-01', '2009-01-01'],
  ['2009-01-01', '2013-01-01'],
  ['2013-01-01', '2017-01-01'],
  ['2017-01-01', '2021-01-01'],
  ['2021-01-01', '2024-01-01'],
  ['2024-01-01', '2100-01-01'],
];

export const PREREGISTRATION = Object.freeze({
  status: 'PREREGISTERED_BEFORE_FETCH',
  evidenceClass: 'RESEARCH_CURRENT_VINTAGE',
  series: ['WALCL', 'WDTGAL', 'WTREGEN', 'RRPONTSYD', 'SP500'],
  weights: { gap13: 0.45, impulse4: 0.35, impulse13: 0.20 },
  normalization: { method: 'PRIOR_ONLY_MAD', capWeeks: 156, minimumPriorWeeks: 52 },
  availability: { anchor: 'WALCL_WEDNESDAY', nominalTradableDay: 'FRIDAY' },
  target: { series: 'SP500', horizonWeeks: 13, direction: 'POSITIVE' },
  bootstrap: { method: 'SEEDED_MOVING_BLOCK', seed: 11_011, blockLength: 13, iterations: 2_000 },
  folds: {
    count: 6,
    ranges: foldRanges,
    emptyFoldPolicy: 'REPORT_EMPTY_NEVER_REDISTRIBUTE',
    rationale: 'Fixed broad calendar eras chosen before fetch; boundaries never depend on observed scores or returns.',
  },
  decisionRule: 'KEEP_SHADOW iff agreement nonOverlappingIc > 0, positiveFoldCount >= 4, nonOverlappingN >= 10, bootstrapP <= 0.10, and agreementRate >= 0.50; otherwise DROP_RESEARCH.',
  replacementEligible: false,
  allowedDecisions: ['KEEP_SHADOW', 'DROP_RESEARCH'],
});
