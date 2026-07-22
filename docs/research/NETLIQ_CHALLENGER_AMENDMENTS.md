# PR-11 Research Amendment Ledger

Methodology version: `PR11_RESEARCH_V2_REVIEW_AMENDED`

This ledger separates the original preregistration from later correctness and trust-boundary amendments. The formula/weights/MAD/folds/gate unchanged throughout: Raw/Smooth definitions, 0.45/0.35/0.20 weights, 156-week prior-only MAD, 52-week minimum, 13-week horizon, fixed six fold ranges, bootstrap seed/block/iterations, and decision rule were not tuned in response to results.

## Exact chronology

| Order | Commit / event | Audit meaning |
|---:|---|---|
| 1 | `0b120a4` | Original `PREREGISTERED_BEFORE_FETCH` contract. It specified observation Wednesday +2 days / nominal Friday availability. |
| 2 | `8180851` | Initial current-vintage FRED snapshot fetched and frozen. Its exact URLs locked `id` and `cosd` but did not include `coed`. |
| 3 | `47e2358` (`POST_FETCH_DATA_HYGIENE`) | After fetch and before the initial formal report command/publication, a fail-closed seven-calendar-day maximum was added for matching SPX start/end prices. This was not preregistered. The same commit published the initial report. |
| 4 | `4891ed0` | Initial local verification metadata. It did not discover the holiday-release timing error. |
| 5 | independent review | Review demonstrated that 2016-11-23 and 2024-11-27 plus two days could select a Friday before the delayed H.4.1 release. The initial report was therefore invalidated. |
| 6 | `30f2ef9` (`REVIEW_CORRECTNESS`) | Correctness amendment changed the conservative availability bound to `Wed+7` calendar days and changed fold `trainN` to count only outcomes with `endDate <= foldStart`. |
| 7 | `0fff138` (`REVIEW_TRUST_BOUNDARY`) | Added canonical schema-v2 snapshot/manifest verification, exact five-series binding, object-vs-bytes verification, and exact FRED `id` / `cosd=2002-01-01` / `coed=2026-07-22` URL checks. A v2 snapshot was actually fetched; all five normalized series hashes equal v1. |

## Amendments

### A-001 — holiday-safe availability (`REVIEW_CORRECTNESS`)

- Trigger: independent review after the initial report.
- Original rule: observation Wednesday +2 calendar days.
- Effective rule: observation Wednesday +7 calendar days, then the first SPX close on or after that bound.
- Reason: fail closed across normal and delayed holiday publication schedules without inventing a historical release calendar.
- Report impact: the initial report is `INVALIDATED_BY_REVIEW` and cannot be cited as the PR-11 result.
- Tuning: none; signal formula, normalization, target horizon, folds, and gate are unchanged.

### A-002 — bounded SPX row matching (`POST_FETCH_DATA_HYGIENE`)

- Timing: implemented after data commit `8180851`, before the initial formal report generation/publication in `47e2358`.
- Rule: reject a start or horizon-end price when the first available SPX row is more than seven calendar days after the requested bound.
- Preregistration status: explicitly not preregistered.
- Purpose: prevent a signal from bridging years of absent SPX history or another long data gap; it was not selected from observed IC.

### A-003 — canonical artifact trust boundary (`REVIEW_TRUST_BOUNDARY`)

- Trigger: independent review after the initial report.
- Rule: runner accepts only schema-v2 canonical bytes whose snapshot and manifest agree on schema, snapshot ID, retrieval time, source, evidence class, exact five-series set, exact request URLs/range, row counts, date ranges, and hashes.
- V2 snapshot SHA-256: `e535e6cd7cd3e08795e22687cc97a82674cc0207c8b966bac8472e59d6680254`.
- Provenance: v2 was actually fetched with explicit `coed=2026-07-22`; no v1 metadata was rewritten to imply a request that did not occur.

## Report status

- `NETLIQ_CHALLENGER_OOS_REPORT_INITIAL_INVALIDATED.json` and `.md`: audit-only initial output from `47e2358`; status `INVALIDATED_BY_REVIEW`.
- `NETLIQ_CHALLENGER_OOS_REPORT.json` and `.md`: canonical corrected schema-v2 report generated exactly once after focused amendment and renderer tests passed. Raw overlap/non-overlap IC is 0.2655/0.2201; agreement-confirmed is 0.2959/0.1559; the decision remains `INCONCLUSIVE` / `DROP_RESEARCH`.
- Both report generations remain `RESEARCH_CURRENT_VINTAGE`; neither is production PIT proof, and `replacementEligible=false` remains mandatory.
