# PR-06 Final Lease Fencing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every PR-06 production publication conditional on the database-current, unexpired lease and make successful snapshot publication crash-safe.

**Architecture:** D1 computes acquisition, renewal, and expiry from SQLite `now`; callers supply only the owner and lease duration. Every activation, snapshot, metadata, and snapshot-outcome mutation embeds the same owner/unexpired predicate. Successful snapshot outcome plus all success metadata publish in one fenced `db.batch()` with a terminal SQL assertion so any lost fence rolls the transaction back.

**Tech Stack:** TypeScript, Cloudflare Workers D1, SQLite, Vitest, Miniflare `3.20250718.3`.

## Global Constraints

- Use genuine RED/GREEN TDD for behavior changes.
- Preserve formulas, thresholds, PIT behavior, provider behavior, deployment state, remote D1 state, and PR-05 official/nowcast routing.
- Run focused tests, the full test suite, TypeScript, diff checks, and local-only migrations before committing.

---

### Task 1: Database-current lease lifecycle

**Files:**
- Modify: `test/ingest-db.test.ts`
- Modify: `src/db.ts`
- Modify: `src/service.ts`

**Interfaces:**
- Produces: `acquireIngestLock(db, runId, leaseSeconds)` and `renewIngestLock(db, runId, leaseSeconds)`.

- [ ] **Step 1: Write the failing Miniflare tests**

Add real D1 cases that seed a future lease and reject acquisition, seed an expired lease and allow transfer, and prove renewal of an expired owner returns `false` without changing `expires_at`.

- [ ] **Step 2: Run the RED test**

Run: `env -u NODE_OPTIONS npx vitest run test/ingest-db.test.ts`

Expected: FAIL because the repository still accepts caller timestamps and the old renewal can be driven by a stale captured time.

- [ ] **Step 3: Implement database-current lease SQL**

Use `strftime('%Y-%m-%dT%H:%M:%fZ','now')`, `datetime('now', '+' || ? || ' seconds')`, and `unixepoch(expires_at) > unixepoch('now')`; do not pass acquired/renewed wall-clock timestamps from `service.ts`.

- [ ] **Step 4: Run the GREEN test**

Run: `env -u NODE_OPTIONS npx vitest run test/ingest-db.test.ts`

Expected: PASS.

### Task 2: Fenced activation and snapshot writes

**Files:**
- Modify: `test/ingest-db.test.ts`
- Modify: `test/db.test.ts`
- Modify: `src/db.ts`
- Modify: `src/service.ts`

**Interfaces:**
- Produces: `activateIngestRun(db, runId, completedAt)` with a live-lease predicate on every batch mutation.
- Produces: `upsertOfficialSnapshot(db, runId, snapshot, spx)` and `upsertNowcastSnapshot(db, runId, snapshot, spx)`.

- [ ] **Step 1: Write transferred/expired lease regressions**

Use Miniflare D1 to prove activation cannot promote observations or demote ACTIVE, and both channel writers cannot insert/update snapshots, after the owner is transferred or expired.

- [ ] **Step 2: Run the RED tests**

Run: `env -u NODE_OPTIONS npx vitest run test/ingest-db.test.ts test/db.test.ts`

Expected: FAIL because current activation and channel upserts only check run state or have no fence.

- [ ] **Step 3: Add SQL-local fences and rejected-write errors**

Embed `EXISTS (SELECT 1 FROM ingest_lock WHERE lock_name='fred_ingest' AND owner_run_id=? AND unixepoch(expires_at)>unixepoch('now'))` in every mutation. Check D1 changes and throw a lease-loss error on zero; add a terminal guarded assertion to transactional activation.

- [ ] **Step 4: Run the GREEN tests**

Run: `env -u NODE_OPTIONS npx vitest run test/ingest-db.test.ts test/db.test.ts`

Expected: PASS.

### Task 3: Crash-safe final publication and fenced global metadata

