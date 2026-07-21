# PR-06 Implementation Report

## Status

PASS — PR-06 atomic ingest runs and staging activation is implemented and validated locally on branch `codex/pr-06-atomic-ingest`.

No deploy, push, remote D1 access, production mutation, point-in-time storage, provider fallback, Champion formula/weight/factor, 45/55 threshold, or official/nowcast semantic change was performed.

## Design decisions

- `observations` remains the production latest-view compatibility table. Fetching writes only to `staging_observations`; production observations change only inside activation.
- `ingest_runs` records `RUNNING`, `ACTIVE`, `FAILED`, and historical `SUPERSEDED` data state plus an independent durable `snapshot_state` of `PENDING`, `SUCCEEDED`, or `FAILED`, with snapshot completion time, error, and count. A partial unique index enforces at most one `ACTIVE` run.
- Each `ingest_series_attempts` row is created before its fetch. Fetch, structural-validation, and staging failures close it as `FAILED` with the actual failure time and error; successful zero-row responses remain distinguishable from missing/unattempted series and validate only if production already contains that series.
- Staged observations are keyed by `(run_id, series_id, date)` and retain failed-run evidence.
- Lock acquisition is one conditional upsert. A live lease rejects another owner, an expired lease can be acquired, renewal and release are owner-scoped, and `runIngest()` releases in `finally` without masking the primary result.
- The lease is checked after long reads and every external fetch, immediately before activation and every snapshot write, before each success-metadata write, and before snapshot finalization. A lost owner stops before further snapshot writes and cannot overwrite global success metadata.
- Activation uses exactly one transactional D1 `db.batch()`. Promotion and prior-ACTIVE demotion each carry a database-enforced `EXISTS(target RUNNING)` guard, the target transition itself requires `RUNNING`, and a post-result check reports a rejected activation.
- Snapshot rebuilding starts only after activation and reloads `observations`. The ACTIVE run remains the production data run if a post-activation operation fails, while its snapshot outcome becomes durably `FAILED`; full rebuild still writes only `model_snapshot_weekly`, and incremental ingest still writes only `nowcast_snapshot_daily`.
- Manual contention returns HTTP 409. Scheduled contention returns a typed `conflict` result and emits a structured warning rather than appearing successful.
- `/api/health` and `/api/snapshot` expose the current ACTIVE and latest FAILED run with snapshot outcome. An ACTIVE run whose snapshot outcome is `FAILED` makes health return HTTP 503.

## Changed files

### Schema and production code

- `migrations/0006_atomic_ingest.sql` — run, series-attempt, staging, ACTIVE index, lease lock, and legacy ACTIVE bootstrap schema.
- `migrations/0007_ingest_snapshot_outcome.sql` — additive durable snapshot outcome, completion, error, and count fields.
- `src/config.ts` — 15-minute renewable ingest lease duration.
- `src/db.ts` — attempt lifecycle, snapshot outcome, guarded activation, lock lifecycle, validation, failure evidence, and run summaries; removed the unused exported direct production-write bypass.
- `src/service.ts` — pre-fetch attempt auditing, full-run lease checks, guarded activation boundary, post-activation snapshot outcome, actual terminal timestamps, and explicit contention.
- `src/worker.ts` — manual HTTP 409, run/snapshot metadata, and snapshot-failure health status.

### Tests

- `test/atomic-ingest.test.ts` — attempt lifecycle failures, original-error preservation, post-activation lease coverage, durable snapshot outcomes, actual timestamps, and prior atomic-ingest coverage.
- `test/ingest-db.test.ts` — lock semantics, guarded one-batch activation including real SQLite execution, snapshot outcome persistence/summary, validation, and migrations.
- `test/service-channels.test.ts`, `test/service-freshness.test.ts`, `test/service.test.ts` — PR-01–PR-05 service mocks extended for the run repository without weakening assertions.
- `test/worker.test.ts` — HTTP 409, run/snapshot metadata, and ACTIVE snapshot-failure health coverage.

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

### Task-review RED

Command:

```bash
env -u NODE_OPTIONS npx vitest run test/atomic-ingest.test.ts test/ingest-db.test.ts test/worker.test.ts
```

Observed before review-fix production edits:

- 2 test files failed and 1 passed; 15 focused tests failed and 22 passed.
- Expected failures covered missing pre-fetch attempts, unclosed fetch/structural/staging attempts, post-activation lease gaps, absent snapshot outcomes, unguarded activation, missing additive migration, reused start timestamps, and the legacy direct-write export.
- The activation regression executes the generated batch SQL with SQLite and showed that missing and `FAILED` targets previously resolved instead of rejecting.

Additional health RED:

```bash
env -u NODE_OPTIONS npx vitest run test/worker.test.ts -t "ACTIVE run snapshot failure"
```

Result before the health fix: FAIL — a fresh run with `snapshot_state=FAILED` returned HTTP 200 instead of 503.

Task-review focused GREEN:

```bash
env -u NODE_OPTIONS npx vitest run test/atomic-ingest.test.ts test/ingest-db.test.ts test/service-channels.test.ts test/service-freshness.test.ts test/service.test.ts test/worker.test.ts
```

