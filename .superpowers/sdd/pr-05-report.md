# PR-05 Implementation Report

## 1. Status

DONE_WITH_CONCERNS

Implementation and local verification are complete. No deployment, push, remote D1 access, or production mutation was performed. The concern is the intentionally explicit `/api/snapshot` response change: consumers must switch from the ambiguous legacy `snapshot` field to `official` and/or `nowcast` when this commit is deployed.

## 2. Summary and design decisions

- Added `model_snapshot_weekly` for official decisions and `nowcast_snapshot_daily` for intra-week observations.
- Enforced at most one official decision per Monday-based week with a unique `decision_week`; full rebuild also deterministically keeps the latest WALCL observation date in each week.
- Marked every daily nowcast `PROVISIONAL` in both storage and API presentation.
- Made database APIs frequency-explicit (`upsertOfficialSnapshot`, `upsertNowcastSnapshot`, `latestOfficialSnapshot`, `latestNowcastSnapshot`, and official-only history/reference helpers).
- Routed full rebuilds only to official storage and incremental refreshes only to nowcast storage.
- Full rebuilds reconstruct official hysteresis from an undefined prior verdict. Incremental nowcasts seed from the official verdict before their window and re-anchor at every persisted valid official verdict inside the window, loaded with one batched query. Nowcast writes never update official rows.
- Restricted history, explain, exported snapshots, backtest, walk-forward, and robustness to `model_snapshot_weekly`.
- Returned `/api/snapshot` as `{ official, nowcast, live, ingest }`. The ambiguous legacy `snapshot` alias was deliberately not retained because it would obscure which frequency is being displayed.
- Updated the frontend with visible “正式信号” and “周中预估 · PROVISIONAL” channel labels. The primary card displays the nowcast only when it is strictly newer than the official signal; equal dates prefer official. Explanation and provenance surfaces state their channel and source date explicitly.
- Preserved `daily_snapshot` untouched as a read-only legacy compatibility source.

## 3. Changed-file inventory

Immutable implementation/review range: `854c64b..9eda471`.

```text
.superpowers/sdd/pr-05-report.md
CHANGELOG.md
README.md
docs/ALGORITHM.md
docs/superpowers/plans/2026-07-21-pr-05-final-review-fixes.md
migrations/0005_official_nowcast.sql
package.json
public/algorithm.md
public/app.js
public/index.html
public/md/CODEX_PROFESSIONAL_UPGRADE_PLAN.md
public/styles.css
src/db.ts
src/service.ts
src/worker.ts
test/db.test.ts
test/service-channels.test.ts
test/service-freshness.test.ts
test/service.test.ts
test/ui-assets.test.ts
test/ui-channels.test.ts
test/worker.test.ts
```

## 4. RED and GREEN evidence

RED command:

```text
env -u NODE_OPTIONS npm test -- test/db.test.ts test/service-channels.test.ts test/worker.test.ts test/ui-channels.test.ts
```

Observed RED: exit 1; 4 test files failed, 8 tests failed and 14 passed. Expected failures showed that explicit writers and migration tables did not exist, `loadBacktestRows()` still queried `daily_snapshot`, service rebuild modes still used the shared writer, `/api/snapshot` lacked `official`/`nowcast`, and the UI lacked both channel labels.

Focused GREEN command:

```text
env -u NODE_OPTIONS npm test -- test/db.test.ts test/service-channels.test.ts test/service.test.ts test/service-freshness.test.ts test/worker.test.ts test/ui-channels.test.ts
```

Observed GREEN: exit 0; 6 test files passed, 27/27 tests passed.

## 5. Full verification

```text
env -u NODE_OPTIONS npm test
```

Result: exit 0; 22/22 test files passed, 340/340 tests passed.

```text
env -u NODE_OPTIONS npx tsc --noEmit
```

Result: exit 0 with no diagnostics.

`git diff --check` also exited 0.

## 6. Migration behavior and local-only validation

Migration `0005_official_nowcast.sql`:

- Creates both new tables without dropping or rewriting `daily_snapshot`.
- Migrates a legacy row only if the row date exactly matches an `observations` row whose `series_id = 'WALCL'`.
- Derives a Monday-based `decision_week`, ranks exact WALCL matches within that week by descending date, and migrates only rank 1.
- Uses `INSERT OR IGNORE`, making the migration conservative if an official weekly row already exists.
- Enforces daily nowcast status with `DEFAULT 'PROVISIONAL'` and a `CHECK` constraint.

Local validation command:

```text
env -u NODE_OPTIONS npm run migrate:local
```

The first sandboxed attempt failed with `listen EPERM` on `127.0.0.1`. The approved rerun applied migrations 0001–0005 successfully to the worktree-local D1 state. Wrangler explicitly reported local execution and no `--remote` flag was used.

## 7. Known limitations

- Legacy classification is intentionally conservative: a historical `daily_snapshot` row without an exact same-date WALCL observation is not migrated, even if it was operationally intended as official.
- If multiple exact WALCL dates occur in one Monday-based week, only the latest is retained. This guarantees weekly uniqueness but may discard an unusual duplicate release.
- `/api/snapshot` no longer provides the ambiguous `snapshot` alias. External clients must adopt the explicit channel fields during rollout.
- This PR does not add point-in-time vintages, atomic ingest runs, staging activation, or concurrency locking; those remain later planned work.
- Local migration validation started from the worktree-local D1 state and did not validate production row counts or production data classification.

## 8. Rollback instructions

