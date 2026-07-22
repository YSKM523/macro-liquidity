# PR-07 Implementation Report

## Status

PASS — PR-07 source timestamps and provider fallback is implemented and validated locally on branch `codex/pr-07-provider-fallback`.

No deploy, push, remote D1 access, production mutation, schema migration, PIT/vintage change, Champion formula/weight/factor change, 45/55 threshold change, exposure-rule change, or official/nowcast channel change was performed.

## Design decisions

- `MarketDataProvider` is the single typed quote/history contract. Every result carries value or points, provider observation time, fetch time, market state, delay flag, actual/primary provider names, fallback flag, and `OK`, `STALE`, `DIVERGENT`, or `FAILED` quality state.
- Yahoo parses `regularMarketTime`, a whitelisted `marketState`, and `exchangeDataDelayedBy`. Yahoo history pairs timestamps with finite closes, sorts the result, and checks every valid source observation for a future timestamp—including an out-of-order future point hidden before the selected last close. Missing, invalid, or future provider timestamps produce a typed failed result and are never replaced with `fetchedAt`.
- Stooq quote provenance comes from its strictly validated eight-column quote CSV date/time. Its history endpoint has a separate real six-column `Date,Open,High,Low,Close,Volume` contract. HTML/JavaScript challenge responses and misleading content types are rejected before CSV parsing. Stooq history and FRED use strictly validated observation dates; FRED null, empty, and `.` observations are not coerced to zero.
- All four chains are Yahoo→Stooq when usable→official FRED: SPX→`SP500`, VIX→`VIXCLS`, DXY→`DTWEXBGS`, and normalized Yahoo TNX/10Y→`DGS10`. Results expose the actual `sourceSymbol` and `sourceLabel`. Each provider call has a named, injectable four-second timeout so a hung secondary cannot hang the API.
- Named `MARKET_DATA_QUALITY` tolerances are separate from Champion scoring and stress thresholds. Quote levels are compared only on the same market date and never compare ICE DXY with broad-dollar `DTWEXBGS` levels. History divergence uses the exact shared-date stress semantic for each symbol: VIX latest level, SPX/DXY five-day return, and 10Y five-day percentage-point change. A different stress classification or a material metric difference beyond `historyReturnTolerance` returns `SOURCE_DIVERGENCE`.
- A material disagreement returns `DIVERGENT` plus `SOURCE_DIVERGENCE`; compatibility numeric fields become `null` instead of silently presenting either source as trusted.
- A failed/stale primary with a valid secondary returns `OK`, the actual secondary `sourceName`, and `fallbackUsed: true`. Live stress accepts this result but returns `UNKNOWN` if any required history is `FAILED`, `STALE`, or `DIVERGENT`.
- `fetchDxyDaily()` requests only the DXY Yahoo/Stooq/FRED chain and returns the selected `{date,value}[]` unchanged. `service.ts` supplies `FRED_API_KEY`; the existing return-based splice preserves the `DTWEXBGS` scale whether the selected history is ICE DXY or broad-dollar data. `DTWEXBGS` FRED freshness reuses its configured seven-business-day release-lag window.
- `LivePrices.asof` is retained for compatibility but explicitly labeled `asofSemantics: FETCH_TIME`; `fetchedAt` is the preferred field. Per-symbol `sourceTimestamp` is the only market-time field.
- The dashboard renders source time, fetch time, actual instrument/provider, market state, delay, fallback, and divergence independently. Third-party provenance is HTML-escaped, status classes are whitelisted, and the aggregate market time uses only `OK` quotes.

## Changed files

### Production code and UI

- `src/config.ts` — named provider timeout, future skew, freshness, and divergence tolerances, isolated from Champion thresholds.
- `src/prices.ts` — typed providers, strict parsers/time checks, official fallback chains, semantic divergence, provenance, timeout, stress fail-closed behavior, and DXY-only extension fetch.
- `src/service.ts` — passes the configured FRED key into the DXY extension chain without changing ingest or splice semantics.
- `src/worker.ts` — supplies the configured FRED key to quote/history fallback and exposes the structured metadata from `/api/snapshot` and `/api/prices`.
- `public/index.html`, `public/app.js`, `public/styles.css` — separate market/fetch times and escaped, auditable instrument/provider/market/delay/fallback/divergence rendering.

