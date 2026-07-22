# Continuous Net Liquidity Challenger — Initial Report (INVALIDATED_BY_REVIEW)

> This artifact is retained only for audit history. It is not the canonical PR-11 result. Review found that the original Wed+2 availability rule could select a pre-release Friday during delayed holiday publication weeks. The corrected methodology uses Wed+7 and a separately generated corrected report. The original claim that every rule was frozen before fetch was also inaccurate because the seven-day SPX gap cap was added after fetch but before this initial report.

> This report was generated once from the frozen preregistration and immutable normalized snapshot. No formula, window, direction, fold, or gate was changed after observing results.

## Status and evidence

- Evidence class: `RESEARCH_CURRENT_VINTAGE`
- Snapshot: `netliq-current-vintage-2026-07-22`
- Snapshot SHA-256: `ffce5c984d606bac259adb8920f18b02e9a68d8e78bacaee521cf19178a36101`
- Retrieved at: `2026-07-22T15:09:46.800Z`
- replacementEligible: `false`
- Evidence conclusion: `INCONCLUSIVE`
- Research decision: `DROP_RESEARCH`
- Production Champion: unchanged

This is current-vintage FRED research, not ALFRED/PIT evidence. Historical revisions may be present. Therefore even favorable diagnostics cannot replace the Champion in this PR.

## Sample

| Item | Value |
|---|---:|
| Weekly Raw/Smooth points | 1205 |
| Weekly range | 2003-06-18 to 2026-07-15 |
| Raw scored | 1140 |
| Smooth scored | 1140 |
| HIGH agreement | 1058 |
| LOW agreement | 82 |

SPX current-vintage coverage determines the evaluable target window. Signals use WALCL Wednesday data, become nominally available Friday, and start at the first SPX close within seven calendar days; the target ends at the first close within seven days after 91 calendar days. Long missing-price gaps are never bridged.

## OOS diagnostics

### Raw

| Metric | Value |
|---|---:|
| overlapping Spearman IC / n | 0.2389 / 510 |
| non-overlapping Spearman IC / n | 0.0362 / 39 |
| moving-block bootstrap 95% CI | [0.0552, 0.3917] |
| bootstrap p(IC <= 0) | 0.0055 |
| positive folds | 3 / 6 |
| sign stability | 75.00% |

| Fold | Start | End exclusive | Prior prefix n | Evaluation n | IC |
|---:|---|---|---:|---:|---:|
| 1 | 2005-01-01 | 2009-01-01 | 0 | 0 | null |
| 2 | 2009-01-01 | 2013-01-01 | 0 | 0 | null |
| 3 | 2013-01-01 | 2017-01-01 | 0 | 25 | -0.3224 |
| 4 | 2017-01-01 | 2021-01-01 | 25 | 208 | 0.1888 |
| 5 | 2021-01-01 | 2024-01-01 | 233 | 157 | 0.4198 |
| 6 | 2024-01-01 | 2100-01-01 | 390 | 120 | 0.1739 |

| Score bucket | n | Mean return | Median return | P(return < 0) | 10% tail |
|---|---:|---:|---:|---:|---:|
| Q1 | 102 | 2.50% | 3.91% | 26.47% | -6.22% |
| Q2 | 102 | 2.73% | 3.52% | 28.43% | -5.24% |
| Q3 | 102 | 2.50% | 3.63% | 29.41% | -5.08% |
| Q4 | 102 | 3.11% | 4.76% | 29.41% | -6.80% |
| Q5 | 102 | 6.36% | 6.43% | 9.80% | 0.19% |

### Smooth

| Metric | Value |
|---|---:|
| overlapping Spearman IC / n | 0.2555 / 510 |
| non-overlapping Spearman IC / n | 0.2526 / 39 |
| moving-block bootstrap 95% CI | [0.0685, 0.4025] |
| bootstrap p(IC <= 0) | 0.0045 |
| positive folds | 3 / 6 |
| sign stability | 75.00% |

