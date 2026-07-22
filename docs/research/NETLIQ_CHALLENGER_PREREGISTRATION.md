# Continuous Net Liquidity Challenger — Preregistration

Status: `PREREGISTERED_BEFORE_FETCH`  
Evidence class: `RESEARCH_CURRENT_VINTAGE`  
Production status: shadow research only  
Replacement eligibility: `false`

This contract was committed before the PR-11 FRED snapshot was fetched. After the fetch, the formula, direction, windows, folds, bootstrap, and decision gate must not be changed in response to results.

## Data and timing

Primary FRED CSV series: `WALCL`, `WDTGAL`, `WTREGEN`, `RRPONTSYD`, and `SP500`. The committed artifact is a dated current-vintage snapshot, not ALFRED/PIT history. It cannot prove what values were visible in the past and therefore cannot qualify a production replacement.

Weekly observations anchor on each WALCL Wednesday. A signal is nominally available on Friday, after the normal Thursday H.4.1 publication. The 13-week SPX target starts at the first SPX close on or after that Friday and ends at the first close on or after 91 calendar days. A pre-Friday close is never used.

All source series must be strictly increasing by date, duplicate-free, and finite. A required missing component removes that weekly point; zero is never imputed.

## Frozen formulas

All monetary outputs are billions of dollars.

```text
Raw = WALCL_Wed / 1000 - WDTGAL_asOfWed / 1000 - RRP_asOfWed

Smooth = WALCL_Wed / 1000
       - mean(WTREGEN observations in the 7 calendar days ending Wed) / 1000
       - mean(last 5 RRP observations visible by Wed)
```

Each track emits level, 1-week change, 4-week impulse, 13-week trend, percent gap to the 13-week SMA, and acceleration. Normalized features are:

```text
gap13     = (level - SMA13) / priorRollingMAD(level - SMA13)
impulse4  = delta4(level)    / priorRollingMAD(delta4(level))
impulse13 = delta13(level)   / priorRollingMAD(delta13(level))

latent = 0.45 * gap13 + 0.35 * impulse4 + 0.20 * impulse13
score  = 100 / (1 + exp(-latent))
```

Every MAD window contains at most 156 strictly prior weekly derived values and requires at least 52 prior valid values. The current row and all future rows are excluded. Zero or non-finite MAD produces no score; no epsilon is substituted.

Raw and Smooth with the same non-flat latent sign are `HIGH` agreement. Opposite signs are `LOW`; a missing or exactly flat track is `TRANSITION`.

## Frozen OOS design

- Hypothesized direction: positive score/forward-return association.
- Horizon: 13 weeks.
- Report Raw, Smooth, and the mean score of `HIGH`-agreement rows.
- Report overlapping Spearman IC and interval-non-overlapping IC separately. Non-overlap greedily accepts the next pair only when its tradable start is at or after the prior selected pair's horizon end.
- Moving-block bootstrap: circular blocks of 13 observations, 2,000 iterations, LCG seed `11011`; report percentile 95% CI and one-sided `p(IC <= 0)`.
- Score quintiles: five equal-count rank buckets, reporting count, mean, median, negative probability, and 10% lower tail.
- Agreement diagnostics: comparable count, agreement/disagreement counts and rate; disagreement forward mean, median, and negative probability.

The six chronological evaluation folds are fixed before fetch:

| Fold | Start (inclusive) | End (exclusive) |
|---:|---|---|
| 1 | 2005-01-01 | 2009-01-01 |
| 2 | 2009-01-01 | 2013-01-01 |
| 3 | 2013-01-01 | 2017-01-01 |
| 4 | 2017-01-01 | 2021-01-01 |
| 5 | 2021-01-01 | 2024-01-01 |
| 6 | 2024-01-01 | 2100-01-01 |

These broad calendar eras were selected before observing the PR-11 snapshot or results. Each fold reports its fixed-formula evaluation IC and the size of the chronological prefix available before the fold. No parameter is fitted. An empty/short fold is reported as such and is never dynamically redistributed.

## Frozen conclusion and decision rule

The agreement-confirmed diagnostics are the gate series:

- `IMPROVES` when non-overlapping IC is positive and at least 4 of 6 finite fold ICs are positive.
- `DEGRADES` when non-overlapping IC is negative and at most 2 finite fold ICs are positive.
- otherwise `INCONCLUSIVE`.
- `KEEP_SHADOW` only if the conclusion is `IMPROVES`, non-overlapping `n >= 10`, bootstrap `p <= 0.10`, and agreement rate `>= 0.50`.
- otherwise `DROP_RESEARCH`.

The only permitted decisions are `KEEP_SHADOW` and `DROP_RESEARCH`; `REPLACE_CHAMPION` is not representable. `replacementEligible` remains `false` regardless of the empirical result because the evidence is current-vintage research.
