# PR-16 Plan — Score diagnostics, multiplicity, and stress events

Base: `b79aab3`

## Objective

Complete BT-08, BT-09, and BT-10 as a new additive `SCORE_STRESS_DIAGNOSTICS_V1` layer. All return labels must reuse PR-15 formal event-time/PIT execution semantics; no weekly same-date fallback is permitted.

## Preregister before results

The first commit freezes:

- seven score buckets: `[0,20)`, `[20,35)`, `[35,45)`, `[45,55)`, `[55,65)`, `[65,80)`, `[80,100]`;
- 4/8/13-week event-time outcomes, target-date first actual PIT close, 14-day maximum exit tolerance;
- bucket statistics and typed small-sample rules;
- BH-FDR family/ranking rules and `alpha=0.05`;
- Bailey–López de Prado DSR methodology and null/incomplete-trial behavior;
- append-only hypothesis ledger schema and conservative `p=1` treatment for registered tests without a valid p-value;
- eight half-open historical event windows and typed coverage rules;
- a protocol digest, exact registration time/commit ledger, and no promotion threshold beyond existing gates.

## Formal outcomes

- Extract a shared pure event-time builder from PR-15 and prove the 13-week labels remain exactly identical.
- Every outcome records model/decision/tradable/entry/exit dates, total return, and worst intrahorizon drawdown from PIT_RAW daily closes.
- Missing/unexecuted/synthetic/legacy prices or immature exits produce typed fail-closed/pending status; they never become zero or disappear silently.

## Score buckets

For every bucket and horizon always return `n`, interval-non-overlapping `independentN`, mean, median, negative-return probability, Type-7 q10, and worst episode drawdown.

- Empty bucket: null metrics / `NO_OBSERVATIONS`.
- Mean/median/drawdown need one observation.
- Negative probability and q10 need five; otherwise null / `INSUFFICIENT_SAMPLE`.
- `return < 0` is negative; zero is not.
- Invalid or out-of-range persisted score fails the formal response closed.

## Multiplicity

- Keep an append-only JSON ledger including invalidated/superseded/failed trials.
- BH is isolated by family, stable on `(p,hypothesis_id)`, and includes missing/unmatured p-values as 1.
- PR-11/12 remain current-vintage retrospective research; this PR may label a BH readout `RETROSPECTIVE_MULTIPLICITY_AUDIT` but cannot rewrite their preregistration or decisions.
- DSR consumes formal daily net returns and a complete ledger of trial Sharpe estimates. If trial count/Sharpes are incomplete, return typed null rather than invent variance or a probability.

## Stress library

Freeze these half-open entry-date windows:

- `2018_Q4`: 2018-10-01..2019-01-01
- `2019_REPO_STRESS`: 2019-09-16..2019-11-01
- `2020_COVID`: 2020-02-19..2020-05-01
- `2021_TGA_RRP`: 2021-02-01..2022-01-01
- `2022_HIKING_QT`: 2022-03-16..2023-01-01
- `2023_REGIONAL_BANKS`: 2023-03-08..2023-05-02
- `2024_YEN_CARRY`: 2024-07-01..2024-09-01
- `2025_2026_RESERVE_MGMT`: 2025-01-01..2027-01-01

Always return all events with `OK`, `NO_FORMAL_SIGNAL_COVERAGE`, `NON_PIT_PRICE_COVERAGE`, `PENDING_OUTCOME`, `PARTIAL_COVERAGE`, or `OPEN_EVENT_WINDOW`. The 2025–26 event is open until 2027-01-01. Candidate comparison requires an independently versioned PIT artifact; absent one returns `CANDIDATE_NOT_PROVIDED`.

## API/UI and compatibility

- Add `GET /api/v1/diagnostics?as_of=<strict ISO>` using the same D1 cutoff and formal input cohort.
- Return protocol, cutoff, provenance/cohort, buckets, multiplicity, events, and typed status.
- Add a separate dashboard diagnostics card; null is rendered as `—`, and overlapping/independent counts and coverage states are visible.
- Preserve all existing API fields and PR-15 protocol literals/digest exactly.

## TDD and gates

1. RED: shared 4/8/13 formal outcomes and 13-week PR-15 golden parity.
2. RED: every bucket boundary, invalid score, empty/small samples, q10, drawdown, independent count.
3. RED: BH ties/families/missing p/duplicate ledger and DSR known/null cases.
4. RED: eight event boundaries/coverage/open window/candidate identity.
5. RED: strict as-of API, legacy route deep equality, UI null/status/escaping.
6. Full Vitest, TypeScript, ESLint, correctness, no-lookahead, rebuild consistency, migrations twice, staging bundle dry-run, and diff check.

## Non-goals and rollback

- No Champion score, weight, threshold, hysteresis, stress, portfolio, or challenger promotion change.
- No attempt to fabricate old PIT coverage or close the 2025–26 event early.
- No push, deploy, remote D1/R2, or real alert.
- Revert PR-16 commits after `b79aab3`; no migration/data rollback is expected.
