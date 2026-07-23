# Liquidity-structure challenger preregistration

Protocol: `LIQUIDITY_STRUCTURE_CHALLENGER_V1`
Registered: `2026-07-23T00:50:00Z`
Base commit: `52d1276426987537ad09c4e1ba1fa1c80d86c468`

This results-before-code contract covers ALG-04 and ALG-06 through ALG-09. It
freezes prior-only RRP buffer thresholds, the TGA multiplier, policy-event
visibility, the WALCL policy matrix, four credit/funding ablation arms, and the
equal/current/blended eight-factor benchmark definitions.

This is a shadow-only diagnostic. It cannot change the Champion, official
snapshot, verdict, threshold, live stress policy, or production exposure. No
policy dates are seeded without primary-source evidence; an empty policy ledger
must return typed unavailable output.

Raw artifact SHA-256:
`946b95679e2bbacb618251969ebb7967d8a82541d277c72297b6b0a5023cbfa0`.
Key-sorted canonical JSON digest:
`b9560fe595969a7f6f8420d48cdaf8f2cfd3ad45f616974469d59115ea234c38`.

These are distinct verification procedures. Changing the protocol requires a
separate amendment.
