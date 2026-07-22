# PR-13 Verification Report

Base: `29e84a3`

No push, deploy, remote D1/R2 access, secret creation, or real alert delivery was performed.

## TDD evidence

### Stage 1 — model identity and snapshot metadata

- RED: `env -u NODE_OPTIONS npx vitest run test/model-version.test.ts` — 1 suite failed before collection because `src/model-version.ts` did not exist.
- Intermediate regression evidence: focused model/DB/service run exposed 13 failures caused by relying on unavailable Node `crypto`, then 5 failures from stale test schemas/assertions. Replaced the runtime dependency with a Workers/Node-neutral SHA-256 implementation and updated fixtures for the additive columns.
- GREEN: `env -u NODE_OPTIONS npx vitest run test/model-version.test.ts test/db.test.ts test/service.test.ts` — 3 files, 25 tests passed; `env -u NODE_OPTIONS npx tsc --noEmit` passed.

### Stage 2 — v1 API, schema validation, and export

- RED: `env -u NODE_OPTIONS npx vitest run test/api-schema.test.ts` — 1 suite failed before collection because `src/api-schema.ts` did not exist.
- GREEN: `env -u NODE_OPTIONS npx vitest run test/api-schema.test.ts test/worker.test.ts test/db.test.ts` — 3 files, 43 tests passed; `env -u NODE_OPTIONS npx tsc --noEmit` passed.
- Covered strict date ranges, version metadata fail-closed behavior, CSV injection/escaping, `/api/v1/snapshot`, `/api/v1/backtest`, `/api/v1/robustness`, `/api/v1/model`, export, and unchanged legacy routes.

### Stage 3 — observability, admin safety, alerts, and live cache

- RED: `env -u NODE_OPTIONS npx vitest run test/operations.test.ts` — 1 suite failed before collection because `src/operations.ts` did not exist.
- Intermediate regression evidence: the first integrated run exposed 3 compatibility failures (legacy warning assertion, uncleared admin mock, cache clock reversal). Structured warning content, test isolation, and negative-age invalidation were corrected.
- GREEN: `env -u NODE_OPTIONS npx vitest run --silent test/operations.test.ts test/worker.test.ts test/service.test.ts test/service-channels.test.ts test/service-freshness.test.ts test/atomic-ingest.test.ts` — 6 files, 65 tests passed; `env -u NODE_OPTIONS npx tsc --noEmit` passed.
- Covered secret redaction/error bounds, structured lifecycle logs, SLO fields, Access service-token and legacy bearer auth, mandatory full-rebuild confirmation, admin audit, injectable alert outcomes/audit, short live cache, bounded stale service, and circuit fail-closed behavior.

### Stage 4 — backup command safety and local restore drill

- RED: `env -u NODE_OPTIONS npx vitest run test/backup-restore.test.ts` — 3/3 tests failed because backup and restore commands did not exist.
- Intermediate regression evidence: the first local restore run failed because raw multiline SQL was not accepted by the Miniflare D1 executor; comments/whitespace are normalized before import without changing the verified source hash.
- GREEN: `env -u NODE_OPTIONS npx vitest run test/backup-restore.test.ts` — 1 file, 3 tests passed; `env -u NODE_OPTIONS node scripts/restore-drill.mjs` returned `PASS`, verified 3 required tables, expected row counts, governed latest snapshot, and SHA-256 `10ec6bdc379ce958818b4c0efe4e6645ae027d5eceeaa1c8ee430e6858f4a730`.
- Backup remained dry-run only. No `--execute`, remote D1, or R2 path was invoked.

### Stage 5 — CI, environments, workflows, and governance docs

- RED: `env -u NODE_OPTIONS npx vitest run test/production-governance.test.ts` — 4/4 tests failed for absent scripts, environments, workflows, and governance documents.
- GREEN: `env -u NODE_OPTIONS npx vitest run test/production-governance.test.ts test/worker.test.ts` — 2 files, 30 tests passed; `npm run typecheck` and `npm run lint` passed.
- `npm run migrate:verify` returned `PASS`: migrations 0001–0010 applied to a fresh temporary local D1, and the second run reported `No migrations to apply`.
- `npm run deploy:dry` bundled successfully for staging and exited at `--dry-run`; output retained the explicit `REPLACE_WITH_STAGING_D1` placeholder. This is not a staging deployment.
- `npm run restore:drill` returned `PASS`; `npm run backup:dry` returned `DRY_RUN` with `remoteWrites:false`.
- Production workflow is manual-only and references the protected `production` environment. No workflow was pushed or executed.

## Final verification

### Review remediation 1 — joint legacy/governed provenance and write invariants

- RED: focused API/worker/DB tests failed because legacy v1 history returned 503, provenance normalization did not exist, and snapshot writers accepted omitted provenance far enough to touch D1.
- GREEN: `env -u NODE_OPTIONS npx vitest run test/api-schema.test.ts test/db.test.ts test/worker.test.ts test/pit-snapshot-db.test.ts` — 4 files, 54 tests passed; `npm run typecheck`, `npm run lint`, and `git diff --check` passed.
- V1 backtest, robustness, and export now report joint governed/legacy completeness without inventing legacy identity. Official/nowcast writers require explicit provenance and the ungoverned write fallback was removed. CSV formula defense is string-only, preserving numeric negatives.

