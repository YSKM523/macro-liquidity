# Dynamic Reserve Adequacy Challenger — OOS Research Report

> Generated once from the frozen PR-12 canonical artifact and unchanged preregistered formula/gate. This is isolated shadow research; Champion: unchanged.

## Evidence and decision

- Methodology: `PR12_RESEARCH_V2_SRF_BOUNDARY`
- Evidence: `RESEARCH_CURRENT_VINTAGE` — current-vintage research, not ALFRED/PIT
- Snapshot: `reserve-current-vintage-2026-07-22-v2`
- Snapshot SHA-256: `0a7f47c7599994dc4271c94bfc1faa5aa065472e1db2de790985c7788394da65`
- Retrieved at: `2026-07-22T16:19:04.345Z`
- replacementEligible: `false`
- Research decision: `DROP_RESEARCH`
- Champion: unchanged

FRED GDP is current-vintage quarterly data and is aligned only by observation date; no historical publication-date claim is made. Historical revisions remain a material limitation.

## A-001 source correction

The preregistered nonexistent FRED IDs returned 404 before full fetch. A-001 replaced them with exact FRED `TGCRRATE` and the official NY Fed Markets Repo API. The NY Fed daily SRF proxy sums `totalAmtAccepted` for same-day `Repo` / `Overnight` operations into billions. Formula, 0.30/0.25/0.25/0.20 weights, states, freshness, OOS target, gate, and eligibility did not change.

## A-002 SRF launch boundary correction

Independent review invalidated v1 because the Repo endpoint also contains temporary repo operations before the Standing Repo Facility. Canonical v2 requests NY Fed data from exactly **2021-07-29**, rejects earlier returned rows, and never uses v1 results. NY Fed small-value exercises remain included because the operation results API exposes no unambiguous exercise flag; they can overstate market-driven SRF take-up. This corrective run did not change the formula, weights, states, freshness, OOS target, gate, or eligibility.

## Sample and freshness

| Metric | Value |
|---|---:|
| Weekly Friday anchors | 1231 |
| Complete features | 248 |
| DATA_INCOMPLETE features | 983 |
| Scored after 52 prior complete weeks | 196 |
| Range | 2002-12-20 to 2026-07-17 |

Each weekly component carries independent as-of dates, ages, pair counts, and status. Missing/stale WRESBAL, GDP, same-date rate pairs, or NY Fed SRF results fail closed as `DATA_INCOMPLETE`; values are never replaced with zero or indefinitely forward-filled.

| State | Count |
|---|---:|
| TRANSITION | 58 |
| SCARCE | 94 |
| STRESSED | 44 |

## Frozen OOS diagnostics

| Metric | Value |
|---|---:|
| overlapping Spearman IC / n | 0.2363 / 194 |
| interval-non-overlapping Spearman IC / n | -0.0071 / 15 |
| moving-block bootstrap 95% CI | [-0.0492, 0.4805] |
| bootstrap p(IC <= 0) | 0.0515 |
| positive fixed folds | 3 / 6 |
| adjacent mean violations | 1 |
| top mean no worse than bottom | true |
| top 10% tail no worse than bottom | false |

| Fold | Start | End exclusive | Mature prior n | Evaluation n | IC |
|---:|---|---|---:|---:|---:|
| 1 | 2018-01-01 | 2020-01-01 | 0 | 0 | null |
| 2 | 2020-01-01 | 2022-01-01 | 0 | 0 | null |
| 3 | 2022-01-01 | 2023-01-01 | 0 | 22 | -0.3326 |
| 4 | 2023-01-01 | 2024-01-01 | 8 | 52 | 0.3294 |
| 5 | 2024-01-01 | 2025-01-01 | 60 | 52 | 0.2529 |
| 6 | 2025-01-01 | 2100-01-01 | 113 | 68 | 0.4439 |

| Score quintile | n | Mean | Median | P(return < 0) | 10% tail |
|---|---:|---:|---:|---:|---:|
| Q1 | 38 | 2.24% | 2.45% | 23.68% | -3.83% |
| Q2 | 39 | 3.72% | 4.70% | 25.64% | -4.00% |
| Q3 | 39 | 5.05% | 5.61% | 15.38% | -1.50% |
| Q4 | 39 | 7.52% | 7.12% | 7.69% | 0.41% |
| Q5 | 39 | 4.29% | 4.77% | 20.51% | -5.11% |

The frozen gate selected **DROP_RESEARCH**. The only possible outcomes are KEEP_SHADOW and DROP_RESEARCH; neither permits Champion replacement.

## Limitations and rollback

- Current-vintage FRED and NY Fed artifacts do not reconstruct historical vintages or historical availability.
- SP500 is a price index without dividends; this is an IC/state-ranking study, not a tradable portfolio backtest.
- Overlapping 13-week targets are dependent; interval-non-overlap and the seeded block bootstrap are the conservative diagnostics.
- A daily SRF accepted amount measures operation take-up, not every dimension of reserve scarcity.

No production source, API, official snapshot, Champion score, weight, threshold, hysteresis, portfolio policy, migration, or database is changed. Roll back the PR-12 code/docs/artifact commit range; no database rollback is required.
