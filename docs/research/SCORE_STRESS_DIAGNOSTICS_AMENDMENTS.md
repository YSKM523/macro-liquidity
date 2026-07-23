# Score/stress diagnostics amendments

## PR16-API-STATUS-001 — fixed-shape fail-closed API enum extension

Amended: `2026-07-23T00:46:00Z`  
Based on implementation commit: `587f00fd5af6b489b688e8edca942b210df112c8`  
Frozen canonical protocol digest: `3ea92b2fc2f11745ab8f4810d9bab940f4ce4bed7892a50229822524176f38b3`

The frozen stress-event list describes coverage after formal inputs are loaded
and validated. To preserve the registered eight-row output shape on earlier
fail-closed paths, the public API adds three non-metric statuses:

- `INPUT_UNAVAILABLE` — formal inputs could not be loaded;
- `NO_FORMAL_PRICE_COVERAGE` — the formal price cohort is empty;
- `FORMAL_INPUT_INVALID` — loaded input failed the shared formal gate.

All three return null metrics and cannot be interpreted as `OK`, a candidate
comparison, or evidence for promotion. The original protocol artifact and both
digests remain unchanged. The registered Bailey–López de Prado DSR Equation 2
null threshold also remains unchanged: it uses the cross-trial Sharpe variance
interpolation without adding the empirical trial mean.