### Review remediation 2 — complete Champion configuration identity

- RED: `npx vitest run test/model-version.test.ts` failed 2/5 because the full frozen descriptor and digest helpers did not exist.
- GREEN: focused model/metrics/portfolio/service/walk-forward/robustness verification passed 6 files / 130 tests; `npm run typecheck`, `npm run lint`, and `git diff --check` passed.
- All scoring bounds, blends, lookbacks, quality gates, verdict bands, stress/exposure mappings, freshness, event accounting, and market-data gates now live in one recursively frozen descriptor consumed at runtime. The initial golden SHA-256 matched Node `crypto`; the expanded final event-backtest identity is recorded under re-review remediation 6. Existing formula-output tests remained green.

### Review remediation 3 — fail-closed production deployment

- RED: production-governance test failed because the workflow had no remote migration gate and `npm run deploy` called Wrangler directly.
- GREEN: governance tests passed 4/4; typecheck, lint, and diff check passed. An unconfirmed `npm run deploy` returned `REFUSED` with nonzero status and invoked neither migration nor deployment.
- The protected workflow applies production migrations before deployment, passes `${{ github.sha }}`, and calls a guarded wrapper. The wrapper validates explicit production/schema confirmation, a 40-character commit SHA, credentials, and also reapplies migrations before Wrangler deploy so direct invocation cannot skip schema.

### Review remediation 4 — realistic exact-semantics restore drill

- RED: backup/restore test failed because the old fixture-only drill did not report complete migrations, schema objects, application checks, or the whitespace regression.
- GREEN: `npx vitest run test/backup-restore.test.ts` passed 3/3; standalone restore returned `PASS`; typecheck, lint, and diff check passed.
- The drill now applies migrations 0001–0010 to a source D1, seeds representative data, generates a schema/data SQL export, restores into a second D1, and compares all tables, indexes, triggers, table counts, migration metadata, governed metadata, and application queries. Its quote/comment-aware splitter never folds SQL whitespace; `alpha␠␠beta\n␠gamma` round-trips exactly.

### Review remediation 5 — content redaction and stable public errors

- RED: focused operations/worker tests failed because credentials embedded in an exception value reached logs and a rejected static-assets promise bypassed the outer catch.
- GREEN: operations/worker tests passed 2 files / 39 tests; typecheck, lint, and diff check passed.
- Structured logging now recursively sanitizes nested values and redacts bearer/key/token/password/secret content, not only secret-shaped field names. Unexpected and schema/DB errors emit stable server `error_code` values and return generic client errors with `request_id`; raw exception text is never returned. Static asset fetch is awaited inside the error boundary.

### Review remediation 6 — atomic pre-authentication admin throttling

- RED: focused operations/DB/worker tests failed because no opaque source bucket or atomic reservation existed and unauthorized attempts bypassed the old audit-count limit.
- GREEN: focused tests passed 3 files / 56 tests, including 20 concurrent reservations admitting exactly 5. Typecheck, lint, migrations 0001–0010 plus second no-op, restore drill, and diff check passed.
- Migration 0010 now creates `admin_rate_limit_buckets`; one UPSERT/RETURNING statement atomically reserves capacity before authentication and audit work. All attempts share the limit, and bucket keys are SHA-256 digests of the transport source only. The runbook now defines the Access hostname/path/method boundary, exact service-token semantics, and separation from deploy/backup roles.

### Review remediation 7 — executable backup command coverage

- RED: fake-`npx` execute-path test failed because the R2 object command received unsupported `--remote`.
- GREEN: backup/restore tests passed 4/4, including actual child-process command capture; typecheck, lint, and diff check passed.
- D1 export/execute retains `--remote`; R2 object upload no longer receives it. The test uses a temporary executable `npx`, performs the critical backup path, captures both command arrays, verifies the D1/R2 distinction, and performs no network or remote write.

### Review remediation 8 — stale-while-revalidate and no-data metadata

- RED: operations/worker tests failed because no background-refresh API existed and empty v1 snapshots omitted version/cache metadata.
- GREEN: focused operations/worker tests passed 2 files / 43 tests; typecheck, lint, and diff check passed.
- Worker requests now return bounded stale live values immediately while `ExecutionContext.waitUntil` refreshes the deduplicated cache in the background; cache failures still count toward the circuit and stale stress remains `UNKNOWN`. Empty v1 snapshot responses preserve `api_version`, `live_cache`, stable error code, and `request_id`.

Snapshot writer hardening was completed in remediation 1: every official/nowcast write requires provenance and the legacy fallback write path was deleted.

### Re-review remediation 1 — legacy current snapshot provenance

- RED: worker test returned 503 for a migration-backfilled legacy official row on `/api/v1/snapshot`.
- GREEN: worker/API-schema tests passed 2 files / 37 tests; typecheck, lint, and diff check passed.
- V1 current official/nowcast rows now use the same `LEGACY`/`GOVERNED` normalization and joint provenance summary as historical endpoints. Unknown legacy identity/provenance fields are null; partial mixed identity still fails closed.

