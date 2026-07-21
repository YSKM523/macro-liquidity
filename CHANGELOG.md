# Changelog

All notable changes to Macro Liquidity Dashboard are documented here.

## Unreleased

### PR-07 — Source timestamps and provider fallback

- Added one typed quote/history provider contract with injectable Yahoo, Stooq, and FRED implementations.
- Separated provider market/observation timestamps from fetch time and retained `asof` only with explicit `FETCH_TIME` semantics.
- Added auditable SPX, VIX, DXY, and 10Y quote/history fallback metadata plus named `OK`, `STALE`, `DIVERGENT`, and `FAILED` states.
- Added `SOURCE_DIVERGENCE` detection using documented market-data quality tolerances and shared-date normalized history changes.
- Made live stress fail closed for failed, stale, or divergent required histories while accepting a valid named fallback.
- Routed DXY daily extension through the same Yahoo/Stooq abstraction without changing its level scale or splice semantics.
- Corrected Stooq history parsing to its distinct six-column CSV contract and reject impossible Stooq/FRED calendar dates as `INVALID_TIMESTAMP`.
- Updated snapshot/prices API payloads and the dashboard to show source time, fetch time, provider, market state, delay, fallback, and divergence separately.
- Added no migration and made no Champion scoring, weight, threshold, exposure, channel, ingest, or PIT change.

### PR-06 — Atomic ingest runs and staging activation

- Added durable `RUNNING` / `ACTIVE` / `FAILED` ingest-run audit state, per-series attempts, run-scoped staging observations, and an expiring database-backed lease.
- Kept `observations` unchanged during fetch and validation, then promoted staging and switched the single ACTIVE run in one transactional D1 `db.batch()`.
- Preserved failed-run context and the prior production view; snapshot writers now run only after successful activation and retain PR-05 official/nowcast routing.
- Made manual lock contention explicit with HTTP 409 and scheduled contention an explicit typed result.
- Exposed the current ACTIVE and latest FAILED run through snapshot ingest metadata and health responses.
- Added local-only migration `0006_atomic_ingest.sql` without dropping or redirecting legacy production tables.
- Extended the lease through active-view reads, DXY fetches, every snapshot write, success metadata, and snapshot finalization; a lost owner can no longer continue snapshot persistence.
- Added local-only additive migration `0007_ingest_snapshot_outcome.sql` with durable `PENDING` / `SUCCEEDED` / `FAILED` snapshot outcomes, completion/error/count fields, and health failure signaling.
- Opened each series attempt before fetch and durably closed fetch, structural-validation, and staging failures without masking the original exception when audit persistence fails.
- Guarded every activation mutation inside the transactional batch so a missing or non-`RUNNING` target cannot promote observations or demote the prior ACTIVE run.
- Replaced caller-captured lease timestamps with D1-current acquisition and renewal; an expired lease cannot be resurrected.
- Fenced every activation, official/nowcast snapshot, snapshot-outcome, and global ingest-metadata mutation on the database-current live owner, with in-batch terminal assertions that roll back mid-transaction lease loss.
- Published `snapshot_state=SUCCEEDED` and the complete success metadata set atomically, made ACTIVE `PENDING` health explicitly unhealthy, and opened each series attempt before its production-history read.
- Declared the Miniflare version used by real D1 concurrency regressions as the exact direct dev dependency `3.20250718.3`; no schema migration was added by this final hardening pass.

### PR-05 — Official weekly snapshots and daily nowcasts

- Split persisted model output into official `model_snapshot_weekly` and provisional `nowcast_snapshot_daily` channels.
- Routed full rebuilds exclusively to official weekly storage and incremental refreshes exclusively to daily nowcast storage.
- Restricted history, explanation, backtest, walk-forward, and robustness reads to official weekly snapshots.
- Returned explicit `official` and `nowcast` snapshot API fields and labeled both channels in the dashboard.
- Added a conservative WALCL-cadence legacy migration while retaining `daily_snapshot` as a read-only compatibility source.

### PR-04 — Per-series freshness and factor data quality

- Added frequency-aware freshness rules and explicit factor quality states.
- Made critical missing or stale macro inputs return `DATA_INCOMPLETE`.
- Preserved real partial-factor scores while reducing confidence for incomplete optional inputs.
- Propagated current data quality through snapshot, health, explanation, backtest, and UI responses.
- Added local D1 migration `0004_snapshot_quality.sql` and verified it against the local database only.

### PR-03 — Tri-state live stress

- Replaced fail-open stress behavior with `NORMAL`, `STRESSED`, and `UNKNOWN`.
- Blocked risk increases when required live market inputs are unavailable.
- Added API and UI coverage for unavailable real-time risk data.

### PR-02 — Unified decision state

- Centralized macro verdict, display verdict, exposure tier, tone, and blocking decisions.
- Locked score boundary behavior at 45, 50, and 55 with regression tests.

### PR-01 — Incremental rebuild hysteresis

- Added lookup of the latest official snapshot before an incremental rebuild window.
- Initialized incremental hysteresis from that prior verdict without changing model weights, formulas, or thresholds.
- Added regression coverage proving full and incremental rebuild consistency.
