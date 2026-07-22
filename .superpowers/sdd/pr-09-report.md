# PR-09 Event-Time Backtest Report

Base: `37fd6c4`

Branch: `codex/pr-09-event-time-backtest`

Implementation commits: `0764210..HEAD` (whole-branch review candidate diff: `37fd6c4..HEAD`)

## Outcome

- Added append-only revisioned `market_prices_daily` (SPX/VIX) and `cash_rates_daily` (SOFR) storage with source, fetch-time, raw-run, activation-run, D1 `activated_at`, and explicit `PIT_RAW` / `SYNTHETIC_BACKFILL` / `LEGACY_NO_PIT` provenance. Database triggers reject update/delete.
- Migration 0009 backfills existing `observations` rows using one canonical D1 migration clock and `MIGRATION_0009_BACKFILL`; these rows remain auditable but never pass the formal performance gate. It also backfills official snapshot `recorded_at` conservatively at migration time.
- Successful ingest activation fixes one D1 `activated_at` inside the fenced batch, touches only this run's staged SP500/VIXCLS/SOFR dates, skips unchanged inclusive replay, and appends corrections or provenance upgrades. A later lease/assertion failure rolls back raw/compatibility rows, revisions, and ACTIVE switching together. The existing active/latest-PIT mismatch guard remains in the same transaction.
- `loadEventBacktestInputs(db, requestedAsOf?)` first fixes one canonical D1 now/cutoff, rejects invalid/future requests, and filters official signal `recorded_at` plus every daily `activated_at` with strict `< cutoff` visibility. It selects the latest eligible revision per symbol/date, so equal-millisecond commits are conservatively deferred and no partial activation can leak.
- Frozen official `OK`/`PIT` signals use a conservative `17:00:00Z` earliest-US-close eligibility bound. Same-day execution is allowed only when `tradable_at` is strictly earlier; equality, EST 21Z, EDT 20Z, and the real July 3 17Z early close wait for the next actual SPX row. `23:59:59Z` is only an accounting marker, not an exchange timestamp. Same-date signals collapse to latest epoch `decision_at`; trailing signals remain explicitly unexecuted.
- Daily NAV uses prior-close exposure, the latest prior-date SOFR fixing (excluding same-date lookahead) with ACT/360 cash carry, 1 bp commission, 2 bps base slippage, conservative 3 bps extra slippage for VIX at/above 28 or stale/missing VIX, and SOFR plus 100 bps financing above 100% exposure.
- Missing/stale SOFR, no executable signal, or fewer than two executable market sessions returns `DATA_INCOMPLETE` with empty NAV and all performance totals null; it never substitutes zero cash return or publishes partial performance.
- `/api/backtest?as_of=` preserves existing horizon/factor-IC diagnostics and returns formal `event_time` only with complete append-only PIT provenance. Successful responses expose `APPEND_ONLY_AS_OF`, `responseReproducible=true`, the exact cutoff, max fetch time, sources, and raw/activation run counts. Synthetic, legacy, or missing provenance returns empty/null `DATA_INCOMPLETE`.
- Both the old weekly long/flat output and `/api/robustness.strategy` expose `methodology: LEGACY_WEEKLY`; robustness caveats use the same label.
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
- Final self-review added a no-lookahead regression proving a same-date 99% SOFR fixing was incorrectly visible at interval start; the RED cash return was 0.00825. The strict-prior-date fix in `eaa4e73` restored the expected 5% Fri→Mon carry of 0.0004166667 and documents the conservative date-only availability rule.
- Task/spec review found the global mandatory backtest checklist still marked PR-09's four delivered gates incomplete. The review fix checks only next-tradable execution, daily prices, non-zero cash carry, and costs; the remaining five PR-10/later gates stay unchecked.
- Task rereview found activation stamping daily rows with activation time and generic FRED source instead of raw-vintage provenance. The regression separates PIT `fetched_at` from activation time across SPX/VIX/SOFR, covers a corrected SPX vintage and same-value synthetic upgrade, and preserves unchanged-row/fence behavior.
- Whole-branch review first found partial NAV/cost leakage, no hard active/latest-PIT value fence, insufficient revision disclosure, legacy weekly prose appearing formal, and missing same-date supersession audit. Those fixes erased incomplete performance, added the transactional mismatch guard and superseded-signal audit, and labeled every weekly metric. A later final review correctly rejected the interim mutable-revision design; the append-only strict-as-of redesign in this candidate supersedes that interim response contract.
- Final-review reproducibility RED: the mutable overwrite schema, lack of shared signal/daily cutoff, synthetic formal inputs, and 23:59 eligibility all violated the formal contract. RED evidence included 11/25 engine failures plus DB errors for missing `activated_at`/`recorded_at`; a second DB/API batch had 9 failures/65 passes. The implementation above made the focused engine/DB/API suite green.
- Formal-cutoff RED separately proved that engine calls without a D1-supplied `asOfCutoff` incorrectly returned `OK`; the gate now rejects them. Strict-visibility RED proved rows with `recorded_at == cutoff` were included; all signal/daily queries and the engine gate now require `< cutoff`.
- Whole-branch Important RED proved the legacy no-provenance writer could overwrite a frozen PIT row: score changed **60→1** and `recorded_at` changed, which also invalidated the previously captured cutoff replay. The conflict update now excludes `pit_status='PIT'`, reports `FROZEN`, and preserves the complete row plus same-cutoff replay. Focused DB/event/PIT verification: **3/3 files, 31/31 tests, exit 0**.
- Fresh candidate `env -u NODE_OPTIONS npm test -- --reporter=json --outputFile=/tmp/pr09-full-review-fix.json`: **29/29 files, 518/518 tests, exit 0**.
- Fresh candidate `env -u NODE_OPTIONS npx tsc --noEmit`: **exit 0**.
- `git diff --check`: **exit 0**.
- Fresh local `npm exec wrangler -- d1 migrations apply macro_liquidity --local --persist-to /tmp/pr09-repro-migrations.Sos167`: migrations **0001–0009 applied successfully**; immediate second invocation returned **No migrations to apply!**. Wrangler 3.114.17's update warning did not affect either exit code.
- Review-package evidence is generated after the candidate commit; older 504-test/migration outputs are intentionally not claimed for this head.

