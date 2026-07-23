# Score/stress diagnostics preregistration

Protocol: `SCORE_STRESS_DIAGNOSTICS_V1`  
Registered: `2026-07-22T20:36:03Z`  
Anchor commit: `d7aba3c2b5bd79cfaf7847cdc82770abb499fdcd`

This is the immutable, results-before-code contract for PR-16. The canonical
machine-readable contract is `SCORE_STRESS_DIAGNOSTICS_PROTOCOL.json`. Its raw
artifact SHA-256 is
`891f77f991ca40521639dee3ab50418999e4c3d9296e7bd675f693ee3801efa2`; its
key-sorted canonical JSON protocol digest is
`3ea92b2fc2f11745ab8f4810d9bab940f4ce4bed7892a50229822524176f38b3`.
These are deliberately distinct verification procedures. The append-only trial
universe is `SCORE_STRESS_HYPOTHESIS_LEDGER.json` (raw SHA-256
`fb3f32d8c783294a7c4f7302fab24f7369bb20bcb9808c189bc23843c9f6ee0d`).
Later interpretation metadata lives in a separate predecessor-bound amendment
artifact and does not rewrite those frozen records.

The seven buckets, 4/8/13-week formal PIT outcomes, Type-7 q10, small-sample
rules, BH family/ranking rule, Bailey–López de Prado DSR inputs, eight half-open
events and coverage states are exactly those in the canonical protocol. A
missing p-value is conservatively ranked as one. DSR is null unless every
ledger trial supplies a formal daily net-return Sharpe; a trial count alone is
never substituted for the missing vector.

The historical dimension counts are declarations from the frozen research
records, not enumerated trial IDs. The API therefore reports 48 only as a
conservative declared upper bound, never as an exact auditable trial count.

No threshold in this protocol can promote a challenger or alter the Champion.
The PR-11/12 entries remain retrospective current-vintage audits and preserve
invalidated and failed trials rather than deleting them.
