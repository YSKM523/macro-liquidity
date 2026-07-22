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
