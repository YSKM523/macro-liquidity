# PR-15 Plan — Purged validation and outcome taxonomy

Base: `780e125`

## Objective

Complete BT-06 and BT-07 without changing the Champion model: add date-based purged walk-forward validation, register a genuinely forward frozen holdout, and report direction, persisted-verdict, risk, IC, and tail-risk metrics with typed null semantics.

## Frozen protocol

- Protocol: `PURGED_VALIDATION_V1`.
- Horizon: 13 weeks; every forward label exposes its signal and outcome dates.
- Purge any training label whose outcome is on or after the next test start.
- Apply a 91-calendar-day pre-test embargo; never model embargo as row count.
- Report overlapping and greedily interval-non-overlapping test counts.
- Register the completely unseen holdout before its first eligible signal: `holdoutFrom=2026-07-23`.
- The holdout is append-only and never moves. Training weights, training q10 threshold, definitions, and protocol digest are frozen from pre-holdout rows only.
- Until enough post-registration labels mature, return `PENDING_MATURITY` and null metrics. Historical tail data must not be relabeled as unseen holdout.

## Metric taxonomy

- Direction: score above/below 50 versus positive/negative return; exact 50 or zero return abstains.
- Formal verdict: use the persisted snapshot verdict; `NEUTRAL` abstains. Never rederive hysteresis from an isolated score.
- Risk: use the existing persisted/derived dashboard portfolio target; `targetExposure <= 0.50` is a risk call. Report precision and downside recall.
- IC: Spearman score/return; fewer than 3 observations or zero variance returns typed null.
- Tail risk: fold-training-only q10 threshold; report recall and precision. Never calibrate on the test/holdout outcomes.
- Rates require at least 5 eligible observations; tail calibration requires 20 training outcomes and 3 test tail events. Undefined values are null, never zero/NaN.

## TDD sequence

1. RED: label interval/date-order validation and purge/embargo boundary tests, including irregular spacing.
2. RED: five hand-calculated metric/confusion-matrix tests and typed-null edge cases.
3. RED: fold tests proving an outcome cannot enter training before maturity and independent intervals do not overlap.
4. RED: frozen-holdout tests proving later outcomes cannot alter frozen weights/q10/from-date and immature holdout is pending.
5. RED: DB/worker/API/UI tests for persisted verdict, target exposure, additive validation schema, provenance, and null rendering.
6. Implement pure validation modules, then minimally wire legacy walk-forward/robustness/API/UI additively.
7. Run focused and full Vitest, TypeScript, ESLint, correctness, no-lookahead, rebuild consistency, migration verification, deploy dry-run, and diff check.

## Compatibility and non-goals

- Keep all legacy backtest/walk-forward/robustness fields and values.
- Do not change scores, weights, 45/55 bands, hysteresis, stress, portfolio targets, snapshots, or research conclusions.
- Do not claim the retrospective folds are a completely unseen holdout.
- No migration unless a write-time holdout registry proves necessary; prefer a frozen code protocol in this PR.
- No push, deployment, remote D1/R2, or real alert.

## Rollback

Revert PR-15 commits after base `780e125`. If no migration is added, no data rollback is needed.
