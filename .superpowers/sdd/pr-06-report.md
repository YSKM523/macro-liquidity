# PR-06 Implementation Report

## Status

PASS — PR-06 atomic ingest runs and staging activation is implemented and validated locally on branch `codex/pr-06-atomic-ingest`.

No deploy, push, remote D1 access, production mutation, point-in-time storage, provider fallback, Champion formula/weight/factor, 45/55 threshold, or official/nowcast semantic change was performed.

## Design decisions

- `observations` remains the production latest-view compatibility table. Fetching writes only to `staging_observations`; production observations change only inside activation.
- `ingest_runs` records `RUNNING`, `ACTIVE`, `FAILED`, and historical `SUPERSEDED` state with timestamps, mode, failure context, staged row count, and successful series count. A partial unique index enforces at most one `ACTIVE` run.
- `ingest_series_attempts` distinguishes a successful zero-row response from a missing/unattempted series. Zero rows validate only if the active `observations` view already contains that series.
- Staged observations are keyed by `(run_id, series_id, date)` and retain failed-run evidence.
- Lock acquisition is one conditional upsert. A live lease rejects another owner, an expired lease can be acquired, renewal and release are owner-scoped, and `runIngest()` releases in `finally` without masking the primary result.
- The lease is renewed after each completed series and again immediately before activation. Loss of ownership aborts and marks the run failed before production activation.
- Activation uses exactly one transactional D1 `db.batch()` containing: staged-row promotion into `observations`, previous ACTIVE demotion to `SUPERSEDED`, and new run transition to `ACTIVE`.
- Snapshot rebuilding starts only after activation and reloads `observations`. Full rebuild still writes only `model_snapshot_weekly`; incremental ingest still writes only `nowcast_snapshot_daily`.
- Manual contention returns HTTP 409. Scheduled contention returns a typed `conflict` result and emits a structured warning rather than appearing successful.
- `/api/health` and `/api/snapshot` expose the current ACTIVE and latest FAILED run while preserving existing meta-based health/error/alert behavior.

## Changed files

### Schema and production code

- `migrations/0006_atomic_ingest.sql` — run, series-attempt, staging, ACTIVE index, lease lock, and legacy ACTIVE bootstrap schema.
- `src/config.ts` — 15-minute renewable ingest lease duration.
- `src/db.ts` — lock acquire/renew/release, run lifecycle, staging, validation, atomic activation, failure evidence, and run summary queries.
- `src/service.ts` — lock-owned run orchestration, staging-first fetch loop, validation/activation boundary, post-activation snapshots, explicit scheduled contention.
- `src/worker.ts` — manual HTTP 409 and health/snapshot run metadata.

### Tests

- `test/atomic-ingest.test.ts` — fetch/activation failures, successful ordering, zero-row attempt, manual/scheduled contention, lease loss.
- `test/ingest-db.test.ts` — lock expiry/ownership/renewal, validation semantics, one-batch activation, migration contract.
- `test/service-channels.test.ts`, `test/service-freshness.test.ts`, `test/service.test.ts` — PR-01–PR-05 service mocks extended for the run repository without weakening assertions.
- `test/worker.test.ts` — HTTP 409 and run-metadata response coverage.

### Documentation

- `README.md`, `docs/ALGORITHM.md`, `public/algorithm.md` — current atomic ingest flow, compatibility view, API metadata, and contention behavior.
- `public/md/CODEX_PROFESSIONAL_UPGRADE_PLAN.md` — PR-06 status and completed checklist.
- `CHANGELOG.md` — PR-06 release notes.

## TDD evidence

### Initial RED

Command:

```bash
env -u NODE_OPTIONS npx vitest run test/atomic-ingest.test.ts test/ingest-db.test.ts test/worker.test.ts
```

Observed before production edits:

- 3 test files failed.
- 12 tests failed and 8 existing tests passed.
- Expected failures showed missing lock/validation exports and migration, direct production writes instead of staging, no failed-run evidence/activation boundary, non-explicit scheduled contention, and manual contention returning HTTP 200 instead of 409.

### Lease-renewal RED

Command:

```bash
env -u NODE_OPTIONS npx vitest run test/atomic-ingest.test.ts test/ingest-db.test.ts
```

Observed before renewal production edits:

- 2 test files failed.
- 3 tests failed and 12 passed.
- Expected failures showed the missing owner-scoped renewal primitive and a run continuing after simulated lease ownership loss.

