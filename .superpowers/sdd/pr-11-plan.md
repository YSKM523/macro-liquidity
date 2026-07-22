# PR-11 Continuous Net Liquidity Challenger Plan

Base: `f803705`

Branch: `codex/pr-11-continuous-net-liquidity`

Scope: ALG-01/02/03 as an isolated shadow research package. It must not change Champion scores, weights, verdict bands, hysteresis, portfolio targets, official snapshots, or production APIs.

## Evidence class and data contract

- Fetch a dated, immutable local research snapshot from primary FRED CSV endpoints for WALCL, WDTGAL, WTREGEN, RRPONTSYD, and SP500; record retrieval time, exact URLs/series, row/date ranges, and SHA-256.
- The snapshot is `RESEARCH_CURRENT_VINTAGE`, not ALFRED/PIT. It may support research mechanics and provisional OOS diagnostics but cannot satisfy the production replacement gate.
- Align weekly decisions to WALCL Wednesday observations and make them tradable on Friday, after the normal Thursday H.4.1 release. SPX forward returns start at the first close on/after that Friday. This conservative nominal lag does not repair current-vintage revision risk.
- Raw net liquidity in $B: `WALCL_Wed/1000 - WDTGAL_Wed/1000 - RRP_asOfWed`.
- Smooth net liquidity in $B: `WALCL_Wed/1000 - WTREGEN_weekAverage/1000 - SMA5(RRP observations asOfWed)`.
- Missing required components produce no point; never substitute zero.

## Challenger contract

- For both Raw and Smooth emit level, 1-week change, 4-week impulse, 13-week trend, percent gap to SMA13, acceleration (`impulse4 - prior impulse4`), normalized `gap13`, normalized `impulse4`, normalized `impulse13`, latent value, and 0-100 score.
- Use exactly `0.45*gap13 + 0.35*impulse4 + 0.20*impulse13`, then `100/(1+exp(-latent))`.
- Each denominator is median absolute deviation over at most 156 strictly prior weekly derived observations. Require 52 prior valid observations before emitting a normalized score; use no current/future value in the denominator. Zero/non-finite MAD produces no score rather than an arbitrary epsilon.
- Raw/Smooth direction is the sign of latent value with a small exact-zero FLAT state. Same non-flat direction is HIGH agreement; opposite direction is LOW; either missing/flat is TRANSITION.
- All calculations are chronological, pure, deterministic, and reject unsorted/duplicate/non-finite input.

## OOS report contract

- Evaluate 13-week forward SPX return from the nominally tradable Friday using no same-week pre-release close.
- Report Raw, Smooth, and agreement-confirmed score diagnostics:
  - overlapping Spearman IC and n;
  - non-overlapping Spearman IC and n;
  - seeded moving-block bootstrap CI/p-value;
  - six chronological expanding-evaluation folds with fixed formula and no fitted parameters;
  - positive-fold count and sign stability;
  - score quintile count/mean/median/negative probability/10% tail;
  - Raw/Smooth agreement rate and disagreement diagnostics.
- Pre-register the formula, direction, 13-week horizon, 156-week normalization cap, 52-week minimum, six folds, and decision rule before running the report.
- Decision is only `KEEP_SHADOW` or `DROP_RESEARCH`; never `REPLACE_CHAMPION`. Current-vintage evidence forces `replacementEligible=false` even if headline IC is positive.
- The report must state whether the provisional evidence improves, degrades, or is inconclusive, without tuning the formula after seeing results.

## TDD sequence

1. RED pure tests for Raw/Smooth construction, units, as-of/SMA5, missing values, ordering/duplicates, and Friday availability; GREEN research builder.
2. RED tests for prior-only rolling MAD, no-future prefix invariance, exact weights/sigmoid, dimensions, zero-MAD fail closed, and agreement; GREEN challenger signal engine.
3. RED tests for forward-return alignment, non-overlap, fixed seeded bootstrap, six folds, quintiles, and replacement gate; GREEN OOS evaluator/report model.
4. Add a fetch/snapshot script and deterministic runner. Fetch only primary public FRED data; commit the normalized research snapshot or a content-addressed artifact plus manifest so the report can be reproduced locally.
5. Generate the OOS report once without changing preregistered settings. Update README, algorithm docs/mirror, CHANGELOG, upgrade plan, and PR report.
6. Fresh full tests, TypeScript, diff-check, migrations 0001-0009 twice, independent task/spec review, independent whole-branch review, fix every Critical/Important, then local fast-forward only.

## Rollback

- Revert only PR-11 commits after `f803705`.
- No migration or production data write is allowed. Research artifacts and shadow modules are isolated; rollback requires no database action.
