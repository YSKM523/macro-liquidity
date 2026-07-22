# PR-10 Portfolio Backtest Plan

Base: `f04d4b2`

Branch: `codex/pr-10-portfolio-backtest`

Scope: BT-03 dashboard-aligned long/cash exposure policy and BT-05 fair benchmarks/tail metrics. Champion scores, weights, 45/50/55 verdict bands, hysteresis, PIT visibility, execution timing, and cost assumptions are frozen.

## Policy contract

- Add one pure numeric mapper used by both live dashboard guidance and formal backtest signals.
- No leverage in this PR:
  - strong tailwind: 100%
  - ordinary tailwind: 90%
  - neutral: 75%
  - cautious: 50%
  - headwind: 25%
  - stress brake: 25% when the existing stress overlay applies
  - unknown: cap the otherwise applicable tier at 75%
- Preserve the existing stress exemption: `STRESSED` only applies the brake below the existing score ceiling of 65.
- Historical stress uses the PIT snapshot's frozen `vix_eod` as a deliberately narrow proxy (`PIT_SNAPSHOT_VIX_PROXY`): missing VIX is UNKNOWN, VIX >= 28 is STRESSED, otherwise NORMAL. Do not infer from daily revisions activated after the decision.
- Store no new mutable policy state. The formal loader derives `targetExposure`, tier, and methodology from immutable PIT signal fields (`score`, `verdict`, `netliq_dir`, `vix_eod`).

## Backtest contract

- The formal event-time strategy must use explicit dashboard-tier targets; the old score>55 compatibility fallback remains only for isolated scheduler compatibility tests and is not a formal API methodology.
- Keep next-session scheduling, strict as-of visibility, SOFR, financing, commission/slippage, and incomplete-data gates unchanged.
- Add a reusable daily NAV simulator and compare the strategy over the identical evaluation window against:
  - 100% SPX;
  - static SPX/cash with exposure equal to the strategy's average beta;
  - 10% annualized-volatility-target SPX using only prior returns, 20-session lookback, and a 100% cap;
  - SPX above its prior-close 200-session moving average, otherwise cash.
- Apply the same SOFR availability, cost, and VIX slippage rules to benchmark exposure changes. No benchmark may read current-day returns to set current exposure.
- Report total return, total-return timing alpha versus beta-matched static, average beta, annualized volatility, Sharpe, Sortino, maximum drawdown, and maximum drawdown duration in sessions. Return null metrics rather than invented values when history is insufficient.

## TDD sequence

1. RED policy tests for every tier, stress exemption/brake, and unknown cap; GREEN pure mapper; assert live guidance exposes the same policy.
2. RED DB/API tests requiring frozen verdict/net-liquidity/VIX signal fields and explicit formal target exposure; GREEN loader mapping without changing cutoff/provenance queries.
3. RED portfolio analytics tests for no-lookahead vol target/200DMA, beta matching, tail metrics, costs/cash, and insufficient history; GREEN reusable simulator/analytics.
4. RED worker/UI contract tests for named benchmarks, methodology disclosures, metrics, escaping, and DATA_INCOMPLETE behavior; GREEN API and presentation.
5. Update README, algorithm docs/mirror, CHANGELOG, upgrade checklist, and PR report.
6. Fresh full tests, TypeScript, diff check, local migrations 0001-0009 twice, task/spec review, whole-branch review, fix all Critical/Important findings, then local fast-forward only.

## Out of scope

- No score/weight/threshold/hysteresis tuning.
- No >100% target exposure.
- No total-return SPX reconstruction or dividend assumptions.
- No new challenger factors (PR-11/12).
- No deployment, push, staging/production access, or remote database changes.

## Rollback

- Revert only the PR-10 commit range back to base `f04d4b2`.
- No schema migration is planned; if implementation later proves one necessary, it must be additive, locally tested twice, and documented before review.
