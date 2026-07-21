# PR-07 Implementation Report

## Status

PASS — PR-07 source timestamps and provider fallback is implemented and validated locally on branch `codex/pr-07-provider-fallback`.

No deploy, push, remote D1 access, production mutation, schema migration, PIT/vintage change, Champion formula/weight/factor change, 45/55 threshold change, exposure-rule change, or official/nowcast channel change was performed.

## Design decisions

- `MarketDataProvider` is the single typed quote/history contract. Every result carries value or points, provider observation time, fetch time, market state, delay flag, actual/primary provider names, fallback flag, and `OK`, `STALE`, `DIVERGENT`, or `FAILED` quality state.
- Yahoo parses `regularMarketTime`, `marketState`, and `exchangeDataDelayedBy`. Yahoo history uses the timestamp paired with the last finite close. Missing or invalid provider timestamps produce a failed result and are never replaced with `fetchedAt`.
- Stooq quote provenance comes from its CSV date/time. Stooq history and FRED use their observation dates as source timestamps. FRED DGS10 is the official 10Y fallback.
- SPX/VIX use Yahoo→Stooq; DXY uses Yahoo→Stooq; 10Y uses normalized Yahoo TNX→FRED DGS10. Both sources are requested so comparable observations can be quality-checked as well as used for fallback.
- Named `MARKET_DATA_QUALITY` tolerances are separate from Champion scoring and stress thresholds. Quote levels are compared only on the same market date. Histories are compared by normalized change only on exact shared dates, avoiding both unlike DXY/broad-dollar levels and Yahoo-one-month versus Stooq-long-history false divergence.
- A material disagreement returns `DIVERGENT` plus `SOURCE_DIVERGENCE`; compatibility numeric fields become `null` instead of silently presenting either source as trusted.
- A failed/stale primary with a valid secondary returns `OK`, the actual secondary `sourceName`, and `fallbackUsed: true`. Live stress accepts this result but returns `UNKNOWN` if any required history is `FAILED`, `STALE`, or `DIVERGENT`.
- `fetchDxyDaily()` requests only the DXY Yahoo/Stooq pair and returns the existing `{date,value}[]` scale. `service.ts` splice/chaining behavior is unchanged.
- `LivePrices.asof` is retained for compatibility but explicitly labeled `asofSemantics: FETCH_TIME`; `fetchedAt` is the preferred field. Per-symbol `sourceTimestamp` is the only market-time field.
- The dashboard renders source time, fetch time, provider, market state, delay, fallback, and divergence independently for quote and stress inputs.

## Changed files

### Production code and UI

- `src/config.ts` — named provider freshness and divergence tolerances, isolated from Champion thresholds.
- `src/prices.ts` — typed provider contract, Yahoo/Stooq/FRED implementations, parsers, freshness, fallback, shared-date divergence, quote/history provenance, stress fail-closed behavior, and DXY-only extension fetch.
- `src/worker.ts` — supplies the configured FRED key to quote/history fallback and exposes the structured metadata from `/api/snapshot` and `/api/prices`.
- `public/index.html`, `public/app.js`, `public/styles.css` — separate market/fetch times and auditable provider/market/delay/fallback/divergence rendering.

### Tests

- `test/prices.test.ts` — Yahoo/Stooq timestamps, weekend behavior, DXY/10Y fallbacks, quote/history divergence, shared history windows, valid-close timestamp pairing, stress fallback/fail-closed, and DXY-only requests.
- `test/worker.test.ts` — API numeric compatibility plus structured source/fetch/provider/fallback metadata.
- `test/ui-assets.test.ts` — separate source/fetch labels and explicit provider quality rendering.

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

Result: PASS — 3 files, 58 tests passed, 0 failed.

## Final verification

### Full test suite

```bash
env -u NODE_OPTIONS npm test
```

Result: PASS — 24 test files, 407 tests passed, 0 failed.

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
- Stooq daily data and FRED official observations are intentionally marked delayed. Their validity is controlled by business-day freshness limits; exchange-holiday calendars are not modeled separately.
- Quote divergence is evaluated only when primary and secondary timestamps share the same UTC market date. Different-date quotes remain auditable but are not treated as directly comparable.
- History divergence requires at least two exact shared dates. With insufficient overlap the system does not claim a comparison; it still enforces each source's freshness and structural validity.
- DXY fallback uses the Stooq dollar-index instrument. It is not compared at level against FRED broad-dollar DTWEXBGS; the latter remains the macro scoring series and is extended only through return chaining.
- Provider observations are returned live through the API and are not persisted. PR-08 remains responsible for durable PIT/vintage observation storage.

## Rollback procedure

This PR has no schema rollback. Revert the local PR-07 commits, rebuild, and redeploy only through a separately authorized release process:

```bash
git revert <PR-07-documentation-commit> 28af59c
env -u NODE_OPTIONS npm test
env -u NODE_OPTIONS npx tsc --noEmit
```

Reverting restores the pre-PR-07 Yahoo/Stooq numeric API behavior. No database cleanup or data restoration is needed because PR-07 writes no provider data and adds no migration.

## Historical-result impact

None. Official weekly and provisional daily snapshots, ingest staging/activation, observations, explanation, backtest, walk-forward, robustness, and PIT semantics are unchanged. DXY extension preserves the existing return-chain scale and writes no new field.

## Production score and exposure impact

Champion formulas, factor definitions, weights, 45/55 verdict thresholds, hysteresis, exposure tiers, and stress trigger values are unchanged. Live-stress availability becomes more accurate: valid fallback data can keep it available, while stale/divergent provider data now closes it rather than reporting false safety.

## Commits

- `28af59c` — `feat: add market provider fallbacks and provenance`
- Documentation/report/checklist commit follows this implementation commit on the same local branch.
