# PR-18 Final Review Remediation Report

## Scope and constraints

- Remediation base: `2e1f3e3`.
- Inputs: `pr18-final-remediation-brief.md`, `pr18-final-spec-review.md`,
  `pr18-final-code-review.md`, and the confirmed dual-horizon design.
- Scope: close findings R1–R8 on the Shadow dual-horizon confidence path.
- Champion arithmetic, the eight factor weights, tactical/confidence thresholds,
  PR-11 formulas and transforms, formal APIs, snapshot writers, migrations, and
  production data are unchanged.
- No deployment, push, remote D1/R2 access, secret mutation, or formal-state
  write was performed.

## Corrections

### R1 — Untouched formal 8/8 cohort validation

The composer now validates all eight persisted formal scores before replacing
`netliqTrend`, then validates the tactical replacement separately. Missing,
non-finite, negative, or above-100 persisted scores fail closed. Scorer and
composed-result regressions cover missing, `NaN`, and out-of-range
`netliqTrend`.

### R2 — Auditable confidence evidence

The five frozen component values remain unchanged. Typed evidence now exposes:

- completeness counts, valid and invalid/missing keys, score, and reason;
- all eight persisted freshness statuses, status counts, score, and reason;
- uncapped regime count, cap 52, selected regime, governed
  model/config/code-revision cohort, score, and reason;
- each major-factor direction plus up/down/neutral counts, score, and reason;
- Raw/Smooth agreement, sample count, observation/availability dates, score,
  and reason.

An incomplete formal cohort returns safely computed completeness diagnostics;
for example, 7/8 reports `87.5` through `availableDiagnostics`. Pure output,
endpoint schema, and escaped incomplete UI rendering are covered.

### R3 — Typed service-error boundary

Request, governed-domain, and unknown operational failures are now distinct
types. Invalid `as_of` remains HTTP 400. Known malformed governed input and
explicit work-limit failures return deterministic Shadow
`DATA_INCOMPLETE`. Unknown D1/repository failures return the stable redacted
HTTP 503 `DUAL_HORIZON_SERVICE_UNAVAILABLE` payload. Classification no longer
depends on matching exception messages; a message-mimic regression proves this.

### R4 — Raw/Smooth freshness and cadence

The dual-horizon path aligns a bounded trailing weekly window before calling the
unchanged PR-11 builder. It enforces:

- WALCL weekly cadence and freshness;
- exact WDTGAL availability at each required anchor;
- WTREGEN weekly cadence and freshness;
- RRP latest availability and its required five-observation daily cadence;
- sufficient cadence-valid aligned history for the frozen 13-week feature and
  at least 52 prior-only MAD observations.

Long-stale forward fills, irregular anchors, and insufficient aligned history
return `MISSING_RAW_SMOOTH_HISTORY`. Direct HIGH, LOW, TRANSITION, stale,
cadence-invalid, and missing-history cases assert the expected directions and
evidence. Follow-up review also proved that a newly cutoff-visible WALCL release
inside its Wed+7 model delay must not displace the latest mature anchor:
freshness and anchor identity are now evaluated only on the eligible bounded
anchor series, while the mature anchor must still satisfy decision-date
freshness.

### R5 — Cutoff-local replay

Raw timing and override validation is restricted to WALCL, WTREGEN, WDTGAL,
and RRPONTSYD rows relevant to the requested observation range and strictly
visible before the cutoff. Later malformed or unrelated rows cannot alter an
old replay, while malformed visible rows still fail closed. The D1 regression
compares the full old loader result byte-for-byte after later malformed raw and
override inserts.

### R6 — Bounded database and runtime work

PR-18 uses a dedicated `loadDualHorizonLiquiditySeries` path; the PR-17
liquidity-structure endpoint contract is untouched.

Derived weekly bounds:

- Minimum `66` levels: the first 13-week impulse is available at index 13, and
  the current point at index 65 then has 52 prior finite impulses.
- Maximum `170` levels: 156 prior finite impulses, the 13-level feature warm-up,
  and the current level.
- Observation lookback `1706` days: 169 possible ten-day weekly gaps plus a
  16-day RRP warm-up.

Explicit fail-closed sentinels:

- raw revisions: `12,000`;
- visible overrides: `2,000`;
- selected liquidity rows: `2,500`;
- governed snapshot rows: `600`, queried with a `601`st sentinel row.

Limits may only be lowered by test overrides. Below-bound D1 data is equivalent
to the unbounded governed input; exceeding raw-revision, participating-override,
or selected-row work returns a typed deterministic work-limit result before
platform exhaustion. Participating overrides are counted and validated by an
`EXISTS` against the same four-series, raw-observation-date,
raw-fetched-before-cutoff cohort used by the main query. An override is neither
missed because its vintage is outside the observation window nor counted when
no relevant visible raw revision can join it.

### R7 — Behavioral coverage and governed cohorts

Tests directly prove that `baseExposure` equals the unchanged
`mapPortfolioPolicy` result. Mixed cohorts exclude the current snapshot,
provisional/legacy rows at the loader boundary, wrong regime, wrong
model/config/code revision, and post-cutoff rows. Same-regime selection uses
the selected `modelVersion`, `configHash`, and `codeCommitSha`, never
`dataRunId`. Runtime parsing also rejects invalid persisted impulse regimes and
invalid snapshot timestamp ordering/visibility. Champion digest/version and
unchanged API assertions remain green.

### R8 — Explicit four-week scorer type

