# Dynamic Reserve Adequacy Challenger — Amendment Ledger

## A-001 — Primary source correction

- Timing: after preregistration commit `7f64d10`, before any canonical full fetch, scoring, or OOS report.
- Trigger: a 2024-01-01 through 2024-01-03 exact-ID probe returned HTTP 404 for FRED `TGCR` and `SRFONTSYD`. Six other preregistered FRED IDs returned the expected `observation_date,<ID>` header.
- Corrected rate ID: FRED `TGCRRATE`, using only `https://fred.stlouisfed.org/graph/fredgraph.csv?id=TGCRRATE&cosd=2002-01-01&coed=<frozen-end-date>`.
- Corrected SRF source: `https://markets.newyorkfed.org/api/rp/results/search.json?startDate=<start>&endDate=<end>&operationTypes=Repo`, documented at `https://markets.newyorkfed.org/static/docs/markets-api.html` and in the official OpenAPI path `/api/rp/results/search.{format}`.
- Required NY Fed fields: `operationDate`, `operationType`, `term`, `totalAmtAccepted`.
- Normalization: retain only same-source `Repo` records with `term=Overnight`; sum `totalAmtAccepted` across all records sharing `operationDate`; output daily USD billions as `NYFED_SRF_ACCEPTED`.
- Evidence limitation: both providers are frozen current-vintage research sources, not a historical-vintage/PIT reconstruction. The NY Fed result API describes published operation results; it does not prove when every historical row became visible to this research process.
- Integrity: the final artifact must bind exact provider URLs/parameters, normalized rows, row/date ranges, provider hashes, and whole snapshot bytes.
- Tuning declaration: `false`. Formula, 0.30/0.25/0.25/0.20 weights, state cutoffs, freshness rules, target, folds, bootstrap, decision gate, allowed decisions, and `replacementEligible=false` remain unchanged.
