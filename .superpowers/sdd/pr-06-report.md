# PR-06 Implementation Report

## Status

PASS — PR-06 atomic ingest runs and staging activation is implemented and validated locally on branch `codex/pr-06-atomic-ingest`.

No deploy, push, remote D1 access, production mutation, point-in-time storage, provider fallback, Champion formula/weight/factor, 45/55 threshold, or official/nowcast semantic change was performed.

## Design decisions

- `observations` remains the production latest-view compatibility table. Fetching writes only to `staging_observations`; production observations change only inside activation.
- `ingest_runs` records `RUNNING`, `ACTIVE`, `FAILED`, and historical `SUPERSEDED` data state plus an independent durable `snapshot_state` of `PENDING`, `SUCCEEDED`, or `FAILED`, with snapshot completion time, error, and count. A partial unique index enforces at most one `ACTIVE` run.
- Each `ingest_series_attempts` row is created before the production-history read. Series-read, fetch, structural-validation, and staging failures close it as `FAILED` with the actual failure time and error; successful zero-row responses remain distinguishable from missing/unattempted series and validate only if production already contains that series.
- Staged observations are keyed by `(run_id, series_id, date)` and retain failed-run evidence.
- Lock acquisition and renewal derive both current time and expiry inside D1; callers provide only the owner and duration. A live lease rejects another owner, an expired lease can be acquired but cannot be renewed/resurrected, release is owner-scoped, and `runIngest()` releases in `finally` without masking the primary result.
- Every activation mutation, official/nowcast upsert, snapshot-outcome mutation, and global ingest-meta write embeds the same database-current `owner_run_id` and unexpired-lease fence. A stale former owner receives zero changes/an error even if it renewed before being suspended past expiry and replaced.
- Activation uses exactly one transactional D1 `db.batch()`. Promotion, prior-ACTIVE demotion, and target activation each carry database-enforced run-state plus live-lease guards. A terminal assertion executes inside the batch, so ownership loss between statements raises a SQL error and rolls back earlier mutations.
- Snapshot rebuilding starts only after activation and reloads `observations`. The full success meta set and `snapshot_state=SUCCEEDED` publish in one fenced D1 batch with an in-batch terminal assertion, so metadata can never report success while the ACTIVE outcome remains `PENDING`. Full rebuild still writes only `model_snapshot_weekly`, and incremental ingest still writes only `nowcast_snapshot_daily`.
- Manual contention returns HTTP 409. Scheduled contention returns a typed `conflict` result and emits a structured warning rather than appearing successful.
- `/api/health` and `/api/snapshot` expose the current ACTIVE and latest FAILED run with snapshot outcome. Every ACTIVE outcome other than `SUCCEEDED`, including `PENDING`, makes health return HTTP 503 with an explicit reason.

## Changed files

### Schema and production code

- `migrations/0006_atomic_ingest.sql` — run, series-attempt, staging, ACTIVE index, lease lock, and legacy ACTIVE bootstrap schema.
- `migrations/0007_ingest_snapshot_outcome.sql` — additive durable snapshot outcome, completion, error, and count fields.
- `src/config.ts` — 15-minute renewable ingest lease duration.
- `src/db.ts` — database-current lock lifecycle, SQL-local production fences, in-batch activation/success assertions, attempt lifecycle, validation, failure evidence, and run summaries; removed unfenced success/meta mutation entry points.
- `src/service.ts` — pre-series-read attempt auditing, fenced snapshot routing, atomic success publication, actual terminal timestamps, and explicit contention.
- `src/worker.ts` — manual HTTP 409, run/snapshot metadata, and non-success ACTIVE snapshot health status.

### Tests

- `test/atomic-ingest.test.ts` — attempt-before-series-read ordering, original-error preservation, atomic success orchestration, post-activation lease coverage, durable snapshot outcomes, and prior atomic-ingest coverage.
- `test/ingest-db.test.ts` — real Miniflare D1 database-current lock semantics, transferred/expired activation and finalization fences, mid-batch ownership-transfer rollback, snapshot outcome persistence/summary, validation, and migrations.
- `test/db.test.ts` — real Miniflare D1 transferred/expired official and nowcast snapshot-write fences plus preserved PR-05 channel contracts.
- `test/service-channels.test.ts`, `test/service-freshness.test.ts`, `test/service.test.ts` — PR-01–PR-05 service mocks extended for the run repository without weakening assertions.
- `test/worker.test.ts` — HTTP 409, run/snapshot metadata, and ACTIVE FAILED/PENDING health coverage.
- `package.json`, `package-lock.json` — exact direct Miniflare `3.20250718.3` dev dependency used by the D1 regressions.

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