**Files:**
- Modify: `test/ingest-db.test.ts`
- Modify: `test/atomic-ingest.test.ts`
- Modify: `src/db.ts`
- Modify: `src/service.ts`

**Interfaces:**
- Produces: `setIngestMeta(db, runId, key, value)` for individually fenced error/attempt/alert writes.
- Produces: `completeIngestSuccess(db, runId, snapshotCount, completedAt, metaEntries)` for one atomic success batch.

- [ ] **Step 1: Write failing publication regressions**

Use Miniflare to transfer/expire the lease before finalization and assert all success meta keys remain unchanged while `snapshot_state` remains `PENDING`. Add orchestration assertions that the service makes one terminal publication call instead of separate success-meta writes.

- [ ] **Step 2: Run the RED tests**

Run: `env -u NODE_OPTIONS npx vitest run test/ingest-db.test.ts test/atomic-ingest.test.ts`

Expected: FAIL because metadata currently publishes before snapshot success and is not SQL-fenced.

- [ ] **Step 3: Implement atomic publication**

Build one D1 batch containing fenced meta upserts, fenced `PENDING` to `SUCCEEDED`, and a terminal SQL assertion that aborts the batch unless the lease is still owned/unexpired and the run is `ACTIVE/SUCCEEDED`. Route all other ingest metadata through `setIngestMeta`.

- [ ] **Step 4: Run the GREEN tests**

Run: `env -u NODE_OPTIONS npx vitest run test/ingest-db.test.ts test/atomic-ingest.test.ts`

Expected: PASS.

### Task 4: Pending health and series-read audit

**Files:**
- Modify: `test/worker.test.ts`
- Modify: `test/atomic-ingest.test.ts`
- Modify: `src/worker.ts`
- Modify: `src/service.ts`

- [ ] **Step 1: Write failing health and read-failure tests**

Assert an ACTIVE `PENDING` run returns HTTP 503 with `error='snapshot_pending'`. Make `maxObsDate` fail and assert the attempt started first and was closed `FAILED` with `failed_step='series-read'`.

- [ ] **Step 2: Run the RED tests**

Run: `env -u NODE_OPTIONS npx vitest run test/worker.test.ts test/atomic-ingest.test.ts`

Expected: FAIL because health accepts PENDING and attempts start after the series read.

- [ ] **Step 3: Implement minimal ordering/status changes**

Treat every ACTIVE snapshot state other than `SUCCEEDED` as unhealthy with an explicit state-specific error, and wrap the series read in the already-open attempt failure path.

- [ ] **Step 4: Run the GREEN tests**

Run: `env -u NODE_OPTIONS npx vitest run test/worker.test.ts test/atomic-ingest.test.ts`

Expected: PASS.

### Task 5: Dependency, report, and final verification

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `.superpowers/sdd/pr-06-report.md`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Pin the direct test dependency**

Run: `env -u NODE_OPTIONS npm install --save-dev --save-exact miniflare@3.20250718.3`

Expected: `package.json` and lockfile declare the exact compatible direct version.

- [ ] **Step 2: Update RED/GREEN and rollback documentation**

Record the observed failure counts, final verification, no new migration, local-only migration result, atomic-publication rollback behavior, and unchanged PR-05/model scope.

- [ ] **Step 3: Verify everything fresh**

Run: `env -u NODE_OPTIONS npm test`, `env -u NODE_OPTIONS npx tsc --noEmit`, `git diff --check`, and `env -u NODE_OPTIONS npm run migrate:local`.

Expected: all commands exit 0; migrations remain local only.

- [ ] **Step 4: Commit the complete fix**

Run: `git add -f docs/superpowers/plans/2026-07-21-pr-06-final-fencing.md .superpowers/sdd/pr-06-report.md && git add src test package.json package-lock.json CHANGELOG.md && git commit -m "fix: fence atomic ingest publication"`

Expected: one intentional commit and a clean worktree.