### Re-review remediation 2 — canonical restored export equality

- RED: backup/restore tests failed because the drill exposed no restored content hash and ignored intentional corruption of a non-sampled `release_calendar.source_url` value.
- GREEN: backup/restore tests passed 5/5; typecheck, lint, and diff check passed.
- Table rows are canonically ordered for export. After restore, the second D1 is re-exported and its complete schema/all-table-data SHA-256 must exactly equal the source export. The negative corruption drill exits nonzero with `restored export content hash mismatch`.

### Re-review remediation 3 — checked-out production deployment identity

- RED: production-governance tests showed that a different valid 40-hex SHA or dirty tracked source progressed to the fake migration command.
- GREEN: governance tests passed 6/6; typecheck, lint, and diff check passed.
- Before any Wrangler command, the wrapper now requires `CODE_COMMIT_SHA === git rev-parse HEAD` and an empty tracked-only Git status. Mismatch/dirty tests use a temporary Git repository and fake `npx`, proving no migration/deploy command is reached.

### Re-review remediation 4 — bounded concurrency-test budget

- Review-load RED evidence: the atomic reservation test exceeded Vitest's default 5-second timeout at approximately 6.5 seconds.
- The test retains 12 simultaneous reservations against a limit of 5, adds an explicit 30-second integration-test budget, and disposes Miniflare in `finally`.

### Re-review remediation 5 — exact event-time model provenance cohort

- RED: focused worker and event-time D1 tests failed because the v1 response derived `snapshot_models` from unfiltered legacy diagnostic rows and the strict `as_of` signal query omitted model identity columns.
- GREEN: `env -u NODE_OPTIONS npx vitest run --silent test/worker.test.ts test/event-backtest-db.test.ts` passed 2 files / 40 tests; typecheck, lint, and diff check passed.
- `loadEventBacktestInputs` now returns each cutoff-visible signal's persisted model/config/commit/data cutoff/creation identity. V1 backtest provenance and governed model identities are derived only from that exact replay cohort; unrelated history cannot leak into the response, while complete legacy triples remain honestly normalized as `LEGACY`.

### Re-review remediation 6 — complete event-backtest configuration identity

- RED: the new model-version regression failed because the descriptor omitted the legacy compatibility threshold, 20/200-session benchmark windows, 10% volatility target, exposure cap, 252-session annualization, ACT/360 and percent/bps conversion constants, and reporting methodologies.
- GREEN: focused model/event/portfolio/worker verification passed 4 files / 82 tests; typecheck, lint, and diff check passed.
- Runtime code now consumes every added field, including the zero-volatility cap and formal methodology checks. The recursively frozen canonical descriptor's final SHA-256 is `17ad1ca8854b0fbd8e56d6255b7ee2f4fe8a85ae1a95a328ade46ffdff02a0cf`; Node `crypto` equality and per-field numeric drift are covered. Scores, weights, 45/55 bands, and all existing formula outputs are unchanged.

- First full-suite run: 3 regressions in `pit-snapshot-db.test.ts`; its local database fixture stopped at migration 0009, so new snapshot writers correctly rejected absent 0010 columns. All current-schema fixtures were advanced to 0010.
- Regression rerun: `env -u NODE_OPTIONS npx vitest run --silent test/pit-snapshot-db.test.ts test/pit-db.test.ts test/event-backtest-db.test.ts` passed.
- Lint compliance RED: focused governance test rejected `lint` because it aliased `tsc`; an actual ESLint 9 + TypeScript parser/plugin flat config was added. `npm run lint` now performs bounded static analysis across `src` and `test` with zero warnings and passes.
- Live-cache safety RED: focused operations suite failed before collection because `src/live-data.ts` did not exist. Typed non-OK provider results and `UNKNOWN` stress now throw through the cache loader (incrementing the circuit), stale/failed stress is forced to `UNKNOWN`, and an open circuit preserves the typed fail-closed payload. Focused operations/governance tests pass 13/13; worker regression tests pass 26/26; typecheck and ESLint pass.
- Fresh full suite before the final persisted-identity hardening: 53 files / 667 tests passed. After adding the exact v1 backtest persisted-model identity contract, focused model/DB/worker passed 47/47 and ESLint/typecheck passed. A final all-suite run is recorded below.
- FINAL REVIEW REMEDIATION: `npm test -- --silent` — 53 files / 685 tests passed. `npm run typecheck`, real `npm run lint`, correctness (79/79), no-lookahead (42/42), rebuild consistency (5/5), migrations 0001–0010 + second no-op, full-schema restore drill with identical source/restored SHA-256 `4f34f735723ad38f6746f9382979a84bf7fe5cb9be53a343d758e9f15d08424a`, staging deploy dry-run, backup dry-run, and `git diff --check` all passed. Wrangler emitted only its existing version-update warning. No production deploy, remote D1/R2 call, secret change, or real alert occurred.
