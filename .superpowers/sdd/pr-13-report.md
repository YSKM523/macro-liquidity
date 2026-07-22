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
