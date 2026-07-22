# PR-14 Plan — Residual correctness and bounded retries

Base: `2eb70ce`

## Scope

- Add a shared, bounded exponential-backoff primitive with injectable clock/sleep.
- Retry only transient transport failures, HTTP 429, and HTTP 5xx.
- Apply it to FRED/ALFRED requests and live market-provider HTTP requests.
- Preserve provider fallback, timeouts, status semantics, scores, thresholds, and ingest atomicity.
- Replace every user-facing “9 weighted factors” statement with “8 scoring factors + 1 independent live-risk overlay”.

## TDD sequence

1. Add failing retry-policy tests: delay sequence, cap, terminal error, and non-retryable 4xx.
2. Add failing FRED/ALFRED tests for transient recovery, exhaustion, and immediate 4xx failure.
3. Add failing provider tests showing transient retry precedes fallback while invalid payloads do not retry.
4. Add failing documentation/config contract tests forbidding “9 weighted factors”.
5. Implement the smallest shared policy and wire each caller without changing parsing or scoring.
6. Run focused tests, full Vitest, TypeScript, ESLint, correctness/no-lookahead/rebuild consistency, and diff check.

## Non-goals

- No formula, weight, freshness, 45/55 threshold, hysteresis, stress threshold, or portfolio-policy change.
- No new data source or remote call during tests.
- No push, deployment, remote D1/R2, secret, or real alert action.

## Rollback

Revert PR-14 commits after base `2eb70ce`. No migration or data rollback is required.
