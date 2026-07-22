# PR-08 Implementation Report

## Status

PASS — PR-08 point-in-time observation storage is implemented and validated locally on `codex/pr-08-pit-storage` from base `e415f5d`; implementation commits are `07f7c81..9c43cdf`.

No deploy, push, remote D1 access, production mutation, Champion formula/weight/threshold/hysteresis change, official/nowcast policy change, or PR-09 return/cost/holiday-calendar work was performed.

## 1. Modification summary

- Fetches ALFRED new/revised observations with `output_type=3`, an inclusive vintage checkpoint, pagination, strict dates, original unit conversion, canonical SHA-256 checksums, and duplicate-conflict rejection.
- Stages latest compatibility rows and immutable vintages together; the existing live-lease D1 activation batch now rejects checksum conflicts, appends PIT rows, updates `observations`, and switches ACTIVE atomically.
- Resolves model frames only from vintages released by each decision cutoff. Incremental historical dates use their own date-end cutoff instead of today's cutoff; execution-aware reads additionally require tradability.
- Writes immutable official provenance and one `AVAILABLE`/`MISSING` manifest row for every configured series. Legacy official rows may upgrade once; PIT rows and manifests freeze. Nowcasts save provenance without formal manifests.

## 2. Changed files

- Schema: `migrations/0008_point_in_time_observations.sql`.
- Runtime: `src/fred.ts`, `src/pit.ts`, `src/db.ts`, `src/service.ts`.
- Tests: `test/fred.test.ts`, `test/pit.test.ts`, `test/pit-db.test.ts`, `test/pit-snapshot-db.test.ts`, plus ingest/service/db/worker regressions.
- Docs: `README.md`, `docs/ALGORITHM.md`, `public/algorithm.md`, `public/md/CODEX_PROFESSIONAL_UPGRADE_PLAN.md`, `CHANGELOG.md`.

## 3. Design decisions

- ALFRED vintage date is not treated as a known intraday release time. Historical rows conservatively use `23:59:59Z`; a same-day value actually observed by ingest uses the clock after a successful HTTP response, not run start.
- Explicit overrides win at read time, so an override added after immutable ingestion becomes effective without rewriting raw data. Repository reads validate strict ISO timestamps and reject tradability before release.
- Default tradability is the following Monday–Friday at `14:30Z`, always after release. A frame lifts its declared tradability to the latest `tradableAt` across every historical row actually supplied to scoring; official persistence rechecks manifest inputs. This metadata does not implement PR-09 execution returns.
- `observations` remains the compatibility latest view. `observations_pit` and `snapshot_inputs` are append-only and reject update/delete.
- A formal manifest contains exactly one row per configured series. Missing data is represented by explicit null fields, never a fake observation.
- Full rebuild hysteresis begins undefined. If a row is already frozen, its persisted verdict—not a recomputed revised-data verdict—anchors the next frame.

## 4. TDD evidence and added tests

- Schema RED: `test/pit-db.test.ts` failed because migration `0008_point_in_time_observations.sql` did not exist. GREEN: append-only triggers, revision view, calendar seeds, provenance columns, PIT activation, replay, conflict rollback, and lease fencing pass.
- ALFRED RED: `parseFredPitJson`, `fetchFredSeriesPit`, and `src/pit.ts` were missing. GREEN: 2 files / 11 tests passed.
- Ingest RED: PIT repository exports and staging were missing. GREEN coverage proves double staging, inclusive incremental/full checkpoint behavior, same-checksum replay, conflicting-key rollback preserving old ACTIVE, and lost/transferred/expired lease rejection.
- Snapshot RED: initial Miniflare run exposed a 32-vs-33 nowcast placeholder bug and accepted mismatched run provenance. GREEN: `test/pit-snapshot-db.test.ts` 4/4 passes, including atomic manifest rollback, one-time legacy upgrade, freeze, run mismatch, future release/observation rejection, and nowcast-no-manifest behavior.
- Service regressions prove per-date incremental no-lookahead and propagation of a frozen official verdict into the next full-rebuild frame.
- Review RED/GREEN: frame tradability initially remained `2024-01-10` despite a used row tradable on `2024-01-12`; response-time tests initially stored run-start `18:00:00` instead of post-response `18:00:05`; malformed persisted overrides were initially accepted. The focused GREEN suites now cover all three fixes plus official-manifest tradability rejection.

## 5. Verification results

- Controller fresh `env -u NODE_OPTIONS npm test` initially produced a real RED: 4 Miniflare tests timed out at Vitest's five-second default while 446 passed. Every real Miniflare behavior test in the affected ingest/PIT files now has an explicit 30-second budget; no production runtime or global Vitest timeout changed.
- Focused GREEN after semantic review: `fred.test.ts` 7/7, `pit.test.ts` 6/6, malformed/valid override DB tests 2/2, official tradability gate 1/1, service/atomic group 38/38. Repository total is 27 files / 454 tests.
- Final fresh full-suite summary is recorded by the controller review gate after the timeout-only stabilization commit; no truncated reporter output is treated as proof.
- `env -u NODE_OPTIONS npx tsc --noEmit`: PASS, exit 0, no diagnostics.
- `git diff --check e415f5d..HEAD`: PASS.
- Local migration first run: `0001` through `0008` applied successfully to worktree-local D1.
- Local migration second run: `No migrations to apply!`.

## 6. Known limitations

- Default tradability skips weekends but not US exchange holidays; PR-09 must provide the real trading calendar before performance claims.
- ALFRED supplies a date, not guaranteed historical intraday availability. Conservative date-end timing and manual overrides make the limitation explicit but cannot reconstruct unavailable intraday history.
- Initial PIT population can be materially larger than the compatibility table and requires an authorized full ingest; this PR did not access a remote database.
- Formal weekly and daily observations coexist as configured series inputs, but manifests and event-time cutoffs prevent mixed future vintages. Frequency redesign is outside PR-08.

## 7. Migration impact

Migration `0008` is additive: new PIT staging/raw/calendar/override/manifest tables, indexes, append-only triggers, a revision view, seeded configured-series calendar rows, and five nullable provenance columns plus `pit_status` on each snapshot channel. Existing snapshot rows default to `LEGACY_NON_PIT`; no table is dropped and existing `observations` readers continue to work.

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

PIT official rows are immutable. An authorized full rebuild may change a legacy historical row once when upgrading it to PIT because it replaces current-revision inputs with then-visible vintages. After that upgrade, later revisions cannot alter that snapshot or its manifest.

## 10. Production score or allocation impact

No scoring formula, factor, weight, 45/55 threshold, stress threshold, exposure tier, verdict hysteresis rule, or official/nowcast channel policy changed. No production score or allocation was generated because no deploy or remote ingest was performed.
