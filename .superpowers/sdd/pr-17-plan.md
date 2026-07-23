# PR-17 implementation plan — governed liquidity-structure challenger

Base: `52d1276`
Scope: ALG-04 and ALG-06 through ALG-09 only
Constraint: additive shadow diagnostics; Champion score, weights, thresholds,
hysteresis, official snapshots and production portfolio policy remain unchanged.

## Frozen design

1. Register the exact TGA/RRP, policy-event, ablation and eight-factor benchmark
   protocol before implementation.
2. Add an append-only `policy_regime_events` migration with update/delete guards,
   revision lineage and no guessed historical seed dates.
3. Resolve policy state strictly as of database time: `created_at < as_of`, source
   publication no later than the decision clock, half-open effective intervals,
   latest visible revision per key, and fail closed on overlap.
4. Compute TGA shock from two valid weekly TGA observations. Determine RRP buffer
   state from Type-7 q20/q50 using 52–156 strictly prior weekly alignments; never
   derive thresholds from the current row.
5. Interpret WALCL impulse with the frozen policy matrix. Crisis/unknown or absent
   policy is typed null, not neutral.
6. Compute four credit/funding ablation arms and equal/current/blended eight-factor
   scores from the exact eight positive-weight keys. `vol` stays outside all base
   scores.
7. Use one complete governed PIT signal cohort and one sequential hysteresis pass
   per arm. Do not infer a candidate from incomplete or legacy rows.
8. Expose a versioned shadow endpoint. No endpoint writes snapshots or policy rows.

## TDD sequence

1. RED migration tests: immutable revisions, lineage, strict clocks, overlap.
2. RED pure tests: TGA prior-only quantiles/cadence/missing data and policy matrix.
3. RED benchmark tests: exact eight keys, vol exclusion, renormalized ablations.
4. RED API tests: explicit `as_of`, fixed typed failures, no legacy fallback.
5. Implement only enough to turn each group green.
6. Run focused tests, full Vitest, TypeScript, lint, correctness/no-lookahead,
   migration-twice verification and Wrangler staging dry-run.
7. Independent spec and whole-branch review before local integration.

## Rollback

Revert the PR-17 commit range. Migration `0011` is additive and intentionally
contains no seed rows. If it has only been applied to local ephemeral D1, rebuild
that fixture. If ever applied remotely, do not delete append-only audit rows;
disable readers with a forward migration instead.