### Final-review database-time and fencing RED/GREEN

Database-current lease RED:

```bash
env -u NODE_OPTIONS npx vitest run test/ingest-db.test.ts
```

Result before production edits: 3 failed, 11 passed. The SQL had no database `now`, acquisition still required caller timestamps, and real Miniflare rejected the new duration-only calls; expired renewal could not satisfy the no-resurrection contract.

Activation and snapshot-write fence RED:

```bash
env -u NODE_OPTIONS npx vitest run test/ingest-db.test.ts test/db.test.ts
```

Result before production edits: 9 failed, 22 passed. A transferred or expired owner could still activate staging and the official/nowcast writers had no owner argument or SQL fence; activation had only three mutations and no in-batch terminal assertion.

Crash-safe success publication RED:

```bash
env -u NODE_OPTIONS npx vitest run test/ingest-db.test.ts
```

Result before production edits: 5 failed, 15 passed. There was no fenced global-meta primitive or atomic success publication operation. The added Miniflare trigger transfers the lease immediately after the first success-meta insert to prove the terminal assertion runs inside the same batch and rolls every earlier change back.

Series-read and health RED:

```bash
env -u NODE_OPTIONS npx vitest run test/atomic-ingest.test.ts test/worker.test.ts
```

Result before production edits: 3 failed, 26 passed. `maxObsDate` failed before the attempt existed, success meta used separate calls, and ACTIVE `PENDING` health returned 200.

Focused GREEN:

```bash
env -u NODE_OPTIONS npx vitest run test/atomic-ingest.test.ts test/ingest-db.test.ts test/db.test.ts test/worker.test.ts test/service-channels.test.ts test/service-freshness.test.ts test/service.test.ts
```

Result: PASS — 7 files, 74 tests passed, 0 failed, including all real Miniflare transferred/expired and mid-batch rollback cases.

## Final verification

### Full test suite

Command:

```bash
env -u NODE_OPTIONS npm test
```

Result: PASS — 24 test files, 393 tests passed, 0 failed.

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

Result: PASS — Wrangler explicitly reported local execution and `No migrations to apply!`; the worktree-local database under `.wrangler/state/v3/d1` already has migrations `0001` through `0007`. No `--remote` command was used.

Local schema confirmation:

```bash
env -u NODE_OPTIONS npx wrangler d1 execute macro_liquidity --local --command "SELECT name, type FROM sqlite_master WHERE name IN ('ingest_runs','ingest_runs_single_active','ingest_series_attempts','staging_observations','ingest_lock','observations') ORDER BY name"
```

Result: PASS — returned all five PR-06 structures plus legacy `observations`; `PRAGMA table_info(ingest_runs)` returned the four additive snapshot-outcome columns.

## Known limitations

- PR-06 intentionally has no staging/audit retention job. Successful and failed run evidence remains until a future explicit retention policy is introduced.
- An external request itself cannot be cancelled by D1 lease expiry. Every later production mutation independently rechecks the database-current live owner in its own SQL, so returned data cannot be published by an expired or replaced owner.
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

The final-review fencing pass adds no migration. It reuses the `ingest_lock` and snapshot-outcome schema from `0006`/`0007`; only the direct Miniflare test dependency changes the package manifest and lockfile.

### Code rollback

1. Roll the Worker back to the pre-PR-06 commit.
2. Leave the additive PR-06 tables in place; the old Worker continues to use legacy `observations` and snapshot tables and ignores the new structures.
3. Confirm `observations`, `model_snapshot_weekly`, and `nowcast_snapshot_daily` before reopening refresh traffic.

Because success metadata and `snapshot_state=SUCCEEDED` now commit in one batch, rollback is code-only for this final hardening pass. There is no fence-specific schema object to remove.

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
- `4109599` — `fix: audit semantic ingest failures`
- `cbc4725` — `fix: fence atomic ingest publication`

The final verification/report follow-up commit hash is returned in the handoff because a file cannot stably contain the hash of the commit that contains itself.

## Worktree state

Final clean-state command, executed after the verification/report follow-up commit:

```bash
git status --short
```

Result: PASS — no output. The final worktree was clean, with no unrelated or `package-lock.json` churn.
