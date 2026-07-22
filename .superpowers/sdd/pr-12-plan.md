# PR-12 Dynamic Reserve Adequacy Challenger Plan

Execution note: this file preserves the original pre-fetch plan. The canonical source contract was corrected before the valid report by amendments A-001 (`TGCRRATE` plus the NY Fed Repo results API) and A-002 (strict SRF launch boundary `2021-07-29`); see `docs/research/RESERVE_ADEQUACY_AMENDMENTS.md`. Those amendments did not change the frozen formula, weights, states, freshness, OOS gate, or replacement ineligibility.

Base: `ba74a6c`

Branch: `codex/pr-12-reserve-adequacy`

Scope: ALG-05 as an isolated shadow research package. Do not change the Champion reserve factor, score, weights, thresholds, hysteresis, portfolio policy, official snapshots, production API, or database schema.

## Evidence and source contract

- Freeze a canonical, content-addressed primary FRED current-vintage snapshot for WRESBAL, GDP, SOFR, IORB, EFFR, TGCR, SRFONTSYD, and SP500. Exact `id/cosd/coed` URLs, bytes/object agreement, schema, source, evidence class, series set, row/date ranges, and hashes are mandatory.
- Evidence is `RESEARCH_CURRENT_VINTAGE`, never ALFRED/PIT. `replacementEligible=false` is structurally fixed.
- Weekly decisions anchor on Friday and may only use observations dated on/before that Friday. GDP is current-vintage quarterly data and remains a revision-bias limitation; no publication-date claim is made.
- Each component reports its own as-of date, age, and status. Missing/stale required inputs produce `DATA_INCOMPLETE`; no zero substitution or indefinite forward fill.

## Frozen challenger formula

- Units:
  - reserve balances: `WRESBAL / 1000` = $B;
  - nominal GDP: FRED GDP = $B annualized;
  - reserve ratio: reserve balances / GDP × 100;
  - rate spreads: percentage-point rate minus IORB, reported in basis points;
  - SRF: `SRFONTSYD` = $B.
- Weekly features:
  - 30% relative reserves score: strictly-prior expanding percentile of reserve/GDP, higher is better;
  - 25% 13-week reserve-change score: strictly-prior expanding percentile, higher is better;
  - 25% SOFR−IORB stress score: equal average of reversed strictly-prior percentiles for the week's paired median and p95 spread, lower is better;
  - 20% auxiliary funding score: equal average of reversed strictly-prior percentiles for weekly median EFFR−IORB, median TGCR−IORB, and weekly maximum SRF usage, lower is better.
- Require at least 52 strictly-prior complete weekly observations before scoring. Percentile history never includes the current/future row. No weights or state cutoffs may change after fetch.
- Composite score = `0.30*relative + 0.25*change13 + 0.25*sofrIorb + 0.20*auxFunding`.
- States: `ABUNDANT >= 80`, `AMPLE >= 60`, `TRANSITION >= 40`, `SCARCE >= 20`, otherwise `STRESSED`.
- Same high reserve/change inputs with worse funding spreads must lower the score. A one-day quarter-end spike may affect only its own weekly aggregate and must not persist into a later fully normal week.

## Freshness contract

- WRESBAL: maximum 14 calendar days at the weekly anchor.
- GDP: maximum 120 calendar days from its observation date (a current-vintage research proxy, not release-aware PIT).
- SOFR/IORB, EFFR/IORB, TGCR/IORB: pair only identical dates inside the trailing seven calendar days; require at least three finite paired observations; maximum latest-pair age four days.
- SRF: use observations inside the trailing seven calendar days; require at least one finite observation; maximum latest age four days.
- Freshness is independent per component and included in every weekly output.

## OOS contract

- Pre-register positive direction and a 13-week forward SP500 target. Entry is the first SPX close on/after the next Monday following the Friday decision, with a seven-day maximum match gap; horizon end uses the first close on/after 91 calendar days, also capped at seven days.
- Report overlapping and interval-non-overlapping Spearman IC, seeded moving-block bootstrap, six fixed calendar folds, score/state counts, quintile mean/median/negative probability/10% tail, and monotonicity diagnostics.
- Fixed fold boundaries before fetch: 2018-01-01, 2020-01-01, 2022-01-01, 2023-01-01, 2024-01-01, 2025-01-01, 2100-01-01. Empty folds remain empty.
- Frozen gate: `KEEP_SHADOW` only if non-overlap IC > 0, at least four fixed folds positive, bootstrap p <= 0.10, non-overlap n >= 10, and top score quintile has no worse mean return or 10% tail than the bottom quintile. Otherwise `DROP_RESEARCH`.
- The only research decisions are `KEEP_SHADOW` and `DROP_RESEARCH`; neither can replace Champion under current-vintage evidence.

## TDD and execution

1. RED/GREEN pure tests for weekly alignment, units, same-date spread pairing, median/p95/max, freshness, missing/stale fail-close, high-reserve/worse-spread penalty, quarter-end non-persistence, ordering/duplicate/non-finite rejection.
2. RED/GREEN prior-only expanding percentile, 52-week minimum, prefix invariance, exact weights, state boundaries, and component provenance.
3. RED/GREEN next-Monday forward alignment, non-overlap, bootstrap, fixed folds, quintiles/tails, monotonic gate, and structural non-replacement.
4. Commit preregistration code/docs before fetch. Fetch the exact canonical FRED snapshot once, run the frozen report once, and never tune from results.
5. Publish JSON/Markdown report and update README, algorithm docs/mirror, CHANGELOG, upgrade plan, and PR report.
6. Fresh full tests, TypeScript, diff-check, migrations 0001-0009 twice, two independent read-only reviews, fix every Critical/Important, then local fast-forward only.

## Rollback

- Revert PR-12 commits after `ba74a6c`. This PR has no migration or production data write, so no database rollback is required.
