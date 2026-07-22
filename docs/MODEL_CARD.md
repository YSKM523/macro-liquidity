# Champion Model Card

## Purpose

The Champion is a weak-signal US macro-liquidity and risk-regime dashboard for research and education. It ranks the environment for S&P 500 exposure; it is not a trade oracle or investment advice. The production identity is `champion-v1.0.0`, with the exact canonical configuration available at `GET /api/v1/model` and attached to every new snapshot.

## Exclusions

- No promise of alpha, direction accuracy, capital preservation, or suitability for an investor.
- No intraday execution model, derivatives sizing, leverage recommendation, tax model, or personalized portfolio advice.
- PR-11 continuous net liquidity and PR-12 dynamic reserve adequacy are not production inputs.
- Current-vintage challenger research is not treated as point-in-time evidence.

## Assets and horizon

The target asset is the S&P 500. The primary diagnostic horizon is 13 weeks. Official decisions are weekly; daily nowcasts are explicitly `PROVISIONAL`. Formal performance uses the append-only event-time daily engine and the earliest eligible following market close.

## Sources

FRED/ALFRED supplies macro series and immutable vintages. Yahoo, Stooq, and named FRED series supply live market readings with provenance, fallback, divergence, freshness, and fail-closed status. Their HTTP calls retry only transport failures, 429, and 5xx under a three-attempt capped exponential-backoff policy; other 4xx and parse/validation failures fail immediately. Exact series definitions and freshness rules are part of the canonical config hash.

## Eight scoring factors, Weights, and one independent live-risk overlay

| Factor | Weight |
|---|---:|
| Net-liquidity trend | 0.35 |
| Dollar | 0.18 |
| Yield curve | 0.15 |
| Reserve adequacy | 0.12 |
| Credit | 0.06 |
| Balance-sheet impulse | 0.05 |
| Rates | 0.05 |
| Funding | 0.04 |

The eight scoring-factor weights sum to 1.00. The persisted `vol` field is a FRED `VIXCLS`-based legacy zero-weight macro diagnostic (`LEGACY_ZERO_WEIGHT_DIAGNOSTIC`): it is neither a ninth scoring factor nor the live-risk overlay. The independent overlay separately consumes live multi-provider VIX, SPX, 10Y, and DXY inputs.

## Thresholds and policy

- Score above 55: bullish; below 45: bearish; 45–55 inherits the preceding valid verdict.
- Missing or stale required data produces `DATA_INCOMPLETE`; live-risk uncertainty produces `UNKNOWN` and cannot increase risk.
- Stress uses VIX 28, SPX five-day return −4%, 10Y five-day change +0.25 percentage points, or DXY five-day return +2%; score 65 is the existing stress ceiling exemption.
- Portfolio tiers remain `DASHBOARD_EXPOSURE_TIERS_V1`: 100/90/75/50/25% long/cash targets, with unknown capped at 75%.

## Evidence

The formal PR-10 event-time framework uses next-tradable execution, daily SPX, SOFR cash, explicit costs, and four fair benchmarks. Historical diagnostics show a useful but modest ranking signal, not reliable directional timing. PR-11 was `INCONCLUSIVE / DROP_RESEARCH`; PR-12 was `DROP_RESEARCH`. Neither met the frozen promotion gates.

PR-15 adds `PURGED_VALIDATION_V1` without altering the Champion. Thirteen-week labels expose signal/outcome dates, training labels are purged when their outcomes reach the next test interval, and a 91-calendar-day embargo is applied. Reports separate score direction, persisted formal verdict, existing dashboard target-exposure risk calls, Spearman IC, and fold-training-only q10 tail detection. The genuinely forward holdout is permanently registered from `2026-07-23`; it remains `PENDING_MATURITY` until enough post-registration labels mature and historical rows are never renamed as unseen holdout evidence.

## Failed regimes and monitoring

Known weak areas include market drift overwhelming direction accuracy, publication-calendar approximations, crisis source disruption, and limited non-overlapping samples. Health/SLO responses expose ingest and snapshot outcomes. Critical snapshot failure alerting is mandatory, but delivery depends on configured provider secrets and must be monitored through structured `alert_delivery` events and the audit table.

## Known limitations

- Release rules remain conservative approximations and do not encode every US market holiday.
- Live cache is per Worker isolate; it is an upstream-load guard, not a globally coherent quote store.
- Staging identifiers and remote secrets are intentionally not committed. A local dry-run is not evidence that staging or production deployment succeeded.
- Historical rows backfilled by migration 0010 are explicitly `LEGACY_UNVERSIONED`. Versioned APIs report the governed/legacy union without inventing identity. PR-15 retrospective validation labels this cohort `PARTIAL_LEGACY`; legacy q10 calibration remains null as `PARTIAL_LEGACY_CALIBRATION`, while malformed/non-PIT inputs and legacy post-holdout signals fail closed.
- The local restore fixture proves the mechanism and invariants, not restoration of a real production backup.

## Governance and promotion

A challenger must be preregistered, point-in-time, no-lookahead, positive in most fixed OOS folds, non-degraded on non-overlapping IC, and improve beta-matched risk/return or tails. It remains shadow-only until independent review and an explicit production decision.

## Rollback

Revert PR-13 application/config/docs commits to return to the prior API and operation behavior. Migration 0010 is additive: never drop its columns or audit tables on a remote database. Stop new writes or roll application behavior forward. Snapshot scores, formulas, weights, thresholds, hysteresis, and portfolio policy were not changed by PR-13.
