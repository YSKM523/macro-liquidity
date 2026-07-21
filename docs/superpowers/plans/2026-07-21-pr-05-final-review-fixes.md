# PR-05 Final Review Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Correct incremental hysteresis anchoring and make official-versus-provisional UI semantics unambiguous without changing model calculations.

**Architecture:** Add one database loader that returns valid official verdict anchors for a date range, then use it only in incremental processing to reset the running verdict before computing an anchored date. Carry the selected primary channel through frontend rendering, while labeling explanation data as independently sourced from the official API.

**Tech Stack:** TypeScript, Cloudflare D1, Vitest, browser JavaScript, HTML/CSS.

## Global Constraints

- Preserve scoring formulas, weights, and 45/55 thresholds.
- Full rebuilds reconstruct official history from an undefined prior verdict.
- Do not change migration scope, deploy, access remote D1, or mutate production state.
- Use `apply_patch` for edits and `env -u NODE_OPTIONS` for Node commands.

---

### Task 1: Official hysteresis anchors

**Files:**
- Modify: `test/db.test.ts`
- Modify: `test/service.test.ts`
- Modify: `test/service-channels.test.ts`
- Modify: `src/db.ts`
- Modify: `src/service.ts`

**Interfaces:**
- Produces: `officialVerdictAnchors(db, from, to): Promise<Array<{ date: string; verdict: Verdict }>>`
- Consumes: existing `officialSnapshotBefore`, `computeSnapshot`, and explicit official/nowcast writers.

- [x] **Step 1: Write failing database and service tests**

Add a database test proving one ordered `BETWEEN` query returns valid official verdict anchors, a service test proving a provisional threshold crossing is reset by an in-window official verdict, and a test proving full rebuild does not call persisted-anchor readers.

- [x] **Step 2: Verify RED**

Run: `env -u NODE_OPTIONS npm test -- test/db.test.ts test/service.test.ts`

Expected: failure because the range helper is absent, in-window anchors are ignored, and full rebuild reads the pre-window official row.

- [x] **Step 3: Implement the minimum service/database change**

Query official anchors once with `date BETWEEN ? AND ?`, build a date-keyed map, reset `prev` before computing an anchored incremental date, and keep full rebuild `prev` undefined without any persisted verdict reads.

- [x] **Step 4: Verify GREEN**

Run: `env -u NODE_OPTIONS npm test -- test/db.test.ts test/service.test.ts test/service-channels.test.ts`

Expected: all focused database/service tests pass.

### Task 2: Frontend channel semantics

**Files:**
- Modify: `test/ui-channels.test.ts`
- Modify: `public/app.js`
- Modify: `public/index.html`
- Modify: `public/styles.css`

**Interfaces:**
- Produces: `selectPrimarySnapshot` behavior where equal dates prefer official.
- Produces: `snapshotChannel` on the render payload and an official explanation source marker using `res.current.date`.

- [x] **Step 1: Write failing UI behavior tests**

Add equal-date conflicting-verdict coverage, assert official explanation title/source/date rendering, and assert a provisional primary receives provisional provenance rather than a weekly tag.

- [x] **Step 2: Verify RED**

Run: `env -u NODE_OPTIONS npm test -- test/ui-channels.test.ts`

Expected: equal-date selection chooses nowcast, explanation lacks official source/date copy, and provenance labels provisional output as weekly.

- [x] **Step 3: Implement the minimum UI change**

Use strict `nowcast.date > official.date`, carry `snapshotChannel`, render an `OFFICIAL` explanation source line with the API current date, and render provisional provenance with a dedicated tag and daily-nowcast wording.

- [x] **Step 4: Verify GREEN**

Run: `env -u NODE_OPTIONS npm test -- test/ui-channels.test.ts test/ui-assets.test.ts`

Expected: all focused UI tests pass.

### Task 3: Report and final verification

**Files:**
- Modify: `.superpowers/sdd/pr-05-report.md`

**Interfaces:**
- Consumes: recorded RED/GREEN and verification outputs.
- Produces: base-relative rollback guidance and a non-self-stale inventory.

- [x] **Step 1: Correct report wording**

Describe rollback as reverting every feature-branch commit after base `854c64b` through current `HEAD`, and replace commit-by-commit inventory with the base plus a command that derives the current range.

- [x] **Step 2: Run complete verification**

Run `env -u NODE_OPTIONS npm test`, `env -u NODE_OPTIONS npx tsc --noEmit`, and `git diff --check`; record exact results.

- [x] **Step 3: Commit**

Stage all scoped files and commit with message `fix: resolve final official nowcast review`.
