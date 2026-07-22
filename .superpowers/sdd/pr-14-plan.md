# PR-14 Plan — Residual correctness and bounded retries

Base: `2eb70ce`

## Scope

- Add a shared, bounded exponential-backoff primitive with injectable random/sleep.
- Retry only transient transport failures, HTTP 429, and HTTP 5xx.
- Apply it to FRED/ALFRED requests and live market-provider HTTP requests.
- Preserve provider fallback, status semantics, scores, thresholds, and ingest atomicity while making every attempt independently timeout-bounded.
- Bound one concurrent live price/stress load with a shared atomic 32-attempt budget and release discarded response bodies.
- Classify eight scoring factors, compatible legacy zero-weight `vol`, and the independent live-risk overlay without changing historical research diagnostics.

## TDD sequence

- [x] Add failing retry-policy tests: delay sequence, cap, terminal error, and non-retryable 4xx.
- [x] Add failing FRED/ALFRED tests for transient recovery, exhaustion, and immediate 4xx failure.
- [x] Add failing provider tests showing transient retry precedes fallback while invalid payloads do not retry.
- [x] Add failing documentation/config contract tests forbidding “9 weighted factors”.
- [x] Add failing hard-timeout, shared-budget, body-lifecycle, method-guard, and caller-abort tests.
- [x] Implement the smallest shared policy and wire each caller without changing parsing or scoring.
- [x] Run focused tests, full Vitest, TypeScript, ESLint, correctness/no-lookahead/rebuild consistency, and diff check.

## Verification record

- RED: missing retry module; transient FRED/ALFRED/provider requests failed without recovery; legacy factor language failed the repository contract; a follow-up cap regression returned `[100, 100]` instead of `[25, 25]`.
- GREEN: focused retry/provider/worker/language/walk-forward tests passed `149/149`; full Vitest passed `55 files / 720 tests`.
- Static and correctness gates: TypeScript strict, ESLint, correctness, no-lookahead, rebuild consistency, and base diff checks passed.
- No scoring formula, weight, threshold, freshness, hysteresis, stress trigger, portfolio policy, migration, deployment, or remote database change.
- Status remains review-pending until independent rereview accepts the frozen candidate HEAD.

## Non-goals

- No formula, weight, freshness, 45/55 threshold, hysteresis, stress threshold, or portfolio-policy change.
- No new data source or remote call during tests.
- No push, deployment, remote D1/R2, secret, or real alert action.

## Rollback

Revert PR-14 commits after base `2eb70ce`. No migration or data rollback is required.