1. Before merge, revert immutable functional range `854c64b..9eda471` newest first. After merge, prefer reverting the eventual PR merge commit so the report-only archive commit is also included.
2. Do not delete the new tables as part of an emergency application rollback; the preserved `daily_snapshot` lets the previous application code run, although it will contain only pre-PR legacy data because PR-05 never writes it.
3. If schema cleanup is later required, export/verify the two new tables first, then remove them in a separately reviewed migration. Do not manually modify production D1 during an application rollback.

## 9. Did historical results change?

Potentially yes, by design, once migrated and deployed. Official analytics will use only exact WALCL-cadence weekly rows and exclude mixed daily nowcasts, so sample counts and aggregate backtest/walk-forward/robustness results may change. Individual Champion scoring formulas, weights, factor calculations, and 45/55 thresholds were not changed.

## 10. Did production scores or exposure advice change?

No production state was changed because nothing was deployed and remote D1 was not accessed. The score and exposure formulas are unchanged. After deployment, the UI may show a newer provisional nowcast alongside the official weekly signal, but it is explicitly labeled and cannot enter official analytics.

## 11. Commits and worktree state

- Feature base: `854c64b`.
- `c3ee4d1` — `refactor: split official snapshots from nowcasts`.
- `798e2c1` — `docs: record PR-05 verification`.
- `7393112` — `fix: address official nowcast review`.
- `8e5445e` — `docs: clarify PR-05 rollback`.
- `9eda471` — `fix: resolve final official nowcast review`.
- The final archive-only report clarification is intentionally outside the immutable functional range above; it changes no runtime behavior.
- Final tracked worktree state: clean on `codex/pr-05-official-nowcast`.
- `package-lock.json` contained dependency-platform metadata churn unrelated to PR-05; it was inspected, excluded, and restored. PR-05 adds no dependency.

## 12. Review fixes

Resolved the PR-05 review findings without changing formulas, weights, thresholds, migration scope, remote state, or deployment state:

- The frontend now selects a provisional nowcast as the primary card only when `nowcast.date > official.date`. A same-date or newer official snapshot remains primary, while both official and nowcast summaries are still rendered and the current-channel label follows the selected primary record.
- Removed obsolete ambiguous database API exports from the service-channel and worker test mocks.
- Strengthened the PR-01 consistency regression to compare full-rebuild official fields with independently calculated incremental nowcast fields on the same dates, instead of re-reading unchanged official rows.

Review-fix RED command:

```text
env -u NODE_OPTIONS npm test -- test/ui-channels.test.ts
```

Observed RED: exit 1; 1 test failed and 1 passed. The behavioral test delivered official `2026-07-21` and nowcast `2026-07-20`, and failed because the primary renderer received the older provisional nowcast.

Review-fix focused GREEN command:

```text
env -u NODE_OPTIONS npm test -- test/ui-channels.test.ts test/service.test.ts test/service-channels.test.ts test/worker.test.ts
```

Observed GREEN: exit 0; 4/4 test files passed, 16/16 tests passed.

Fresh full verification after the fixes:

```text
env -u NODE_OPTIONS npm test
```

Result: exit 0; 22/22 test files passed, 341/341 tests passed.

```text
env -u NODE_OPTIONS npx tsc --noEmit
```

Result: exit 0 with no diagnostics.

```text
git diff --check
```

Result: exit 0 with no output.

## 13. Final-review fixes

Resolved all final-review findings without changing formulas, factor weights, 45/55 thresholds, migration scope, remote state, or deployment state:

- Added `officialVerdictAnchors()` to load every valid official verdict inside the incremental window in one ordered D1 query. Incremental nowcasts still seed from the official row before the window, then reset hysteresis before calculating each anchored date so a provisional threshold crossing cannot leak past an official boundary.
- Full official rebuilds no longer query any persisted official verdict; they reconstruct from `undefined` as required by P0-01.
- Equal-date channel conflicts now prefer official; only a strictly newer nowcast becomes primary.
- The explanation title and rendered source line explicitly identify `正式信号 · OFFICIAL` and show the official source date returned by `/api/explain`, independently of the primary card.
- The official-only history chart and robustness panel visibly carry `OFFICIAL` titles.
- Primary-card provenance is channel-aware: provisional nowcasts receive a `PROVISIONAL` tag and daily-recalculation wording instead of the official weekly label.
- Rollback and inventory instructions now use the feature base plus the then-current `HEAD`, avoiding stale recorded tip hashes.

Final-review RED command:

```text
env -u NODE_OPTIONS npm test -- test/db.test.ts test/service.test.ts test/ui-channels.test.ts
```

Observed RED: exit 1; 3/3 test files failed, with 6 failed and 15 passed tests. Failures proved the batched anchor helper was absent, a provisional BEARISH crossing leaked past an in-window BULLISH official boundary, full rebuild inherited a persisted BEARISH verdict, an equal-date conflicting nowcast won, explanation lacked official source/date labeling, and provisional provenance lacked channel identity.

Additional historical-analytics RED command:

```text
env -u NODE_OPTIONS npm test -- test/ui-channels.test.ts
```

Observed RED: exit 1; 1 test failed and 5 passed because the official-only history chart and robustness titles did not identify themselves as `OFFICIAL`.

Final-review focused GREEN command:

```text
env -u NODE_OPTIONS npm test -- test/db.test.ts test/service.test.ts test/service-channels.test.ts test/service-freshness.test.ts test/ui-channels.test.ts test/ui-assets.test.ts
```

Observed GREEN: exit 0; 6/6 test files passed, 39/39 tests passed.

Fresh full verification:

```text
env -u NODE_OPTIONS npm test
```

Result: exit 0; 22/22 test files passed, 348/348 tests passed.

```text
env -u NODE_OPTIONS npx tsc --noEmit
```

Result: exit 0 with no diagnostics.

```text
git diff --check
```

Result: exit 0 with no output.