Review conclusion: the Important frozen-PIT reproducibility defect is fixed locally with RED→GREEN evidence. The candidate is green and ready for a new whole-branch review; it is not marked final-reviewed or production-approved here.

## Historical and production impact

- Formal historical performance changes from the approximate weekly long/flat calculation to an event-time, daily-close NAV path. The previous calculation remains in the response for compatibility and is explicitly legacy; IC/factor diagnostics are unchanged.
- SPX `adjusted_close` is the FRED SP500 index close and does not include dividends. Results must not be interpreted as total-return performance.
- Migration 0009 is additive and has not been deployed. If applied to a database with existing compatibility observations, it creates synthetic audit revisions immediately; later real PIT inputs append new revisions rather than overwriting history.
- No deployment, push, remote D1 access, production migration, or production database mutation was performed in this PR.

## Known limitations

- The actual SPX rows form the trading-session calendar; there is no separate exchange calendar.
- Cash/VIX freshness uses named four-calendar-day limits. Missing/stale SOFR fails closed; VIX stale/missing conservatively increases cost.
- The PR-09 compatibility target remains `score > 55 ? 100% : 0%`. Dashboard exposure tiers, fair benchmarks, beta matching, and tail analytics belong to PR-10.
- FRED index-close history excludes dividends and may differ from a tradable total-return product.
- `tradingCostRate` is the accumulated per-turnover cost rate, not a dollar/NAV attribution amount.
- The actual SPX row is a date/value rather than an exchange timestamp. The `17:00Z` lower bound is deliberately conservative across normal and early closes; `23:59:59Z` is only a deterministic accounting marker.
- Existing synthetic/legacy dates remain formal `DATA_INCOMPLETE` until a real PIT-sourced revision is ingested. This is deliberate; the engine never promotes an unverifiable backfill into performance.
- Local Wrangler 3.114.17 emitted an available-update warning; it did not affect migration success.

## Rollback

- Code: create a dedicated revert for `37fd6c4..reviewed-head`; do not rewrite unrelated PR-01–08 history.
- Local test data: discard only the explicit temporary `--persist-to` directory and rebuild from migration 0001.
- If migration 0009 is ever applied to a shared/production D1, do not drop, update, or delete append-only revisions. Stop dependent writes/readers first and use a forward migration to disable or migrate the structures.
