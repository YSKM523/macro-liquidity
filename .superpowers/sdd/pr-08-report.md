# PR-08 Implementation Report

## Status

PASS — PR-08 point-in-time observation storage is implemented and validated locally on `codex/pr-08-pit-storage` from base `e415f5d`; implementation and final-review commits are `07f7c81..73b8d61`.

No deploy, push, remote D1 access, production mutation, Champion formula/weight/threshold/hysteresis change, official/nowcast policy change, or PR-09 return/cost/holiday-calendar work was performed.

## 1. Modification summary

- Fetches ALFRED new/revised observations with `output_type=3`, an inclusive vintage checkpoint, pagination, strict dates, original unit conversion, canonical SHA-256 checksums, and duplicate-conflict rejection.
- Stages latest compatibility rows and immutable vintages together; the existing live-lease D1 activation batch now rejects checksum conflicts, appends PIT rows, updates `observations`, and switches ACTIVE atomically.
- Resolves model frames lazily, only from vintages released by each decision cutoff. Per-series active histories stay observation-date ordered through binary insertion/replacement; the service consumes the iterator directly instead of retaining every frame. Incremental historical dates use their own date-end cutoff instead of today's cutoff.
- Computes frame `dataCutoff` and `tradableAt` over every scoring-history row, not only each series endpoint.
- Versions release overrides append-only by `(series_id, vintage_date, created_at)` and resolves the newest version created by the run-fixed `release_resolution_at`. Both snapshot channels persist that cutoff; raw observations plus `decision_at` and `release_resolution_at` reproduce the resolved history.
- Captures `release_resolution_at` once after all successful HTTP fetches and activation, using an injectable clock. Replay excludes raw rows fetched after that instant, so a later backfill with an old `released_at` cannot enter an older frozen universe; official event generation also excludes resolved releases after the cutoff.
- Validates canonical ISO timestamps, including real calendar round-trip, and compares epochs rather than timestamp text. D1 cutoff and ordering use `julianday`; equal real override instants expressed with different precision fail closed as ambiguous.
- Writes immutable official provenance and one `AVAILABLE`/`MISSING` endpoint audit-index row for every configured series. Legacy official rows may upgrade once; every existing PIT row freezes even if its `data_run_id` is abnormally null. Nowcasts save provenance without a formal endpoint index.

## 2. Changed files

- Schema: `migrations/0008_point_in_time_observations.sql`.
- Runtime: `src/fred.ts`, `src/pit.ts`, `src/db.ts`, `src/service.ts`.
- Tests: `test/fred.test.ts`, `test/pit.test.ts`, `test/pit-db.test.ts`, `test/pit-snapshot-db.test.ts`, plus ingest/service/db/worker regressions.
- Docs: `README.md`, `docs/ALGORITHM.md`, `public/algorithm.md`, `public/md/CODEX_PROFESSIONAL_UPGRADE_PLAN.md`, `CHANGELOG.md`.

## 3. Design decisions

- ALFRED vintage date is not treated as a known intraday release time. Historical rows conservatively use `23:59:59Z`; a same-day value actually observed by ingest uses the clock after a successful HTTP response, not run start.
- Release-calendar loading returns every validity version. Each vintage must match exactly one strictly validated `valid_from`/`valid_to` interval; gaps, overlaps, malformed dates, and reversed intervals fail closed.
- Explicit overrides win at read time without rewriting raw data. Override versions are immutable, and repository reads use the fixed resolution cutoff while validating strict resolution/creation/release/tradability timestamps and rejecting tradability before release.
- Default tradability is the following Monday–Friday at `14:30Z`, always after release. A frame lifts its declared tradability to the latest `tradableAt` across every historical row actually supplied to scoring; official persistence rechecks endpoint audit inputs. This metadata does not implement PR-09 execution returns.
- `observations` remains the compatibility latest view. `observations_pit`, release overrides, and `snapshot_inputs` are append-only and reject update/delete.
- `snapshot_inputs` contains exactly one endpoint audit-index row per configured series; it is not a full scoring-row manifest. Missing data is represented by explicit null fields, never a fake observation.
- Full rebuild hysteresis begins undefined. If a row is already frozen, its persisted verdict—not a recomputed revised-data verdict—anchors the next frame.
- A frozen conflict reloads the persisted verdict across the complete `decision_week`, so either an earlier or later stored date in that week anchors the following frame.

## 4. TDD evidence and added tests

