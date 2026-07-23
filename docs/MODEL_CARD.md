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

PR-15 adds `PURGED_VALIDATION_V1` without altering the Champion. Formal thirteen-week labels enter at the first eligible PIT daily close after `tradableAt` and exit at the first actual PIT daily close on or after entry plus 91 calendar days; model, decision, tradable, entry, and exit dates are exposed. Training labels are purged by outcome date before the next test interval and then receive a 91-calendar-day embargo. Reports separate score direction, persisted formal verdict, existing dashboard target-exposure risk calls, Spearman IC, and fold-training-only q10 tail detection. The initial `2026-07-22T19:37:28Z` / `75c93d5` registration was invalidated by review because it still used weekly pre-decision prices, signal-date embargo, and post-hoc tail calibration. The corrected protocol was amended at `2026-07-22T20:17:47Z` and anchored to implementation commit `31d26408ec6a3e05ef6da9ce7a9277320dcbf8f9`, while the execution-date holdout still begins in the future on `2026-07-23`. The Champion identity, factor keys, policy, and digest are exact literals; a future model/config change cannot rewrite them. No truthful tail threshold existed at amendment, so prospective tail remains `UNAVAILABLE_AT_REGISTRATION`; the other metrics remain `PENDING_MATURITY` until enough labels mature.

PR-16 adds `SCORE_STRESS_DIAGNOSTICS_V1` as a diagnostic layer only. It reuses the same governed event-time/PIT gate for 4/8/13-week outcomes, reports seven fixed score buckets, keeps overlapping and interval-non-overlapping counts separate, and replays eight preregistered stress windows. Its append-only ledger records the full conservative trial multiplicity of PR-11/PR-12 and distinguishes genuine preregistration from retrospective review amendments. Missing primary p-values count as one for family-size control; a Deflated Sharpe value is not published without a complete formal daily net-return trial vector. No diagnostic result is a promotion gate and no candidate artifact is inferred from Champion rows.

## Failed regimes and monitoring

Known weak areas include market drift overwhelming direction accuracy, publication-calendar approximations, crisis source disruption, and limited non-overlapping samples. Health/SLO responses expose ingest and snapshot outcomes. Critical snapshot failure alerting is mandatory, but delivery depends on configured provider secrets and must be monitored through structured `alert_delivery` events and the audit table.

## Known limitations

- Release rules remain conservative approximations and do not encode every US market holiday.
- Live cache is per Worker isolate; it is an upstream-load guard, not a globally coherent quote store.
- Staging identifiers and remote secrets are intentionally not committed. A local dry-run is not evidence that staging or production deployment succeeded.
- Historical rows backfilled by migration 0010 are explicitly `LEGACY_UNVERSIONED`. Versioned APIs report the governed/legacy union without inventing identity. PR-15 retrospective validation labels this cohort `PARTIAL_LEGACY`; legacy q10 calibration remains null as `PARTIAL_LEGACY_CALIBRATION`. Malformed/non-PIT inputs, incomplete daily price provenance, mixed governed model/config cohorts, and legacy post-holdout signals fail closed.
- The local restore fixture proves the mechanism and invariants, not restoration of a real production backup.
- Current formal storage may not cover every registered stress window with governed PIT signals and raw daily prices. Such windows remain `NO_FORMAL_SIGNAL_COVERAGE`, `NON_PIT_PRICE_COVERAGE`, `PARTIAL_COVERAGE`, or `PENDING_OUTCOME`; legacy weekly/current-vintage rows are never substituted.

## Governance and promotion

A challenger must be preregistered, point-in-time, no-lookahead, positive in most fixed OOS folds, non-degraded on non-overlapping IC, and improve beta-matched risk/return or tails. It remains shadow-only until independent review and an explicit production decision.

## Rollback

Revert the PR-16 commit range after base `b79aab3` to remove the additive score/stress diagnostics, then revert PR-15 after base `780e125` only if its validation layer must also be removed. PR-15/PR-16 add no migration and write no database data, so no data rollback is required. Migration 0010 from PR-13 remains additive and must not be dropped on a remote database. Snapshot scores, formulas, weights, thresholds, hysteresis, and portfolio policy were not changed.