### Tests

- `test/prices.test.ts` — strict/future timestamps, out-of-order Yahoo points, missing FRED values, Stooq HTML/JavaScript challenges, official fallback for all symbols, actual DXY instrument, semantic/material divergence, provider timeout, stress fail-closed, and DXY extension behavior.
- `test/atomic-ingest.test.ts` — verifies the FRED key reaches `fetchDxyDaily()` from `service.ts`.
- `test/worker.test.ts` — API numeric compatibility plus structured source/fetch/provider/fallback metadata.
- `test/ui-assets.test.ts` — separate source/fetch labels, OK-only aggregate time, explicit provider quality rendering, and adversarial provenance escaping.

### Documentation

- `README.md`, `docs/ALGORITHM.md`, `public/algorithm.md` — provider topology, timestamps, quality states, and live-stress behavior.
- `public/md/CODEX_PROFESSIONAL_UPGRADE_PLAN.md` — PR-07 local completion and checklist.
- `CHANGELOG.md` — PR-07 release notes.

## TDD evidence

### Initial timestamp RED

```bash
env -u NODE_OPTIONS npx vitest run test/prices.test.ts
```

Before production edits: 1 failed and 21 passed. Yahoo returned only `5123.45` instead of source/fetch/market/delay/provider metadata.

### Provider/fallback RED

The same command after adding the remaining behavior-first tests produced 9 failed and 21 passed. Failures showed numeric-only Stooq parsing, no structured live quotes, no DXY/10Y fallback, no divergence state, no history fallback, stress ignoring provider quality, and Yahoo-only DXY extension.

### Review boundary RED

```bash
env -u NODE_OPTIONS npx vitest run test/prices.test.ts test/worker.test.ts test/ui-assets.test.ts
```

Before the boundary fixes: 4 failed and 52 passed. The implementation compared unrelated provider history ranges, DXY extension requested unrelated symbols, `/api/prices` did not supply the FRED key, and the UI lacked separate fields.

Additional provider-time RED produced 2 failed and 31 passed: Yahoo history used a timestamp paired with a null close, and different-market-date quote levels were incorrectly compared.

### Focused GREEN

```bash
env -u NODE_OPTIONS npx vitest run test/prices.test.ts test/worker.test.ts test/ui-assets.test.ts
```

Result: PASS — 3 files, 60 tests passed, 0 failed.

### Task-review history-schema RED/GREEN

The task-review fixtures were first changed to Stooq's real history format (`Date,Open,High,Low,Close,Volume`) and impossible calendar dates were added before production edits:

```bash
env -u NODE_OPTIONS npx vitest run test/prices.test.ts test/worker.test.ts
```

RED result: 1 file failed and 1 passed; 4 tests failed and 43 passed. SPX/VIX/DXY history fallback and DXY extension could not parse real Stooq history rows, Stooq invalid dates were mislabeled `NO_DATA`, and FRED invalid dates were accepted as `OK`.

After separating quote/history parsers, using history columns 0/4, strictly validating real calendar dates, and freezing the API test clock, the same two-file command passed 47 tests. The complete PR-07 focused command (`prices`, `worker`, and `ui-assets`) then passed 3 files, 60 tests, 0 failed.

### Final-review trust-boundary RED/GREEN

The final whole-branch review first added official fallbacks for every symbol, future/missing/challenge handling, provider timeout, semantic divergence, UI escaping, and OK-only aggregate-time tests:

```bash
env -u NODE_OPTIONS npx vitest run test/prices.test.ts test/ui-assets.test.ts
```

RED result: 2 files failed; 13 tests failed and 50 passed. A second price-only RED produced 3 failures and 49 passes for an out-of-order future Yahoo point plus same-class material VIX/10Y disagreements. After those fixes, an additional Stooq JavaScript-challenge test failed as `NO_DATA` rather than `INVALID_RESPONSE` (1 failed, 86 passed across prices/UI/atomic-ingest) before the content-type/challenge guard was added.

Final focused command:

```bash
env -u NODE_OPTIONS npx vitest run test/prices.test.ts test/ui-assets.test.ts test/worker.test.ts test/service.test.ts test/service-channels.test.ts test/service-freshness.test.ts test/atomic-ingest.test.ts
```

