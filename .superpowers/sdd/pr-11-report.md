# PR-11 Continuous Net Liquidity Challenger Report

Base: `f803705`

Branch: `codex/pr-11-continuous-net-liquidity`

Implementation and review-correction commits: `276eeb5..29c0094` (whole reviewed diff: `f803705..29c0094`).

## Outcome

- Added an isolated, deterministic shadow research package for ALG-01/02/03. No `src/` production path, Worker route, official snapshot, Champion score, weight, threshold, verdict, hysteresis, or portfolio policy changed.
- Raw uses exact Wednesday `WALCL/1000 - WDTGAL/1000 - RRP as-of`; Smooth uses `WALCL/1000 - WTREGEN week-average/1000 - SMA5(RRP as-of)`. Required gaps omit the weekly point; no zero or stale-week WDTGAL substitution exists.
- Both tracks emit level, 1w change, 4w impulse, 13w trend, percent gap to SMA13, acceleration, normalized gap/impulse dimensions, latent, score, and direction.
- Normalization uses a maximum 156-week MAD of strictly prior derived observations, requires 52 prior valid observations, and fails closed on zero/non-finite MAD. The frozen latent is `0.45*gap13 + 0.35*impulse4 + 0.20*impulse13`; the score is logistic 0–100.
- Same non-flat Raw/Smooth direction is HIGH agreement, opposite direction LOW, and flat/missing TRANSITION.
- Effective conservative availability is `Wed+7` after WALCL Wednesday. The 13-week target begins at the first SPX close within seven calendar days and ends at the first close within seven days after 91 calendar days. This review correctness amendment prevents pre-release holiday-Friday execution; long missing-price gaps are rejected.
- OOS diagnostics include overlapping and interval-non-overlapping Spearman IC, seeded 13-observation moving-block bootstrap, six fixed calendar folds, positive-fold count/sign stability, score quintiles, agreement rate, and disagreement returns.

## Preregistration and frozen data

- `scripts/netliq-preregistration.mjs` and `docs/research/NETLIQ_CHALLENGER_PREREGISTRATION.md` were committed at `0b120a4` before fetch. The formula, direction, horizon, normalization, six ISO fold ranges, bootstrap seed/length/iterations, and decision gate were never changed after observing data.
- Only primary `https://fred.stlouisfed.org/graph/fredgraph.csv` URLs were fetched for WALCL, WDTGAL, WTREGEN, RRPONTSYD, and SP500.
- The initial report is `INVALIDATED_BY_REVIEW`. Its seven-day SPX match cap is disclosed as `POST_FETCH_DATA_HYGIENE`, added after data fetch and before the initial formal report.
- Corrected snapshot `netliq-current-vintage-2026-07-22-corrected-v2` is canonical schema-v2 `RESEARCH_CURRENT_VINTAGE`, strictly bound to exact id/cosd/coed URLs. Snapshot SHA-256: `e535e6cd7cd3e08795e22687cc97a82674cc0207c8b966bac8472e59d6680254`.
- WALCL/WDTGAL/WTREGEN: 1,231 rows each, 2002-12-18 through 2026-07-15. RRPONTSYD: 3,287 rows, 2003-02-07 through 2026-07-21. SP500: 2,512 rows, 2016-07-22 through 2026-07-21.
- The invalidated initial output is retained only under `*_INITIAL_INVALIDATED.*`. After review fixes and focused tests, the corrected schema-v2 report was generated exactly once with immutable `wx` output files. Formula, weights, MAD, folds, horizon, bootstrap, and gate were not tuned.

## Empirical result

| Track | Overlap IC / n | Non-overlap IC / n | Bootstrap 95% CI / p | Positive fixed folds |
|---|---:|---:|---:|---:|
| Raw | 0.2655 / 509 | 0.2201 / 40 | [0.0826, 0.4165] / 0.0025 | 3 |
| Smooth | 0.2846 / 509 | 0.3229 / 40 | [0.0968, 0.4298] / 0.0015 | 3 |
| Agreement-confirmed | 0.2959 / 465 | 0.1559 / 39 | [0.1019, 0.4455] / 0.0015 | 3 |

