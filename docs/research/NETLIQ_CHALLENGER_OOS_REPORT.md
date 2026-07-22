# Continuous Net Liquidity Challenger — Corrected OOS Research Report

> This corrected report was generated once from the canonical schema-v2 snapshot after independent review amendments. The formula, 0.45/0.35/0.20 weights, prior-only MAD, fixed folds, target horizon, bootstrap, and decision gate were not tuned. Timing and artifact provenance were corrected and are disclosed below; the initial report is `INVALIDATED_BY_REVIEW`.

## Status and evidence

- Evidence class: `RESEARCH_CURRENT_VINTAGE`
- Methodology version: `PR11_RESEARCH_V2_REVIEW_AMENDED`
- Contract status: `AMENDED_AFTER_REVIEW`
- Snapshot schema: `2`
- Snapshot: `netliq-current-vintage-2026-07-22-corrected-v2`
- Snapshot SHA-256: `e535e6cd7cd3e08795e22687cc97a82674cc0207c8b966bac8472e59d6680254`
- Retrieved at: `2026-07-22T15:35:56.987Z`
- replacementEligible: `false`
- Evidence conclusion: `INCONCLUSIVE`
- Research decision: `DROP_RESEARCH`
- Production Champion: unchanged

This is current-vintage FRED research, not ALFRED/PIT evidence. Historical revisions may be present. Therefore even favorable diagnostics cannot replace the Champion in this PR.

## Amendment disclosure

| ID | Kind | Implementation commit | Change |
|---|---|---|---|
| A-001 | REVIEW_CORRECTNESS | 30f2ef9 | Availability bound changed from observation Wednesday +2 to +7 calendar days. |
| A-002 | POST_FETCH_DATA_HYGIENE | 47e2358 | Reject SPX start/end matches more than 7 calendar days beyond their requested bound. |
| A-003 | REVIEW_TRUST_BOUNDARY | 0fff138 | Canonical schema-v2 snapshot/manifest validation and exact id/cosd/coed URL binding. |

- A-001 is a review-triggered correctness amendment: the conservative availability bound is now **Wed+7** calendar days before selecting the first eligible SPX close.
- A-002 is `POST_FETCH_DATA_HYGIENE`: the seven-day SPX start/end gap cap was added after the initial data fetch but before the initial formal report; it was not preregistered.
- A-003 is the review-triggered schema-v2 trust boundary and exact id/cosd/coed provenance validation.
- The initial JSON/Markdown remain audit-only under `*_INITIAL_INVALIDATED.*`; this corrected output is the canonical PR-11 report.

## Sample

| Item | Value |
|---|---:|
| Weekly Raw/Smooth points | 1205 |
| Weekly range | 2003-06-18 to 2026-07-15 |
| Raw scored | 1140 |
| Smooth scored | 1140 |
| HIGH agreement | 1058 |
| LOW agreement | 82 |

SPX current-vintage coverage determines the evaluable target window. Signals use WALCL Wednesday data, reach the conservative availability bound seven calendar days later, and start at the first SPX close within seven calendar days after that bound; the target ends at the first close within seven days after 91 calendar days. Long missing-price gaps are never bridged.

## OOS diagnostics

### Raw

| Metric | Value |
|---|---:|
| overlapping Spearman IC / n | 0.2655 / 509 |
| non-overlapping Spearman IC / n | 0.2201 / 40 |
| moving-block bootstrap 95% CI | [0.0826, 0.4165] |
| bootstrap p(IC <= 0) | 0.0025 |
| positive folds | 3 / 6 |
| sign stability | 75.00% |

| Fold | Start | End exclusive | Prior prefix n | Evaluation n | IC |
|---:|---|---|---:|---:|---:|
| 1 | 2005-01-01 | 2009-01-01 | 0 | 0 | null |
| 2 | 2009-01-01 | 2013-01-01 | 0 | 0 | null |
| 3 | 2013-01-01 | 2017-01-01 | 0 | 24 | -0.4026 |
| 4 | 2017-01-01 | 2021-01-01 | 11 | 209 | 0.2095 |
| 5 | 2021-01-01 | 2024-01-01 | 220 | 156 | 0.4158 |
| 6 | 2024-01-01 | 2100-01-01 | 376 | 120 | 0.2227 |

| Score bucket | n | Mean return | Median return | P(return < 0) | 10% tail |
|---|---:|---:|---:|---:|---:|
| Q1 | 101 | 2.41% | 2.78% | 25.74% | -5.84% |
| Q2 | 102 | 2.58% | 3.69% | 29.41% | -5.90% |
| Q3 | 102 | 2.70% | 3.69% | 24.51% | -4.90% |
| Q4 | 102 | 2.97% | 3.97% | 29.41% | -7.46% |
| Q5 | 102 | 6.49% | 6.65% | 8.82% | 0.57% |

### Smooth

