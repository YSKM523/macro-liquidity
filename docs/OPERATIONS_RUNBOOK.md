# Operations Runbook

## Environment boundaries

`dev`, `staging`, and `production` are explicit Wrangler environments. The staging D1 identifier is intentionally `REPLACE_WITH_STAGING_D1`; replace it through an authorized infrastructure change before any staging deploy. Production deploy is available only through the manual GitHub workflow protected by the `production` environment. A code SHA is injected at deployment; the production wrapper refuses missing or malformed SHA values.

## Local release gates

Run `npm ci`, `npm run typecheck`, `npm run lint`, `npm test`, `npm run test:correctness`, `npm run test:no-lookahead`, `npm run test:rebuild-consistency`, `npm run migrate:verify`, `npm run restore:drill`, and `npm run deploy:dry`. The dry deploy validates the bundle only and is not staging evidence.

## Production deployment

Use the protected manual workflow. It applies all remote production D1 migrations before application deployment and injects the immutable `${{ github.sha }}` as `CODE_COMMIT_SHA`. The `npm run deploy` wrapper repeats the migration gate and requires all of `--execute`, `--confirm-production=DEPLOY_PRODUCTION`, and `--schema-confirmed=0010`; direct or partial invocations fail closed. Do not substitute a branch name or local sentinel for the commit SHA.

## Admin refresh

Use either legacy `Authorization: Bearer …` or exact Cloudflare Access service-token headers. Prefer Access in managed environments and rotate tokens outside the repository. Every attempt is audited without storing credentials. An incremental refresh is:

```text
POST /api/admin/refresh
```

A full rebuild additionally requires `?all=1` and the exact header:

```text
x-confirm-full-rebuild: FULL_REBUILD
```

The D1 lease remains the write-concurrency fence. `409` means another owner holds it; `428` means the full-rebuild confirmation is absent. Never retry a full rebuild blindly.

## Structured logs and SLOs

Search JSON logs by `event` and `run_id`. Key events are `ingest_start`, `ingest_series_attempt`, `snapshot_publication`, `ingest_complete`, `ingest_lock_contention`, `admin_refresh`, `alert_delivery`, and `request_failure`. Secret-shaped keys are redacted and errors are bounded. Targets are page availability 99.9%, post-release ingest success 99%, and mandatory critical-snapshot alerting.

For an ingest incident: check `/api/health`, ACTIVE `snapshot_state`, latest failed run, per-series event, then alert outcome. `SKIPPED` means provider configuration is absent; `FAILED` means delivery was attempted but not accepted. Correct configuration through the secret manager; never place credentials in logs or Git.

## Backup

`npm run backup:dry` is non-mutating. Execute mode requires `--execute`, exact `--env`, `BACKUP_R2_BUCKET`, and for production `--confirm-production=BACKUP_PRODUCTION`. Daily critical export contains governed snapshot fields; weekly full export is uploaded to R2. The protected `production-backup` environment owns authorization and retention policy.

## Restore

`npm run restore:drill` imports the committed SQL fixture into ephemeral local D1, verifies its SHA-256, required tables, row counts, and latest governed snapshot, then destroys only the temporary runtime. Before restoring a real backup, verify checksum and provenance, restore to an isolated non-production database, run the same invariants plus domain-specific counts, obtain approval, and only then plan a cutover. Never overwrite production in place.

## Rollback

Application rollback is a reviewed deployment of the prior known-good commit. Migration 0010 is additive and must not be reversed by dropping columns or deleting audits. If versioned writes fail, stop ingest or roll forward. Cache/alert/admin code can be reverted independently of persisted metadata.
