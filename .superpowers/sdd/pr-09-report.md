# PR-09 Event-Time Backtest Report

Base: `37fd6c4`

Branch: `codex/pr-09-event-time-backtest`

Implementation commits: `0764210..99e9616`

## Outcome

- Added strict `market_prices_daily` (SPX/VIX) and `cash_rates_daily` (SOFR) storage with source, fetch-time, and ingest-run provenance.
- Migration 0009 backfills existing `observations` rows as `SP500→SPX`, `VIXCLS→VIX`, and `SOFR→SOFR` using canonical D1 time, explicit `FRED:*` source labels, and `MIGRATION_0009_BACKFILL` provenance.
- Successful ingest activation now materializes those inputs in the same fenced D1 batch. Unchanged history retains its original provenance; corrections update value and provenance. A later lease/assertion failure rolls back observations, market/cash inputs, and ACTIVE switching together.
- Frozen official `OK`/`PIT` signals execute at the first observed SPX close (`23:59:59Z`) strictly after `tradable_at`. Same-close signals collapse to the latest epoch `decision_at`; signals beyond the price history remain explicitly unexecuted.
- Daily NAV uses prior-close exposure, SOFR ACT/360 cash carry, 1 bp commission, 2 bps base slippage, conservative 3 bps extra slippage for VIX at/above 28 or stale/missing VIX, and SOFR plus 100 bps financing above 100% exposure.
- Missing/stale SOFR, no executable signal, or fewer than two executable market sessions returns `DATA_INCOMPLETE` with `totalReturn=null`; it never substitutes zero cash return or publishes partial performance.
- `/api/backtest` preserves the existing horizon and factor-IC diagnostics, adds formal `event_time`, and labels the old weekly long/flat result `LEGACY_WEEKLY`.
- Dashboard and algorithm docs disclose execution timing, index-close semantics, cash day count, costs, high-vol policy, financing, incomplete-data behavior, and the legacy/formal distinction.
- Champion score formulas, factor weights, 45/50/55 bands, hysteresis, live-stress thresholds, and official/nowcast channel policy were not changed. PR-10 exposure tiers, benchmarks, and tail metrics were not implemented.

## Files

- Schema/storage: `migrations/0009_event_time_backtest.sql`, `src/db.ts`
- Engine/config/API: `src/event-backtest.ts`, `src/config.ts`, `src/worker.ts`
- Dashboard/docs: `public/app.js`, `public/index.html`, `README.md`, `docs/ALGORITHM.md`, `public/algorithm.md`, `CHANGELOG.md`, `public/md/CODEX_PROFESSIONAL_UPGRADE_PLAN.md`
- Tests: `test/event-backtest.test.ts`, `test/event-backtest-db.test.ts`, `test/db.test.ts`, `test/worker.test.ts`, `test/ingest-db.test.ts`, `test/pit-db.test.ts`, `test/pit-snapshot-db.test.ts`, `test/ui-assets.test.ts`, `test/ui-channels.test.ts`

## TDD and verification

- Task 1 RED: all three DB tests failed because migration 0009 did not exist. GREEN covered local backfill, atomic materialization, correction provenance, unchanged-row preservation, and fence rollback.
- Task 2 RED: scheduler suite could not load the absent event-time module. GREEN covered strict-after close selection, weekends/gaps, epoch ordering across timestamp precision, same-close collapse, unexecuted signals, and validation.
- Task 3 RED: seven daily-NAV tests failed because the engine did not exist. GREEN covered Fri→Mon SOFR accrual (`0.05×3/360`), missing/stale cash, 3/6 bp trade costs, conservative VIX handling, and 1.5x financing (`-0.5×0.06×3/360`).
- Task 4 RED: repository loader and API `event_time` were absent. GREEN retained diagnostics, added formal performance, and returned typed incomplete results.
- Task 5 RED: dashboard had no event-time disclosure. GREEN added the formal-performance card and fail-closed assumptions display (missing API assumptions render as unknown, never frontend defaults).
- First full-suite run exposed old migration fixtures stopping at 0008 and a DOM-less main harness invoking the new loader: 28/29 files, 497/499 tests, 2 failures and 3 unhandled errors. The fixture-only correction was committed as `99e9616`; focused rerun passed 3/3 files and 29/29 tests without unhandled errors.
- Fresh final `env -u NODE_OPTIONS npm test`: **29/29 files, 499/499 tests, exit 0**.
- Fresh final `env -u NODE_OPTIONS npx tsc --noEmit`: **exit 0**.
- `git diff --check 37fd6c4..HEAD`: **exit 0**.
- Fresh local `npm exec wrangler -- d1 migrations apply macro_liquidity --local --persist-to /tmp/pr09-d1-e1yvC9`: migrations **0001–0009 applied successfully**; immediate second invocation returned **No migrations to apply!**.

## Historical and production impact

- Formal historical performance changes from the approximate weekly long/flat calculation to an event-time, daily-close NAV path. The previous calculation remains in the response for compatibility and is explicitly legacy; IC/factor diagnostics are unchanged.
- SPX `adjusted_close` is the FRED SP500 index close and does not include dividends. Results must not be interpreted as total-return performance.
- Migration 0009 is additive. If applied to a database with existing compatibility observations, it creates a local audit backfill immediately; the next successful activation corrects value/provenance atomically where needed.
- No deployment, push, remote D1 access, production migration, or production database mutation was performed in this PR.

## Known limitations

- The actual SPX rows form the trading-session calendar; there is no separate exchange calendar.
- Cash/VIX freshness uses named four-calendar-day limits. Missing/stale SOFR fails closed; VIX stale/missing conservatively increases cost.
- The PR-09 compatibility target remains `score > 55 ? 100% : 0%`. Dashboard exposure tiers, fair benchmarks, beta matching, and tail analytics belong to PR-10.
- FRED index-close history excludes dividends and may differ from a tradable total-return product.
- `tradingCostRate` is the accumulated per-turnover cost rate, not a dollar/NAV attribution amount.
- Local Wrangler 3.114.17 emitted an available-update warning; it did not affect migration success.

## Rollback

- Code: create a dedicated revert for the PR-09 commit range after its final reviewed head; do not rewrite unrelated PR-01–08 history.
- Local test data: discard only the explicit temporary `--persist-to` directory and rebuild from migration 0001.
- If migration 0009 is ever applied to a shared/production D1, do not drop the additive tables in place. Stop dependent writes/readers first and use a forward migration to disable or migrate the structures.
