# Score/stress diagnostics amendments

## PR16-DSR-001 — formula transcription correction

The frozen protocol's `expected_maximum_rule` label abbreviated the Bailey–López
de Prado expected-maximum calculation as variance interpolation. The executable
formula follows Equation 1: the cross-trial Sharpe mean plus the
Euler–Mascheroni interpolation scaled by the cross-trial sample standard
deviation. This correction was made during pre-integration review, before any
complete formal trial vector or DSR result existed. It changes no Champion
score, threshold, weight, signal, or portfolio recommendation.

The original protocol artifact and both of its digests remain unchanged; this
file is the explicit audit amendment.
