# Operations Runbook

## Environment boundaries

`dev`, `staging`, and `production` are explicit Wrangler environments. The staging D1 identifier is intentionally `REPLACE_WITH_STAGING_D1`; replace it through an authorized infrastructure change before any staging deploy. Production deploy is available only through the manual GitHub workflow protected by the `production` environment. A code SHA is injected at deployment; the production wrapper refuses missing or malformed SHA values.

## Local release gates

Run `npm ci`, `npm run typecheck`, `npm run lint`, `npm test`, `npm run test:correctness`, `npm run test:no-lookahead`, `npm run test:rebuild-consistency`, `npm run migrate:verify`, `npm run restore:drill`, and `npm run deploy:dry`. The dry deploy validates the bundle only and is not staging evidence.

## Production deployment

Use the protected manual workflow. It applies all remote production D1 migrations before application deployment and injects the immutable `${{ github.sha }}` as `CODE_COMMIT_SHA`. The `npm run deploy` wrapper repeats the migration gate and requires all of `--execute`, `--confirm-production=DEPLOY_PRODUCTION`, and `--schema-confirmed=0010`; direct or partial invocations fail closed. Do not substitute a branch name or local sentinel for the commit SHA.

## Admin refresh

Use either legacy `Authorization: Bearer …` or exact Cloudflare Access service-token headers. Prefer Access in managed environments and rotate tokens outside the repository. The Cloudflare Access service-token policy must be scoped to the production hostname, exact `/api/admin/refresh` path, and `POST`; the Worker recognizes only the configured service-token header pair and does not infer roles or trust identity headers/JWT claims. Deployment and backup API tokens are separate roles and must not be accepted by the application route.

Every attempt, authorized or not, first consumes an atomic D1 rate-limit reservation keyed by a SHA-256 digest of `CF-Connecting-IP` (or one shared `unknown` bucket when absent). Authorization and audit writes occur only after that reservation; a rejected reservation is audited as `NOT_EVALUATED`. Credentials, raw IPs, and request tokens are never bucket keys or audit fields. An incremental refresh is:

```text
POST /api/admin/refresh
```

A full rebuild additionally requires `?all=1` and the exact header:

```text
x-confirm-full-rebuild: FULL_REBUILD
```

The D1 lease remains the write-concurrency fence. `409` means another owner holds it; `428` means the full-rebuild confirmation is absent. Never retry a full rebuild blindly.

## Structured logs and SLOs

Search JSON logs by `event`, `run_id`, `request_id`, and stable `error_code`. Key events are `ingest_start`, `ingest_series_attempt`, `snapshot_publication`, `ingest_complete`, `ingest_lock_contention`, `admin_refresh`, `alert_delivery`, and `request_failure`. Secret-shaped keys and credential patterns embedded inside strings/nested objects are redacted, and values are bounded. Client error responses contain only a generic error, stable code, and request ID; investigate details in redacted server logs. Targets are page availability 99.9%, post-release ingest success 99%, and mandatory critical-snapshot alerting.

For an ingest incident: check `/api/health`, ACTIVE `snapshot_state`, latest failed run, per-series event, then alert outcome. `SKIPPED` means provider configuration is absent; `FAILED` means delivery was attempted but not accepted. Correct configuration through the secret manager; never place credentials in logs or Git.

Live price/stress reads use short stale-while-revalidate service: a bounded stale value returns immediately while `waitUntil` refreshes in the background. Stale or failed stress is always presented as `UNKNOWN`, never actionable `NORMAL`; after the stale bound or open circuit, the endpoint remains fail-closed. Empty v1 snapshot responses still carry `api_version`, `live_cache`, stable error metadata, and `request_id`.

## Backup

`npm run backup:dry` is non-mutating. Execute mode requires `--execute`, exact `--env`, `BACKUP_R2_BUCKET`, and for production `--confirm-production=BACKUP_PRODUCTION`. Daily critical export contains governed snapshot fields; weekly full export is uploaded to R2. D1 commands explicitly use `--remote`; Wrangler R2 object commands do not support or receive that flag. The protected `production-backup` environment owns authorization and retention policy.

## Restore

`npm run restore:drill` applies migrations 0001–0010 to an ephemeral source D1, seeds representative governed data, produces a full schema/data SQL export, and restores it into a second ephemeral D1. It compares tables, indexes, triggers, every table row count, migration metadata, governed snapshot fields, application queries, and an exact repeated-space/newline value. It then canonically re-exports the restored database and requires exact full-content SHA-256 equality with the source export, detecting differences outside sampled application queries. The SQL splitter preserves quoted data and comments; it never folds whitespace globally. Both runtimes are then destroyed. Before restoring a real backup, verify checksum and provenance, restore to an isolated non-production database, run the same invariants plus domain-specific counts, obtain approval, and only then plan a cutover. Never overwrite production in place.

## Rollback

Application rollback is a reviewed deployment of the prior known-good commit. Migration 0010 is additive and must not be reversed by dropping columns or deleting audits. If versioned writes fail, stop ingest or roll forward. Cache/alert/admin code can be reverted independently of persisted metadata.