`scoreNetliqTrend` now accepts
`n: number = NETLIQ_TREND_WEEKS`; the unsafe `4 as never` cast is gone. A
compile/runtime regression exercises the four-week call while the default
13-week Champion behavior remains unchanged.

## RED → GREEN evidence

- Baseline before remediation: required five-file focus, 105/105 passed.
- R1/R2/R8 RED: the new scorer, composer, evidence, endpoint, and UI
  regressions produced 13 expected failures across three files. GREEN:
  113/113 focused tests passed.
- R3 RED: two suites could not resolve the not-yet-created typed error module.
  GREEN: the error-boundary focus passed 62/62 across two files, and TypeScript
  passed.
- R4/R6 RED: ten expected failures across three files proved the absent
  `MISSING_RAW_SMOOTH_HISTORY` reason, untrimmed 220-point input, accepted stale
  RRP/14-day gaps, missing dedicated loader, and missing work sentinels. GREEN:
  91/91 passed across the three files.
- R5 RED: the targeted replay test was deliberately run once through the prior
  global validators and failed with `invalid raw releasedAt`. GREEN: after
  restoring cutoff-scoped validation, the same targeted test passed 1/1.
- R7: most added cohort/base-exposure tests passed immediately because the
  corrected selection logic already satisfied them. The invalid persisted
  regime regression was RED because the promise resolved; the runtime regime
  guard made the expanded focus GREEN at 96/96.
- Additional route-level selected-row and endpoint work-limit sentinel
  regressions passed, yielding the initial 131-test required focus.
- Follow-up code re-review WALCL RED: 170 valid mature anchors returned `OK`,
  but appending only the cutoff-visible 2021-04-07 release before its Wed+7
  eligibility changed the result to `MISSING_RAW_SMOOTH_HISTORY`. GREEN:
  freshness over the eligible anchors preserved the complete prior result
  byte-for-byte; the full confidence file passed 31/31.
- Follow-up code re-review override RED: with `overrideLimit: 1`, a selected
  2024 raw observation whose vintage was `1900-01-01` allowed two matching
  visible overrides to bypass the sentinel and the loader resolved. GREEN: the
  relevant-raw `EXISTS` makes the same test return
  `LIQUIDITY_WORK_LIMIT_EXCEEDED`; the full D1 file passed 12/12.

No assertion was weakened and no timeout was increased to obtain GREEN.

## Files changed

- `public/app.js`
- `src/db.ts`
- `src/dual-horizon-confidence.ts`
- `src/dual-horizon-errors.ts`
- `src/metrics.ts`
- `src/worker.ts`
- `test/dual-horizon-confidence.test.ts`
- `test/dual-horizon-db.test.ts`
- `test/metrics.test.ts`
- `test/ui-assets.test.ts`
- `test/worker.test.ts`
- `.superpowers/sdd/pr18-final-remediation-report.md`

## Reversible implementation commits

- `2cb8861` — `fix: type explicit net liquidity horizons`
- `97c15e6` — `fix: validate and audit formal factor cohorts`
- `839aa8c` — `fix: preserve dual-horizon service errors`
- `49ac77b` — `fix: bound dual-horizon liquidity evidence`
- `6ff2930` — `test: preserve malformed late-cutoff replay`
- `0b7352f` — `fix: validate governed regime cohorts`
- `d9f2391` — `test: prove dual-horizon work sentinels`
- `5059266` — `fix: ignore immature WALCL releases`
- `d15c468` — `fix: bound participating release overrides`

Report creation and follow-up updates are intentionally isolated in
documentation-only commits.

## Fresh verification

All project commands were run with the host's incompatible injected
`NODE_OPTIONS` removed. A literal initial `npm test` invocation stopped before
Vitest because host Node 18 rejects `--disable-warning=...`; this is an
environment issue already documented in `STATUS.md`. The sanitized project
command completed successfully.

- Required focus:
  `npx vitest run test/dual-horizon-confidence.test.ts test/dual-horizon-db.test.ts test/worker.test.ts test/ui-assets.test.ts test/production-governance.test.ts`
  — 5 files, 133/133 tests passed.
- `npm run test:correctness` — 5 files, 79/79 tests passed.
- `npm run test:no-lookahead` — 4 files, 42/42 tests passed.
- `npm run test:rebuild-consistency` — 1 file, 5/5 tests passed.
- `npm test` (as `env -u NODE_OPTIONS npm test`) — 62 files, 860/860 tests
  passed.
- `npx tsc --noEmit` (with the same environment cleanup) — passed.
- `npm run lint` (with the same environment cleanup) — passed with zero
  warnings.
- `git diff --check 2e1f3e3..HEAD` — passed.

The first follow-up full-suite attempt ran concurrently with TypeScript and
lint; one existing D1 snapshot test took 5.024 seconds and crossed its 5-second
timeout without an assertion failure. The unchanged full suite was rerun alone
and passed 860/860. No timeout or assertion was changed.

## Remaining limitations

- Raw/Smooth remains the reviewed PR-11 evidence class and does not establish
  unseen out-of-sample promotion evidence. The result remains Shadow-only.
- The AST production-governance test covers the current import surface. Its
  future-surface limitation remains: named-import tracking centers on one
  helper, and the allowed lexical route region is not bound to the actual
  pathname operand. This Minor was recorded rather than expanded during the two
  requested correctness fixes; no current production bypass was found.
- Work limits intentionally fail closed. If legitimate production revision
  density later exceeds a sentinel, changing the bound requires a separately
  governed review instead of silent truncation.
- Formal model weights, formulas, promotion gates, and production status remain
  unchanged.