- Schema RED: `test/pit-db.test.ts` failed because migration `0008_point_in_time_observations.sql` did not exist. GREEN: append-only triggers, revision view, calendar seeds, provenance columns, PIT activation, replay, conflict rollback, and lease fencing pass.
- ALFRED RED: `parseFredPitJson`, `fetchFredSeriesPit`, and `src/pit.ts` were missing. GREEN: 2 files / 11 tests passed.
- Ingest RED: PIT repository exports and staging were missing. GREEN coverage proves double staging, inclusive incremental/full checkpoint behavior, same-checksum replay, conflicting-key rollback preserving old ACTIVE, and lost/transferred/expired lease rejection.
- Snapshot RED: initial Miniflare run exposed a 32-vs-33 nowcast placeholder bug and accepted mismatched run provenance. GREEN: `test/pit-snapshot-db.test.ts` 6/6 passes, including atomic endpoint-index rollback, one-time legacy upgrade, abnormal-null PIT freeze, run mismatch, future release/observation/tradability rejection, fixed release-resolution persistence, and nowcast-no-index behavior.
- Service regressions prove per-date incremental no-lookahead and propagation of a frozen official verdict into the next full-rebuild frame.
- Review RED/GREEN: frame tradability initially remained `2024-01-10` despite a used row tradable on `2024-01-12`; `dataCutoff` ignored a late revision of an older scoring row; the eager resolver had no lazy iterator; later overrides changed old rebuilds; release rules used only the database-current version; and an abnormal PIT row with null run provenance could be overwritten. Focused tests now cover each failure, including strict rule/override timestamps, frozen resolution cutoffs, and official endpoint-index tradability rejection.
- Final specification RED/GREEN covers late-backfill exclusion by raw `fetched_at`, resolved official events after the cutoff, a single post-fetch injected resolution instant across row/event/snapshot reads, canonical invalid-calendar rejection, mixed `SSZ`/`SS.sssZ` override/release/decision/tradability/prefix ordering, ambiguous equal-instant override versions, and frozen decision-week anchors in both date directions.
- Scale coverage constructs 12 daily series × 2,500 rows and 500 decision events, verifies lazy first-frame iteration and all 500 outputs, and stays within the explicit performance budget. In the final full run, `test/pit.test.ts` completed in about 294 ms.

## 5. Verification results

- Controller fresh `env -u NODE_OPTIONS npm test` initially exposed real Miniflare timeout failures under parallel D1 load. A later final run reproduced one remaining five-second timeout in `test/db.test.ts`; isolated execution completed in about 0.6 seconds, confirming parallel resource contention. The parameterized real-D1 lease test now uses the same explicit 30-second budget as the other integration suites; no production runtime or global Vitest timeout changed.
- Final controller-fresh `env -u NODE_OPTIONS npm test`: PASS, exit 0, 27/27 files and 472/472 tests. No truncated reporter output is treated as proof.
- `env -u NODE_OPTIONS npx tsc --noEmit`: PASS, exit 0, no diagnostics.
- `git diff --check`: PASS, exit 0.
- Fresh local migration directory `/tmp/pr08-final-migration.XAH8Lq`: first run applied `0001` through `0008` successfully.
- The second migration run against the same directory returned `No migrations to apply!`.

## 6. Known limitations

- Default tradability skips weekends but not US exchange holidays; PR-09 must provide the real trading calendar before performance claims.
- ALFRED supplies a date, not guaranteed historical intraday availability. Conservative date-end timing and manual overrides make the limitation explicit but cannot reconstruct unavailable intraday history.
- The first ingest with no PIT checkpoint fetches the full configured history even in incremental mode, so initial PIT population can be materially larger than the compatibility table; this PR did not access a remote database.
- The resolver no longer retains every generated frame, but the service still loads and release-sorts the cutoff-visible PIT rows before iteration. Stored timing corruption is checked with a SQL `LIMIT 1` guard rather than materializing a second full timing result set; a future database-cursor/streaming input layer would still be required to bound the visible raw-row array itself.
- Seeded general release rules span a permanent conservative interval. Maintainers must close an old interval before adding a successor; any overlap or gap intentionally fails closed for the affected vintage.
- Formal weekly and daily observations coexist as configured series inputs, but endpoint indexes and event-time cutoffs prevent mixed future vintages. Frequency redesign is outside PR-08.

## 7. Migration impact

Migration `0008` is additive: new PIT staging/raw/calendar/versioned-override/endpoint-index tables, indexes, append-only triggers, a revision view, seeded configured-series calendar rows, and five nullable provenance columns—including `release_resolution_at`—plus `pit_status` on each snapshot channel. Existing snapshot rows default to `LEGACY_NON_PIT`; no table is dropped and existing `observations` readers continue to work.

## 8. Rollback

Before any separately authorized deployment, revert the local PR-08 commits and rebuild:

```bash
git revert --no-commit e415f5d..HEAD
git commit -m "revert: remove PR-08 point-in-time storage"
env -u NODE_OPTIONS npm test
env -u NODE_OPTIONS npx tsc --noEmit
```

After a migration has been applied in an environment, code rollback can safely ignore additive tables/columns. Dropping append-only PIT data is intentionally not automated; any schema/data removal requires a separately reviewed backup-and-restore migration.

## 9. Historical-result impact

PIT official rows are immutable. An authorized full rebuild may change a legacy historical row once when upgrading it to PIT because it replaces current-revision inputs with then-visible vintages. After that upgrade, later revisions or later override versions cannot alter the frozen snapshot or its endpoint audit index.

## 10. Production score or allocation impact

No scoring formula, factor, weight, 45/55 threshold, stress threshold, exposure tier, verdict hysteresis rule, or official/nowcast channel policy changed. No production score or allocation was generated because no deploy or remote ingest was performed.
