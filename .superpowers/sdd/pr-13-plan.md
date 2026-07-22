# PR-13 Production Governance Plan

Base: `29e84a3`

Branch: `codex/pr-13-production-governance`

Scope: close the locally implementable Phase 6 engineering/governance gates without changing Champion formulas, weights, thresholds, hysteresis, portfolio policy, or historical research results. No GitHub push, Cloudflare deployment, remote D1/R2 mutation, secret creation, or alert delivery to real recipients is authorized in this PR.

## Frozen model identity

- Define one canonical Champion model descriptor covering scoring-relevant constants, freshness rules, decision bands, stress policy, portfolio tiers, and event-backtest assumptions.
- Derive a deterministic SHA-256 `config_hash` from canonical JSON. Expose `model_version`, `config_hash`, `code_commit_sha`, `data_run_id`, `data_cutoff`, `decision_at`, and `created_at` on every newly written official/nowcast snapshot.
- `code_commit_sha` comes from a validated deployment binding; local/unconfigured runs use an explicit non-production sentinel and never impersonate a Git commit.
- Additive migration `0010` backfills existing rows as `LEGACY_UNVERSIONED`; immutable PIT values and all scoring columns remain unchanged.

## Versioned/schema-validated APIs

- Keep existing routes backward-compatible and add `/api/v1/snapshot`, `/api/v1/backtest`, `/api/v1/robustness`, `/api/v1/model`, and JSON/CSV official-snapshot export.
- Add equivalent runtime validation for query inputs and outbound model/version metadata. Existing provider parsers remain authoritative for FRED/Yahoo; tests must prove malformed provider/API payloads fail closed.
- Preserve append-only `as_of` event-time replay through the v1 backtest route. Model metadata must identify the exact config/code/data cutoff used by returned snapshots.

## CI and environment separation

- Add reproducible npm scripts for typecheck, lint, focused no-lookahead, full-vs-incremental consistency, local migration verification, restore drill, and deploy dry-run.
- Add GitHub CI for `npm ci`, typecheck, lint, all tests, focused correctness gates, fresh migrations plus immediate no-op, restore drill, and staging deploy dry-run.
- Define explicit dev/staging/production Wrangler environments. Unknown staging IDs remain unmistakable placeholders; production deploy is manual-only and references a protected GitHub environment.
- CI/config files may be validated locally, but no workflow is pushed or executed remotely in this task.

## Observability, SLO, and alerting

- Emit structured JSON logs for request failures, ingest lifecycle, per-series attempts, snapshot publication, lock contention, admin refresh, and alert delivery. Logs must avoid secrets and bound untrusted error text.
- Publish SLO targets and current health fields: page availability target 99.9%, post-release ingest success target 99%, and mandatory critical-snapshot alerting.
- Preserve the existing second-consecutive-failure/rate-limit policy; make alert delivery injectable/testable and log/audit attempted/sent/failed/skipped outcomes. Tests use fake endpoints only.

## Backup, restore, and operations safety

- Add dry-run-by-default backup tooling for daily critical-signal export and weekly full D1 export/R2 upload. `--execute` plus explicit environment is required; production additionally requires an exact confirmation flag.
- Add a fully local ephemeral restore drill that imports a SQL backup, verifies required tables, row counts, latest official snapshot/model metadata, and content hash. Commit only fixtures/manifests, never remote data or secrets.
- Add scheduled/manual workflow definitions for backup and restore verification, but do not run remote operations.
- Require a second confirmation header for full rebuild; support documented Cloudflare Access/service-token authentication in addition to legacy bearer auth; emit an audit log for every admin attempt. The database lease remains the write-concurrency fence.

## Cache, export, and model governance

- Add a short-lived live-market cache with stale-while-revalidate/fail-closed status and a bounded circuit breaker so page traffic does not call upstream providers on every request. Never reuse data beyond the disclosed stale limit.
- Publish `docs/MODEL_CARD.md` with purpose, exclusions, assets/horizon, sources, factors, weights, thresholds, sample/OOS evidence, failed regimes, known limits, and rollback.
- Publish a Champion–Challenger registry: current Champion unchanged; PR-11 and PR-12 remain non-replacement shadow/drop research; future challenger promotion requires the frozen gates.

## TDD sequence

1. RED/GREEN deterministic model descriptor/hash, commit-SHA validation, migration/backfill, snapshot writes, and API metadata.
2. RED/GREEN v1 routing, query/response validation, export escaping, and backward compatibility.
3. RED/GREEN structured logs, SLO health, admin auth/full-rebuild confirmation, alert delivery/audit, and live cache/circuit behavior.
4. RED/GREEN backup command safety and local restore verification. Never invoke an execute/remote path during tests.
5. Add CI, Wrangler environment, protected deploy/backup workflows, Model Card, operations runbook, CHANGELOG, upgrade checklist, and PR report. Static tests validate workflow/config invariants.
6. Run fresh `npm test`, `npm run typecheck`, `npm run lint`, focused gates, `npm run deploy:dry`, local migrations 0001–0010 twice, and local restore drill.
7. Independent task/spec review and independent whole-branch review; fix every Critical/Important; fresh verification; local fast-forward only.

## Rollback

- Revert all PR-13 commits after `29e84a3` for code/config/docs/workflows.
- Migration `0010` is additive. If ever applied remotely, do not drop columns or delete audit rows; roll application behavior forward or stop writing new metadata. Local test databases may be discarded and recreated.
- Backup/restore scripts are dry-run by default and create no remote state in this task. No deployment rollback is needed because this PR is not deployed.
