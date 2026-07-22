# Dynamic Reserve Adequacy Challenger — Preregistration

Status: `AMENDED_AFTER_REVIEW_BEFORE_CORRECTED_FETCH`

Methodology: `PR12_RESEARCH_V2_SRF_BOUNDARY`

Evidence: `RESEARCH_CURRENT_VINTAGE`

Production eligibility: `replacementEligible=false`

This document freezes PR-12 before any canonical data fetch. The package is shadow research only and cannot change the Champion, production API, snapshots, database schema, score, weights, thresholds, hysteresis, or portfolio policy.

## Exact data contract

Primary FRED CSV series are exactly `WRESBAL`, `GDP`, `SOFR`, `IORB`, `EFFR`, `TGCRRATE`, and `SP500`. Canonical URLs contain the exact `id`, `cosd=2002-01-01`, and frozen `coed`. Standing Repo Facility accepted amount comes only from the official NY Fed Markets endpoint `https://markets.newyorkfed.org/api/rp/results/search.json?startDate=2021-07-29&endDate=YYYY-MM-DD&operationTypes=Repo`. Each accepted record must expose `operationDate`, `operationType`, `term`, and `totalAmtAccepted`; the normalized daily value is the sum of `totalAmtAccepted` across all same-day `Overnight` Repo operations, in billions. The API documentation is `https://markets.newyorkfed.org/static/docs/markets-api.html`.

The canonical snapshot and manifest must agree byte-for-byte and object-for-object and record schema, source, evidence class, exact FRED IDs/URLs, exact NY Fed endpoint/parameters, retrieval time, row/date ranges, per-source hashes, and whole-file SHA-256. No unavailable identifier or endpoint may be silently replaced.

This is current-vintage FRED evidence, not ALFRED/PIT. GDP is quarterly current-vintage data; this study makes no historical release-date or historical-vintage claim.

## A-001 primary-source correction (before full fetch)

After commit `7f64d10`, a three-day HTTP/schema probe returned valid canonical CSV headers for `WRESBAL`, `GDP`, `SOFR`, `IORB`, `EFFR`, and `SP500`, but FRED returned HTTP 404 for the preregistered `TGCR` and `SRFONTSYD` identifiers. No full snapshot or report had been generated. Primary-source verification established `TGCRRATE` as the FRED series and the official NY Fed Markets Repo results API as the SRF accepted-amount source. This correction is provenance repair, not result-driven tuning: formula, weights, state thresholds, freshness, folds, bootstrap, OOS gate, allowed decisions, and `replacementEligible=false` are unchanged.

## A-002 post-fetch correctness amendment

Review of v1 showed that the Repo endpoint contains temporary Repo operations before the Standing Repo Facility existed. Snapshot `reserve-current-vintage-2026-07-22-v1` at commit `af45724` and its accidental local report are `INVALIDATED_BY_REVIEW`. Canonical v2 starts the NY Fed request exactly at the official SRF launch, `2021-07-29`, and rejects any earlier returned row. Small-value exercises remain included because the official results include them and the API has no unambiguous exercise flag; this may overstate market-driven demand. The corrective v2 fetch/report repairs chronology and does not tune formula, weights, states, freshness, target, folds, bootstrap, gate, decisions, or eligibility.

## Frozen weekly formula

Friday anchors use only observations dated on or before Friday. `WRESBAL / 1000` converts millions to billions; FRED GDP is billions annualized; reserve ratio is reserves/GDP × 100. Rate spread basis points are `(rate − IORB) × 100`; NY Fed accepted amounts are converted from dollars to billions.

- 30%: strictly-prior expanding percentile of relative reserves, higher is better.
- 25%: strictly-prior expanding percentile of 13-week reserve change, higher is better.
- 25%: average of reversed strictly-prior percentiles for weekly paired same-date SOFR−IORB median and p95, lower is better.
- 20%: average of reversed strictly-prior percentiles for weekly same-date EFFR−IORB median, TGCR−IORB median, and maximum SRF usage, lower is better.

At least 52 strictly-prior complete weeks are required. Composite is `0.30·relative + 0.25·change13 + 0.25·sofrIorb + 0.20·auxFunding`. States are ABUNDANT ≥80, AMPLE ≥60, TRANSITION ≥40, SCARCE ≥20, otherwise STRESSED. No formula, weight, percentile direction, state boundary, or gate may be tuned after fetch.

## Freshness and failure contract

WRESBAL may be at most 14 calendar days old; GDP at most 120. Rate components use identical-date pairs in the trailing seven calendar days, require at least three finite pairs, and require the latest pair to be at most four days old. SRF uses at least one trailing-seven-day observation and its latest age may be at most four days. Every component reports its own observation date(s), age, and status. Missing or stale required data yields `DATA_INCOMPLETE`; there is no zero substitution or indefinite forward fill.

## Frozen OOS contract

The positive-direction target starts at the first SP500 close on/after the next Monday following the Friday decision and ends at the first close on/after 91 calendar days. Either match may be at most seven days late. Report overlapping and interval-non-overlapping Spearman IC, seeded moving-block bootstrap (`seed=12012`, block 13, 2,000 iterations), state/score counts, score-quintile mean/median/negative probability/10% tail, monotonicity diagnostics, and six fixed folds bounded by 2018-01-01, 2020-01-01, 2022-01-01, 2023-01-01, 2024-01-01, 2025-01-01, and 2100-01-01. Empty folds remain empty.

`KEEP_SHADOW` requires non-overlap IC > 0, at least four positive fixed folds, bootstrap p ≤ 0.10, non-overlap n ≥ 10, and top score quintile no worse than bottom on both mean return and 10% tail. Otherwise the decision is `DROP_RESEARCH`. Neither decision can replace the Champion.
