# Changelog

All notable changes to Macro Liquidity Dashboard are documented here.

## Unreleased

### PR-09 — Event-time daily backtest

- Added `market_prices_daily` and `cash_rates_daily` with strict source/fetch/run provenance, an explicitly synthetic auditable local backfill from existing SP500/VIXCLS/SOFR observations, and correction-aware materialization from the latest matching PIT vintage inside the ingest activation fence.
- Scheduled frozen official `OK`/`PIT` signals at the first observed SPX close strictly after `tradable_at`; same-close events collapse to the latest `decision_at`, and late signals remain explicitly unexecuted.
- Added daily close-to-close NAV with SOFR ACT/360 carry, 1 bp commission, 2 bps base slippage, conservative 3 bps high/stale/missing-VIX slippage, and SOFR plus 100 bps financing support above 100% exposure.
- Made missing/stale SOFR and insufficient sessions return typed `DATA_INCOMPLETE` with null total performance, while retaining the old weekly long/flat output as `LEGACY_WEEKLY` diagnostics.
- Exposed event-time assumptions and incomplete-data reasons in `/api/backtest` and the dashboard without changing Champion formulas, weights, thresholds, hysteresis, or snapshot channels.
- Made `DATA_INCOMPLETE` erase all partial NAV/cost/session performance, added same-close superseded-signal audit rows, and rejected active/latest-PIT value mismatches inside the activation transaction.
- Labeled event-time inputs `CURRENT_REVISION_MUTABLE` with a compact source/run/synthetic/max-fetch cutoff summary and `responseReproducible=false`; future FRED corrections can change historical results because the response payload is not frozen.
- Added local-only migration `0009_event_time_backtest.sql`; no deploy, remote D1 access, benchmark, exposure-tier, or tail-metric work was performed.

### PR-08 — Point-in-time observation storage

- Added append-only ALFRED vintage storage, revision reporting, conservative release metadata, manual release overrides, and next-weekday tradability metadata.
- Added inclusive vintage checkpoints and atomically promoted PIT rows beside the existing `observations` compatibility view under the existing database lease fence.
- Added lazy no-lookahead frame resolution using ordered per-series active histories; service rebuilds consume frames directly instead of retaining the full frame set.
- Made frame release/tradability cutoffs cover every scoring-history row and added production-scale coverage for 12×2,500 rows across 500 decision events.
- Added explicit `AVAILABLE`/`MISSING` endpoint audit-index rows for every configured series; full scoring history is reproduced from raw PIT rows plus `decision_at` and `release_resolution_at`.
- Froze PIT official snapshots and their endpoint indexes after a one-time legacy upgrade, including abnormal PIT rows with null run provenance; nowcasts persist provenance without creating a formal endpoint index.
- Lifted each frame's declared tradability to the latest tradability of every scoring-history row and added a second fail-closed endpoint-input gate.
- Loaded all release-calendar validity versions and required every vintage to match exactly one strictly validated interval, failing closed on gaps or overlaps.
- Versioned release-calendar overrides append-only and resolved the latest version created by each run's fixed `release_resolution_at`, without mutating raw rows; same-day fetch time now reflects successful HTTP response completion.
- Moved the fixed release-resolution instant after successful fetch/activation, made its clock injectable, excluded later-fetched backfills and later resolved official events from older universes, and persisted the same cutoff on snapshots.
- Replaced PIT timestamp text comparisons with canonical strict ISO epoch comparisons and D1 `julianday` cutoff/order semantics, including fail-closed equal-instant override ambiguity.
- Validated staged raw timings before write and changed stored-data corruption checks to a SQL `LIMIT 1` guard, avoiding a second full raw-table result set during rebuild.
- Added a post-provenance migration trigger that rejects override inserts backdated at or before any frozen weekly/daily PIT resolution cutoff, while preserving historical override entry before the first frozen snapshot.
- Added a companion raw-observation trigger that rejects genuinely new vintages whose `fetched_at` is at or before any frozen weekly/daily PIT resolution cutoff. Initial historical population and idempotent existing-key replay remain valid; a violating ingest activation rolls back atomically without replacing the ACTIVE run.
- Reloaded frozen hysteresis anchors across the complete decision week when the rebuilt snapshot date differs from the stored date.
- Expanded the final local verification to 27 files / 477 tests, TypeScript strict, diff checks, and fresh local migration first/second-run validation.
- Added local-only migration `0008_point_in_time_observations.sql`; no deployment, remote D1 access, model formula, weight, threshold, hysteresis, or channel-policy change was made.

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
- Added official FRED fallback for every market input (`SP500`, `VIXCLS`, `DTWEXBGS`, `DGS10`) after optional Stooq, while exposing the actual fallback instrument and preserving DXY return-chain scale.
- Hardened provider trust boundaries with strict/future timestamps, missing-value rejection, Stooq challenge detection, a named injectable timeout, Yahoo market-state whitelisting, and escaped UI provenance.
- Made history divergence symbol-aware: VIX level, SPX/DXY five-day return, and 10Y five-day percentage-point change now disagree on either stress classification or a named material-difference tolerance.

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