Result: PASS — 6 test files, 47 tests passed, 0 failed.

### Remaining semantic-validation RED/GREEN

Command before the final semantic-validation fix:

```bash
env -u NODE_OPTIONS npx vitest run test/atomic-ingest.test.ts test/ingest-db.test.ts
```

RED result: 4 tests failed and 26 passed. The failures showed that a zero-row `SUCCEEDED` attempt without active history was not invalidated, the run lost `failed_series`, `failSeriesAttempt` accepted only `RUNNING`, and validation errors had no structured series identity.

After adding `IngestSeriesValidationError`, allowing semantic invalidation of `RUNNING` or `SUCCEEDED` attempts, and preserving the original error across audit failure, the same command passed: 2 files, 30 tests, 0 failed.

## Final verification

### Full test suite

Command:

```bash
env -u NODE_OPTIONS npm test
```

Result: PASS — 24 test files, 380 tests passed, 0 failed.

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

Result: PASS — migrations `0001` through `0007` applied successfully to the worktree-local database under `.wrangler/state/v3/d1`. Wrangler explicitly reported local execution; no `--remote` command was used.

Local schema confirmation:

```bash
env -u NODE_OPTIONS npx wrangler d1 execute macro_liquidity --local --command "SELECT name, type FROM sqlite_master WHERE name IN ('ingest_runs','ingest_runs_single_active','ingest_series_attempts','staging_observations','ingest_lock','observations') ORDER BY name"
```

Result: PASS — returned all five PR-06 structures plus legacy `observations`; `PRAGMA table_info(ingest_runs)` returned the four additive snapshot-outcome columns.

## Known limitations

- PR-06 intentionally has no staging/audit retention job. Successful and failed run evidence remains until a future explicit retention policy is introduced.
- Lease ownership is checked after external fetches/long reads and immediately before snapshot or success writes. An external request itself cannot be cancelled by D1 lease expiry, but the returned data is not used for snapshot persistence until ownership is renewed.
- Rows predating migration `0007` remain conservatively `PENDING` unless their run had already failed; historical post-activation snapshot success cannot be reconstructed truthfully from the old schema.
- Migration and transaction behavior were validated only with worktree-local D1, as required. Remote/staging rollout remains a separate authorized operation.
- This PR stores latest observations, not release vintages or point-in-time availability; PR-08 remains responsible for PIT history.
- This PR does not add provider fallback or divergence handling; PR-07 remains responsible for those behaviors.

## Migration and rollback procedure

### Forward migration

1. Back up the target D1 database using the approved operational procedure.
2. Apply `0006_atomic_ingest.sql`, then additive `0007_ingest_snapshot_outcome.sql`, before deploying code that calls the new fields.
3. Confirm the five PR-06 structures, four snapshot-outcome columns, the single-ACTIVE index, and the preserved `observations` table.
4. Deploy the worker only after migration success, then verify `/api/health`, a contention response, and one normal ingest run.

No forward production or remote step was performed in this task.

### Code rollback

1. Roll the Worker back to the pre-PR-06 commit.
2. Leave the additive PR-06 tables in place; the old Worker continues to use legacy `observations` and snapshot tables and ignores the new structures.
3. Confirm `observations`, `model_snapshot_weekly`, and `nowcast_snapshot_daily` before reopening refresh traffic.

### Schema rollback, only if explicitly required

Take a backup first. The preferred rollback leaves both additive migrations in place because older code ignores them. Removing `0007` columns requires a SQLite table rebuild and destroys snapshot audit evidence; do not attempt it as an incident response shortcut. If the entire PR-06 schema must be removed after Worker rollback and with no active run, drop additive objects in dependency order: `staging_observations`, `ingest_series_attempts`, `ingest_lock`, PR-06 indexes, then `ingest_runs`. Do not drop or rewrite `observations`, `model_snapshot_weekly`, `nowcast_snapshot_daily`, or `daily_snapshot`.

## Historical-result impact

None expected. The production observation compatibility table keeps the same `(series_id, date, value)` contract, and all historical/backtest/walk-forward/robustness consumers continue to read official snapshot storage. Staging tables are never queried by analytics. No PIT/vintage semantics were introduced.

## Production score and exposure impact

None by design. Champion scoring formulas, factor definitions, weights, thresholds, freshness decisions, verdict hysteresis, guidance, and stress/exposure rules are unchanged. PR-05 channel routing is unchanged: full rebuild writes official weekly snapshots; incremental refresh writes provisional daily nowcasts.

## Commits

- `cf7463ce6505486223aec47f86f730e00f57e7b3` — `feat: add atomic ingest runs and staging activation`
- `9a1a54ec554ebc8b75ef2da8c882906775708f81` — `fix: renew active ingest leases`
- `a444bf7` — `docs: add PR-06 implementation report`
- `f931617` — `fix: harden atomic ingest completion`

The task-review fix commit hash is returned in the handoff because a file cannot stably contain the hash of the commit that contains itself.

## Worktree state

Final clean-state command, executed after the review-fix commit:

```bash
git status --short
```

Result: PASS — no output. The final worktree was clean, with no unrelated or `package-lock.json` churn.