| Metric | Value |
|---|---:|
| overlapping Spearman IC / n | 0.2846 / 509 |
| non-overlapping Spearman IC / n | 0.3229 / 40 |
| moving-block bootstrap 95% CI | [0.0968, 0.4298] |
| bootstrap p(IC <= 0) | 0.0015 |
| positive folds | 3 / 6 |
| sign stability | 75.00% |

| Fold | Start | End exclusive | Prior prefix n | Evaluation n | IC |
|---:|---|---|---:|---:|---:|
| 1 | 2005-01-01 | 2009-01-01 | 0 | 0 | null |
| 2 | 2009-01-01 | 2013-01-01 | 0 | 0 | null |
| 3 | 2013-01-01 | 2017-01-01 | 0 | 24 | -0.4078 |
| 4 | 2017-01-01 | 2021-01-01 | 11 | 209 | 0.2479 |
| 5 | 2021-01-01 | 2024-01-01 | 220 | 156 | 0.4089 |
| 6 | 2024-01-01 | 2100-01-01 | 376 | 120 | 0.2627 |

| Score bucket | n | Mean return | Median return | P(return < 0) | 10% tail |
|---|---:|---:|---:|---:|---:|
| Q1 | 101 | 2.37% | 3.06% | 25.74% | -5.50% |
| Q2 | 102 | 2.02% | 3.11% | 35.29% | -6.61% |
| Q3 | 102 | 2.64% | 3.71% | 25.49% | -6.48% |
| Q4 | 102 | 3.20% | 4.09% | 23.53% | -7.46% |
| Q5 | 102 | 6.93% | 6.83% | 7.84% | 1.80% |

### Agreement-confirmed

| Metric | Value |
|---|---:|
| overlapping Spearman IC / n | 0.2959 / 465 |
| non-overlapping Spearman IC / n | 0.1559 / 39 |
| moving-block bootstrap 95% CI | [0.1019, 0.4455] |
| bootstrap p(IC <= 0) | 0.0015 |
| positive folds | 3 / 6 |
| sign stability | 75.00% |

| Fold | Start | End exclusive | Prior prefix n | Evaluation n | IC |
|---:|---|---|---:|---:|---:|
| 1 | 2005-01-01 | 2009-01-01 | 0 | 0 | null |
| 2 | 2009-01-01 | 2013-01-01 | 0 | 0 | null |
| 3 | 2013-01-01 | 2017-01-01 | 0 | 21 | -0.4571 |
| 4 | 2017-01-01 | 2021-01-01 | 10 | 194 | 0.2311 |
| 5 | 2021-01-01 | 2024-01-01 | 203 | 149 | 0.4434 |
| 6 | 2024-01-01 | 2100-01-01 | 352 | 101 | 0.3042 |

| Score bucket | n | Mean return | Median return | P(return < 0) | 10% tail |
|---|---:|---:|---:|---:|---:|
| Q1 | 93 | 2.35% | 2.78% | 26.88% | -5.61% |
| Q2 | 93 | 2.18% | 3.15% | 31.18% | -6.05% |
| Q3 | 93 | 1.76% | 2.90% | 29.03% | -6.92% |
| Q4 | 93 | 3.90% | 5.35% | 23.66% | -7.45% |
| Q5 | 93 | 6.90% | 6.65% | 6.45% | 1.85% |

## Raw / Smooth agreement

| Metric | Value |
|---|---:|
| Comparable observations | 509 |
| HIGH agreement | 465 |
| LOW disagreement | 44 |
| Agreement rate | 91.36% |
| Disagreement mean forward return | 3.60% |
| Disagreement median forward return | 3.87% |
| Disagreement negative probability | 25.00% |

## Unchanged decision-gate interpretation

The original unchanged gate uses the agreement-confirmed non-overlapping IC, positive-fold count, bootstrap p-value, independent count, and agreement rate. The corrected observed conclusion is **INCONCLUSIVE** and the only allowed action selected by the gate is **DROP_RESEARCH**. `REPLACE_CHAMPION` is not an available outcome.

## Known limitations

- FRED CSV is a current-vintage snapshot; it does not reconstruct historically visible releases or revisions.
- FRED SP500 coverage is shorter than the balance-sheet series, so early fixed folds can be empty. They are reported and never redistributed.
- The review-amended Wed+7 bound is deliberately conservative and avoids the demonstrated holiday-release error, but it is not a historical release calendar and does not repair vintage bias.
- SP500 is a price index without dividends. This is an IC study, not a tradable portfolio backtest or Sharpe comparison.
- Overlapping 13-week observations are dependent; the non-overlapping sample and moving-block bootstrap are the more conservative diagnostics.
- Raw/Smooth agreement is a preregistered direction filter, not a fitted confidence calibration.

## Production impact and rollback

No Champion score, weight, threshold, verdict, hysteresis, portfolio target, official snapshot, API, migration, or production database is changed. Rollback is a code/docs/artifact revert of the PR-11 commit range; 无需数据库回滚。