Result: PASS — 7 files, 109 tests passed, 0 failed.

## Final verification

### Full test suite

```bash
env -u NODE_OPTIONS npm test
```

Result: PASS — 24 test files, 430 tests passed, 0 failed.

The first final-suite attempt encountered two default-five-second timeouts in existing D1 lease tests while files ran concurrently. An isolated `test/db.test.ts` rerun passed 15/15, and the exact full-suite command above was then rerun to a clean pass. No production code was changed to hide or lengthen those tests.

### TypeScript

```bash
env -u NODE_OPTIONS npx tsc --noEmit
```

Result: PASS — exit code 0, no diagnostics.

### Patch hygiene

```bash
git diff --check 732880e..HEAD
```

Result: PASS — no whitespace errors after the final documentation commit.

## Migration result

No schema or migration file was added. Local migration execution is therefore not required for PR-07; migrations `0001`–`0007` and all PR-06 database semantics are untouched. No local or remote D1 command was run for this PR.

## Known limitations

- Yahoo, Stooq, and FRED remain public upstream services without a commercial SLA. PR-07 makes failure and disagreement explicit but cannot guarantee upstream availability.
- Stooq was retained as an optional typed source, but review-supplied public read-only evidence observed a quote 404 and a JavaScript challenge on history from a Worker-like path. Official FRED is therefore the usable final fallback for every symbol. Upstream behavior may still change.
- Stooq daily data and FRED official observations are intentionally marked delayed. Their validity is controlled by business-day freshness limits; exchange-holiday calendars are not modeled separately. `DTWEXBGS` specifically allows its configured seven-business-day release lag.
- Quote divergence is evaluated only when primary and secondary timestamps share the same UTC market date. Different-date quotes remain auditable but are not treated as directly comparable.
- History divergence requires at least two exact shared dates. With insufficient overlap the system does not claim a comparison; it still enforces each source's freshness and structural validity.
- DXY may fall back to the different broad-dollar `DTWEXBGS` instrument. The API/UI identify it explicitly; it is never compared at level with ICE DXY. Shared-date returns may be compared, and the existing splice keeps the official series scale.
- Provider observations are returned live through the API and are not persisted. PR-08 remains responsible for durable PIT/vintage observation storage.

## Rollback procedure

This PR has no schema rollback. Revert the local PR-07 commits, rebuild, and redeploy only through a separately authorized release process:

```bash
git revert --no-commit 732880e..HEAD
git commit -m "revert: remove PR-07 provider fallback"
env -u NODE_OPTIONS npm test
env -u NODE_OPTIONS npx tsc --noEmit
```

The substantive reverse order at report time is the current report-only HEAD, then `9dec8fb`, `099c579`, and `28af59c`; the base-to-HEAD range avoids an unstable placeholder for the commit that contains this report itself.

Reverting restores the pre-PR-07 Yahoo/Stooq numeric API behavior. No database cleanup or data restoration is needed because PR-07 writes no provider data and adds no migration.

An environment-level provider smoke test remains an authorized rollout step: in staging/target, call `/api/prices` and `/api/snapshot`, verify plausible SPX/VIX/DXY/10Y values plus actual provider/instrument/source timestamps, and exercise one controlled primary-source failure if supported. That target-environment test requires explicit permission; it was not run in this implementation session. No deploy, production database access, or production mutation was performed.

## Historical-result impact

None. Official weekly and provisional daily snapshots, ingest staging/activation, observations, explanation, backtest, walk-forward, robustness, and PIT semantics are unchanged. DXY extension preserves the existing return-chain scale and writes no new field.

## Production score and exposure impact

Champion formulas, factor definitions, weights, 45/55 verdict thresholds, hysteresis, exposure tiers, and stress trigger values are unchanged. Live-stress availability becomes more accurate: valid fallback data can keep it available, while stale/divergent provider data now closes it rather than reporting false safety.

## Commits

- `28af59c` — `feat: add market provider fallbacks and provenance`
- `099c579` — `docs: record PR-07 verification`
- `9dec8fb` — `fix: parse provider history timestamps strictly`
- `ba29492` — `docs: record PR-07 review fixes`
- `0c19c12` — `fix: harden provider fallback trust boundaries`