- Agreement rate: 91.36% (465/509); disagreements: 44.
- The first two fixed folds are empty because FRED SP500 begins in 2016. The evaluable tail of the 2013–2016 fold is negative; the next three folds are positive. Empty folds were reported and never redistributed.
- The preregistered rule requires at least 4 positive folds. Actual conclusion: `INCONCLUSIVE`; actual decision: `DROP_RESEARCH`; `replacementEligible=false`.
- Positive current-vintage headline IC is provisional research evidence only. It is not production PIT/OOS proof and does not satisfy the Champion replacement gate.

## TDD evidence

- Stage 1 RED: builder module absent. GREEN: unit conversion, timing, as-of/week-average/SMA5, missing-data and input validation tests passed. Review RED additionally reproduced pre-release selections for 2016-11-23 and 2024-11-27; GREEN uses Wed+7.
- Stage 2 RED: signal functions absent. GREEN: dimensions, strict prior-only MAD, exact weights/sigmoid, prefix invariance, zero-MAD failure, and agreement tests passed.
- Stage 3 RED: OOS module absent; then full evaluator absent; dynamic sample-length fold boundaries violated fixed ISO boundaries; prior-week WDTGAL was incorrectly forward-filled; long SPX gaps were bridged. Each was reproduced before its fix. GREEN: all focused OOS/preregistration tests passed.
- Data/report RED: snapshot parser/hash module, FRED allowlist URL, deterministic runner, renderer, and documentation contracts were each absent before implementation. GREEN focused results are recorded in test output.

## Verification and review

- Fresh `env -u NODE_OPTIONS npm test -- --reporter=basic`: **40/40 files, 604/604 tests, exit 0**.
- Fresh `env -u NODE_OPTIONS npx tsc --noEmit`: **exit 0** after applying the repository's existing Node research-test import shim pattern.
- `git diff --check f803705..HEAD`: **exit 0** after removing Markdown hard-break trailing spaces; clean status is checked after the final metadata commit.
- Fresh local migrations in `/tmp/pr11-migrations.2DwRaa`: 0001–0009 applied successfully; immediate second invocation returned **No migrations to apply!**. PR-11 adds no migration.
- Independent review found holiday timing, fold train-count, artifact trust-boundary, and amendment-disclosure defects. Each was reproduced by failing tests before correction. Task/spec and whole-branch rereviews of `f803705..29c0094` both returned **Ready**, with 0 Critical / 0 Important / 0 Minor; both independently recomputed the active JSON and Markdown byte-for-byte.

## Known limitations

- The artifact is FRED current-vintage, not ALFRED/PIT. It cannot establish what values were visible historically, and revisions can bias diagnostics.
- FRED SP500 begins in 2016 and is a price index without dividends; two fixed folds are empty, and the study is IC/ranking research rather than a tradable portfolio comparison.
- The `Wed+7` bound is conservative across tested holiday releases but cannot repair current-vintage revision bias or model an exact historical release calendar.
- Six fixed folds contain only four finite ICs with available SP500 data. The negative 2016 tail and three later positive folds are descriptive, not a production validation set.
- No purged walk-forward portfolio, multiple-testing correction, cost sensitivity, PIT holdout, or stress-event library was added in this PR.
- Snapshot/manifest hashes detect independent corruption but are not signed. A coordinated replacement of both artifacts and every hash relies on the Git object database/commit as the external integrity anchor.

## Production impact and rollback

- No migration, deploy, push, staging/production access, remote D1 access, or database mutation was performed.
- Revert only the PR-11 commits after base `f803705`. The committed snapshot/report/docs/scripts are isolated; database rollback is unnecessary.