### GREEN

Focused repository/orchestration suites passed after each implementation cycle. Final verification is recorded below.

## Final verification

### Full test suite

Command:

```bash
env -u NODE_OPTIONS npm test
```

Result: PASS — 24 test files, 364 tests passed, 0 failed.

### TypeScript

Command:

```bash
env -u NODE_OPTIONS npx tsc --noEmit
```

Result: PASS — exit code 0, no diagnostics.

### Patch hygiene

Command:

```bash
git diff --check
```

Result: PASS — no whitespace errors.

## Local migration result

Command:

```bash
env -u NODE_OPTIONS npm run migrate:local
```

Result: PASS — migrations `0001` through `0006` applied successfully to the worktree-local database under `.wrangler/state/v3/d1`. Wrangler explicitly reported local execution; no `--remote` command was used.

Local schema confirmation:

```bash
env -u NODE_OPTIONS npx wrangler d1 execute macro_liquidity --local --command "SELECT name, type FROM sqlite_master WHERE name IN ('ingest_runs','ingest_runs_single_active','ingest_series_attempts','staging_observations','ingest_lock','observations') ORDER BY name"
```

Result: PASS — returned all five PR-06 structures plus legacy `observations`.

## Known limitations

- PR-06 intentionally has no staging/audit retention job. Successful and failed run evidence remains until a future explicit retention policy is introduced.
- The lease is renewed between series and before activation. If one external fetch stalls past the lease, another owner may acquire it; the original run detects lost ownership at its next renewal and aborts before activation. Run-scoped staging prevents cross-run contamination.
- Migration and transaction behavior were validated only with worktree-local D1, as required. Remote/staging rollout remains a separate authorized operation.
- This PR stores latest observations, not release vintages or point-in-time availability; PR-08 remains responsible for PIT history.
- This PR does not add provider fallback or divergence handling; PR-07 remains responsible for those behaviors.

## Migration and rollback procedure

### Forward migration

1. Back up the target D1 database using the approved operational procedure.
2. Apply `0006_atomic_ingest.sql` before deploying code that calls the new tables.
3. Confirm the five new structures, the single-ACTIVE index, and the preserved `observations` table.
4. Deploy the worker only after migration success, then verify `/api/health`, a contention response, and one normal ingest run.

No forward production or remote step was performed in this task.

### Code rollback

1. Roll the Worker back to the pre-PR-06 commit.
2. Leave the additive PR-06 tables in place; the old Worker continues to use legacy `observations` and snapshot tables and ignores the new structures.
3. Confirm `observations`, `model_snapshot_weekly`, and `nowcast_snapshot_daily` before reopening refresh traffic.

### Schema rollback, only if explicitly required

Take a backup first. After rolling back the Worker and ensuring no run is active, drop additive objects in dependency order: `staging_observations`, `ingest_series_attempts`, `ingest_lock`, PR-06 indexes, then `ingest_runs`. Do not drop or rewrite `observations`, `model_snapshot_weekly`, `nowcast_snapshot_daily`, or `daily_snapshot`. Dropping run tables destroys audit evidence, so leaving additive schema in place is the preferred rollback.

## Historical-result impact

None expected. The production observation compatibility table keeps the same `(series_id, date, value)` contract, and all historical/backtest/walk-forward/robustness consumers continue to read official snapshot storage. Staging tables are never queried by analytics. No PIT/vintage semantics were introduced.

## Production score and exposure impact

None by design. Champion scoring formulas, factor definitions, weights, thresholds, freshness decisions, verdict hysteresis, guidance, and stress/exposure rules are unchanged. PR-05 channel routing is unchanged: full rebuild writes official weekly snapshots; incremental refresh writes provisional daily nowcasts.

## Commits

- `cf7463ce6505486223aec47f86f730e00f57e7b3` — `feat: add atomic ingest runs and staging activation`
- `9a1a54ec554ebc8b75ef2da8c882906775708f81` — `fix: renew active ingest leases`

This report is committed in a final documentation-only follow-up; its hash is returned in the handoff because a file cannot stably contain the hash of the commit that contains itself.

## Worktree state

The implementation worktree was clean after the two code commits. At report authoring, the only pending artifact is this ignored report file, which must be force-added in the final documentation commit. Final clean-state evidence is recorded in the handoff after that commit.