| Fold | Start | End exclusive | Prior prefix n | Evaluation n | IC |
|---:|---|---|---:|---:|---:|
| 1 | 2005-01-01 | 2009-01-01 | 0 | 0 | null |
| 2 | 2009-01-01 | 2013-01-01 | 0 | 0 | null |
| 3 | 2013-01-01 | 2017-01-01 | 0 | 25 | -0.3397 |
| 4 | 2017-01-01 | 2021-01-01 | 25 | 208 | 0.2151 |
| 5 | 2021-01-01 | 2024-01-01 | 233 | 157 | 0.4135 |
| 6 | 2024-01-01 | 2100-01-01 | 390 | 120 | 0.2052 |

| Score bucket | n | Mean return | Median return | P(return < 0) | 10% tail |
|---|---:|---:|---:|---:|---:|
| Q1 | 102 | 2.78% | 4.09% | 25.49% | -5.54% |
| Q2 | 102 | 1.63% | 2.90% | 35.29% | -6.81% |
| Q3 | 102 | 2.42% | 3.85% | 29.41% | -5.83% |
| Q4 | 102 | 3.59% | 4.67% | 26.47% | -6.47% |
| Q5 | 102 | 6.80% | 6.52% | 6.86% | 2.07% |

### Agreement-confirmed

| Metric | Value |
|---|---:|
| overlapping Spearman IC / n | 0.2637 / 465 |
| non-overlapping Spearman IC / n | 0.2030 / 39 |
| moving-block bootstrap 95% CI | [0.0666, 0.4224] |
| bootstrap p(IC <= 0) | 0.0045 |
| positive folds | 3 / 6 |
| sign stability | 75.00% |

| Fold | Start | End exclusive | Prior prefix n | Evaluation n | IC |
|---:|---|---|---:|---:|---:|
| 1 | 2005-01-01 | 2009-01-01 | 0 | 0 | null |
| 2 | 2009-01-01 | 2013-01-01 | 0 | 0 | null |
| 3 | 2013-01-01 | 2017-01-01 | 0 | 22 | -0.3925 |
| 4 | 2017-01-01 | 2021-01-01 | 22 | 193 | 0.1991 |
| 5 | 2021-01-01 | 2024-01-01 | 215 | 150 | 0.4438 |
| 6 | 2024-01-01 | 2100-01-01 | 365 | 100 | 0.2348 |

| Score bucket | n | Mean return | Median return | P(return < 0) | 10% tail |
|---|---:|---:|---:|---:|---:|
| Q1 | 93 | 2.57% | 3.96% | 26.88% | -6.18% |
| Q2 | 93 | 2.17% | 3.33% | 30.11% | -5.83% |
| Q3 | 93 | 1.44% | 2.73% | 36.56% | -6.69% |
| Q4 | 93 | 4.06% | 5.57% | 25.81% | -6.67% |
| Q5 | 93 | 6.76% | 6.47% | 6.45% | 2.10% |

## Raw / Smooth agreement

| Metric | Value |
|---|---:|
| Comparable observations | 510 |
| HIGH agreement | 465 |
| LOW disagreement | 45 |
| Agreement rate | 91.18% |
| Disagreement mean forward return | 3.87% |
| Disagreement median forward return | 4.65% |
| Disagreement negative probability | 20.00% |

## Frozen decision interpretation

The preregistered gate uses the agreement-confirmed non-overlapping IC, positive-fold count, bootstrap p-value, independent count, and agreement rate. The observed conclusion is **INCONCLUSIVE** and the only allowed action selected by the gate is **DROP_RESEARCH**. `REPLACE_CHAMPION` is not an available outcome.

## Known limitations

- FRED CSV is a current-vintage snapshot; it does not reconstruct historically visible releases or revisions.
- FRED SP500 coverage is shorter than the balance-sheet series, so early fixed folds can be empty. They are reported and never redistributed.
- The nominal Thursday-release/Friday-tradable lag is conservative research timing, but does not repair vintage bias.
- SP500 is a price index without dividends. This is an IC study, not a tradable portfolio backtest or Sharpe comparison.
- Overlapping 13-week observations are dependent; the non-overlapping sample and moving-block bootstrap are the more conservative diagnostics.
- Raw/Smooth agreement is a preregistered direction filter, not a fitted confidence calibration.

## Production impact and rollback

No Champion score, weight, threshold, verdict, hysteresis, portfolio target, official snapshot, API, migration, or production database is changed. Rollback is a code/docs/artifact revert of the PR-11 commit range; 无需数据库回滚。
