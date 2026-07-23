# Changelog

All notable changes to Macro Liquidity Dashboard are documented here.

## Unreleased

### PR-17 — Governed liquidity-structure challenger

- Preregistered `LIQUIDITY_STRUCTURE_CHALLENGER_V1` before implementation, with raw artifact SHA-256 `946b95679e2bbacb618251969ebb7967d8a82541d277c72297b6b0a5023cbfa0` and canonical digest `b9560fe595969a7f6f8420d48cdaf8f2cfd3ad45f616974469d59115ea234c38`. The protocol is shadow-only and has no promotion threshold.
- Added prior-only TGA/RRP structure diagnostics: the latest valid weekly TGA change is multiplied by a Type-7 q20/q50 RRP buffer state estimated from 52–156 strictly prior alignments. Missing history, missing alignment, or invalid cadence returns a typed unavailable result.
- Added append-only migration 0011 for revisioned policy-regime events, with database-generated non-backdatable `created_at`, input/date/source-publication validation, update/delete guards, revision lineage, half-open effective intervals, strict `created_at < as_of` ledger visibility, decision-time source publication, and overlap fail-closed behavior. The migration deliberately contains no guessed policy dates or seed rows.
- Added the frozen policy-aware WALCL matrix, including separate crisis/unknown null states, without changing the Champion balance-sheet factor.
- Added formal governed-PIT Credit/Funding ablation across four preregistered arms. Every arm uses the identical complete eight-factor cohort, carries an explicit challenger/digest/arm identity, renormalizes remaining positive weights, runs its own sequential hysteresis pass, and reports 4/8/13-week overlapping/non-overlapping IC, Type-7 q10 tail loss, event-time Beta-matched Sharpe difference, and maximum drawdown.
- Added exact eight-factor equal/current/50-50 blended score benchmarks while keeping legacy zero-weight `vol` outside every base score.
- Added `GET /api/v1/challengers/liquidity-structure?as_of=` and a safely escaped dashboard card. Inputs share one database-resolved cutoff and honor release-calendar overrides before selecting the latest visible vintage. Invalid clocks are HTTP 400; absent policy evidence, legacy/mixed cohorts, incomplete PIT inputs, primary 13-week gaps, and overlap errors are typed and fail closed.
- The four arms now reuse one 4/8/13-week outcome build per arm (four builds total) and requests fail typed before formal validation when bounded signal/price/VIX/cash-rate limits are exceeded. Results are explicitly `RETROSPECTIVE_PIT_EVENT_TIME`; no unseen holdout was registered, so OOS is not established and ALG-08's OOS evidence gate remains pending.
- Same-close supersession, unexecuted signals, incomplete 13-week outcomes, null IC/tail values, and non-finite or null strategy/Beta-matched Sharpe, Sharpe delta, or maximum drawdown now make the formal evaluation typed `DATA_INCOMPLETE`.
- Advanced restore/governance checks through migration 0011. The superseded `--schema-confirmed=0010` token is rejected before Wrangler can run.
- Changed no Champion formula, weight, threshold, hysteresis, stress rule, portfolio target, or official snapshot. No policy seed, push, deployment, remote database access, or production write was performed.

### PR-16 — Score monotonicity, multiplicity, and registered stress diagnostics

- Added one shared formal event-time outcome builder for 4/8/13-week horizons. PR-15's 13-week path delegates to it and retains exact entry/exit/return semantics; persisted Champion signals, PIT daily prices, clocks, model/config cohort, policy fields, and provenance all fail closed through the same gate.
- Added the seven preregistered score buckets with mean/median return, negative-return probability, Type-7 q10, worst intrahorizon episode drawdown, overlapping `n`, greedily interval-non-overlapping `n`, and explicit small-sample/null statuses.
- Preserved the original append-only historical hypothesis ledger byte-for-byte and added a separate predecessor-bound interpretation amendment. PR-11/PR-12 remain current-vintage retrospective `DROP_RESEARCH`; because their declared dimensions do not enumerate trial IDs, 48 is labeled only as an upper bound and no exact BH result is claimed. Missing formal daily trial NAV keeps DSR explicitly not applicable rather than zero; pre-integration review verified that the registered DSR null threshold remains the variance-only Equation 2 interpolation.
- Froze eight half-open stress-event windows before implementation results, reports 4/8/13-week coverage and persisted verdict/exposure behavior, and keeps the open 2025–2026 window typed `OPEN_EVENT_WINDOW`. A candidate comparison remains `CANDIDATE_NOT_PROVIDED` until an independently versioned PIT artifact exists.
- Added `GET /api/v1/diagnostics` and a separate safely escaped dashboard card. Mature missing-price coverage is distinct from pending outcomes; incomplete inputs return typed data-incomplete responses and never fall back to legacy weekly/current-vintage prices.
- Changed no Champion formula, factor weight, threshold, hysteresis, stress rule, portfolio target, snapshot, or migration. No push, deployment, remote database/R2 access, secret, real alert, or production shadow runtime was performed.

### PR-15 — Purged validation and outcome taxonomy

- Added `PURGED_VALIDATION_V1`: strict date-ordered 13-week labels, outcome-overlap purging, a 91-calendar-day pre-test embargo, and separate overlapping versus greedily interval-non-overlapping sample counts.
- Added five typed outcome families without changing the Champion: score direction, persisted formal verdict, existing dashboard target-exposure risk calls, Spearman IC, and fold-training-only q10 tail detection. Undefined rates and correlations are null with explicit status, never zero or `NaN`.
- Added expanding folds whose weights and q10 calibration use only matured training outcomes. Diagnostic IC-fitted weights/performance remain explicitly separate from Champion metrics and are not promoted.
- Marked the original `2026-07-22T19:37:28Z` / `75c93d5` registration `INVALIDATED_BY_REVIEW`, then amended the corrected protocol at `2026-07-22T20:17:47Z` against implementation commit `31d26408ec6a3e05ef6da9ce7a9277320dcbf8f9`. Exact literal Champion identity, factor keys, policy, and golden digest prevent future code/config changes from rewriting history. Execution-date membership still begins in the future on `2026-07-23`; prospective tail remains permanently `UNAVAILABLE_AT_REGISTRATION`, while direction/verdict/risk/IC remain `PENDING_MATURITY` until five labels mature.
- Formal validation now uses the first eligible PIT daily execution close and first actual PIT daily close on/after entry plus 91 calendar days; it never uses the weekly snapshot's pre-decision SPX. Daily provenance and governed model/config cohorts fail closed when incomplete or mixed.
- All official signals are validated before scheduling, including superseded/unexecuted rows; canonical clocks, cutoff ordering, price visibility, and execution coverage fail closed. Event-input loader failures remain an additive typed validation failure and do not turn legacy robustness/walk-forward routes into HTTP 500 responses.
- Preserved migration-0010 history honestly: legacy PIT rows can contribute retrospective direction/verdict/risk/IC under `PARTIAL_LEGACY`, while legacy tail calibration is null/`PARTIAL_LEGACY_CALIBRATION`; malformed provenance, non-PIT inputs, or any legacy post-holdout signal fail closed.
- Published the additive validation object through `/api/walkforward`, `/api/robustness`, and `/api/v1/robustness`, and rendered typed-null metrics safely in the dashboard. Every legacy field and value remains unchanged.
- Added no migration and changed no score, factor weight, 45/55 verdict band, hysteresis rule, stress rule, portfolio target, or snapshot. No push, deployment, remote D1/R2 access, secret, or real alert action was performed.

### PR-14 — Residual correctness and bounded provider retries

- Added one GET/HEAD-only bounded full-jitter exponential-backoff policy with injectable timers/sleep/random, a three-attempt default, 250 ms production base, five-attempt hard ceiling, and independent 10-second attempt timeout.
- Retried only transport failures, HTTP 429, and HTTP 5xx across FRED/ALFRED plus Yahoo, Stooq, and live FRED provider requests; other 4xx and successful-HTTP parse/validation failures still fail immediately.
- Shared an atomic 32-request ceiling across concurrent cold-cache price/stress loading; exhaustion fails closed with explicit provider provenance.
- Gave every attempt its own controller/timeout, preserved caller-abort provenance without retry, and best-effort canceled all discarded retry and terminal error bodies.
- Classified eight macro scoring factors, compatible zero-weight `vol` diagnostics, and the independent VIX/SPX/10Y/DXY live-risk overlay; preserved existing `LEGACY_9_SIGNAL_DIAGNOSTIC` research values.
- Added deterministic zero-wait tests for timeout/abort provenance, delay/attempt caps, shared budget, response lifecycle, method guard, provider wiring, and model-language classification.
- Added no migration and changed no formula, weight, freshness rule, verdict/stress threshold, hysteresis, or portfolio policy. No deployment, remote D1/R2 mutation, secret, or real alert action was performed.

### PR-13 — Model versioning, production governance, and recovery controls

- Added deterministic `champion-v1.0.0` canonical configuration hashing and validated deployment commit identity to every new official/nowcast snapshot; additive migration 0010 labels historical rows `LEGACY_UNVERSIONED` without changing scores.
- Added schema-validated `/api/v1/snapshot`, `/api/v1/backtest`, `/api/v1/robustness`, `/api/v1/model`, and JSON/CSV official export with strict query validation and spreadsheet-injection-safe CSV escaping; legacy routes remain compatible.
- Added secret-redacted structured logs, SLO health fields, auditable alert outcomes, Access service-token support, admin rate limiting, full-rebuild second confirmation, admin audit, short live cache, bounded stale service, and a circuit breaker; typed provider failures count toward the circuit and stale stress is always `UNKNOWN`.
- Added dry-run-default critical/full backup tooling, explicit production confirmation, protected backup workflow, and an ephemeral local D1 restore drill with table/count/model metadata/content-hash verification.
- Added dev/staging/production Wrangler environments, reproducible npm gates, CI, manual protected production deployment, Model Card, Champion–Challenger registry, and operations runbook.
- Bound v1 backtest model provenance to the exact signal cohort selected by its strict `as_of` cutoff, including honest governed/legacy union reporting; unrelated diagnostic rows can no longer leak a different model or data-run identity into the response.
- Added every event-backtest behavior and reporting constant to the recursively frozen Champion descriptor and runtime path, including compatibility threshold, benchmark windows/target/cap, annualization, ACT/360 and unit conversions, plus named benchmark methodologies.
- Tightened the production deploy provenance gate to reject tracked changes and untracked bundle inputs before any migration or Wrangler deployment command.
- Kept the staging D1 identifier as an unmistakable placeholder. No push, deploy, remote database/R2 access, secret creation, or real alert delivery was performed; staging deployment remains unverified.
- Champion formulas, weights, 45/55 thresholds, hysteresis, portfolio tiers, and PR-11/PR-12 research results are unchanged.

### PR-12 — Dynamic reserve adequacy challenger research

- Preregistered a shadow-only 30/25/25/20 composite of relative reserves, 13-week reserve change, SOFR−IORB median/p95, and auxiliary EFFR/TGCR/SRF stress; all percentiles are strictly prior-only with 52 complete weeks and independent component freshness.
- Added ABUNDANT/AMPLE/TRANSITION/SCARCE/STRESSED states, fail-closed `DATA_INCOMPLETE`, next-Monday 13-week SP500 alignment, overlapping/non-overlapping Spearman IC, seeded moving-block bootstrap, six fixed folds, quintile tails, and monotonicity diagnostics.
- Recorded A-001 after nonexistent FRED `TGCR`/`SRFONTSYD` returned 404, using exact FRED `TGCRRATE` and official NY Fed Repo results without changing formula or gates.
- Recorded A-002 after review found v1 mixed temporary Repo history with SRF: v1 is `INVALIDATED_BY_REVIEW`; schema-v2 starts the NY Fed request exactly at the official `2021-07-29` launch and rejects earlier rows. Small-value exercises remain included and disclosed because the API has no unambiguous flag.
- Froze current-vintage snapshot SHA-256 `0a7f47c7599994dc4271c94bfc1faa5aa065472e1db2de790985c7788394da65`. This is `RESEARCH_CURRENT_VINTAGE`, not ALFRED/PIT; diagnostics are current-vintage retrospective pseudo-OOS and GDP observation-date alignment is not release-aware.
- Generated the corrected report once: overlapping/non-overlapping IC 0.2363/−0.0071 (n=194/15), bootstrap p=0.0515, three positive fixed folds, and a worse top-quintile 10% tail. The frozen gate selected `DROP_RESEARCH`.
- Kept `replacementEligible=false`; Champion score, weights, thresholds, verdict, hysteresis, portfolio policy, production API/snapshots, migrations, deployment, and databases are unchanged.

### PR-11 — Continuous net-liquidity challenger research

- Preregistered a shadow-only Raw/Smooth continuous net-liquidity formula before fetching data: exact 0.45/0.35/0.20 weights, strict prior-only 156-week MAD normalization, 52-week minimum history, original Friday availability, 13-week SPX target, seeded bootstrap, fixed calendar folds, and an immutable decision gate.
- Added chronological pure builders that reject missing, stale-week substitution, unsorted, duplicate, and non-finite inputs; both tracks emit level/change/impulse/trend/gap/acceleration, normalized dimensions, latent score, direction, and agreement confidence.
- Added overlapping and interval-non-overlapping Spearman IC, seeded 13-observation moving-block bootstrap, six fixed expanding-prefix evaluation folds, quintile diagnostics, and Raw/Smooth disagreement statistics.
- Preserved the initial report as `INVALIDATED_BY_REVIEW` after review proved that Wed+2 could precede a delayed holiday release. Methodology `PR11_RESEARCH_V2_REVIEW_AMENDED` now uses conservative `Wed+7`; the seven-day SPX match cap is disclosed as non-preregistered `POST_FETCH_DATA_HYGIENE`. Formula, weights, MAD, horizon, folds, bootstrap, and gate were not tuned.
- Froze and strictly verifies a canonical schema-v2 current-vintage snapshot/manifest for the exact five FRED series and exact `id`/`cosd`/`coed` URLs; snapshot SHA-256 is `e535e6cd7cd3e08795e22687cc97a82674cc0207c8b966bac8472e59d6680254`.
- Generated the corrected report exactly once. Raw overlapping/non-overlapping IC was 0.2655/0.2201 (n=509/40); agreement-confirmed was 0.2959/0.1559 (n=465/39), bootstrap 95% CI [0.1019, 0.4455], p=0.0015, and agreement rate 91.36%. Only 3 fixed folds were positive.
- Recorded the frozen outcome as `INCONCLUSIVE` / `DROP_RESEARCH`. Evidence remains `RESEARCH_CURRENT_VINTAGE`, `replacementEligible=false`; no Champion score, weight, threshold, verdict, hysteresis, portfolio target, official snapshot, API, migration, deploy, or database was changed.

### PR-10 — Dashboard-aligned portfolio backtest

- Added one pure `DASHBOARD_EXPOSURE_TIERS_V1` mapper shared by live guidance and formal PIT signals: strong tailwind 100%, ordinary tailwind 90%, neutral 75%, cautious 50%, headwind 25%, stress brake 25%, and unknown capped at 75%.
- Preserved the existing score-65 stress exemption and derived historical stress only from each immutable weekly snapshot's frozen `vix_eod` (`PIT_SNAPSHOT_VIX_PROXY`); missing VIX is unknown and VIX at/above 28 is stressed.
- Replaced the formal event-time strategy's compatibility long/flat target with explicit snapshot-derived targets. Formal runs fail closed when the target, tier, or methodology is missing; the score>55 fallback remains only in the isolated execution scheduler compatibility path.
- Added a reusable daily long/cash simulator and four same-window benchmarks: 100% SPX, static SPX/cash at strategy average beta, prior-only 20-session 10%-volatility target capped at 100%, and prior-close 200DMA risk control.
- Applied the same SOFR prior-date availability, commission, slippage, VIX stress cost, and incomplete-data behavior to strategy and benchmarks.
- Added total return, cumulative timing return difference versus beta-matched static, average beta, annualized volatility, Sharpe, Sortino, maximum drawdown, and maximum drawdown duration; insufficient histories return null metrics.
- Defined the comparison as a cumulative return difference versus beta-matched static (not annualized alpha), matched beta only across return-bearing exposures, allowed cutoff-visible pre-window warm-up without expanding the NAV window, and included inception trade cost in risk ratios with an all-observation Sortino denominator.
- Published the named methodologies, benchmark table, assumptions, and limitations in `/api/backtest`, the dashboard, and algorithm documentation without changing Champion scoring, weights, bands, hysteresis, PIT visibility, or execution timing.
- Added no migration and performed no deploy, push, remote D1 access, or production database change.

### PR-09 — Event-time daily backtest

- Added append-only revisioned `market_prices_daily` and `cash_rates_daily` with strict source/fetch/run/activation provenance, update/delete guards, an explicitly synthetic auditable local backfill, and correction-aware materialization from the latest matching PIT vintage inside the ingest activation fence. Activation touches only the current staging scope; unchanged inclusive replays do not duplicate history.
- Added D1 `recorded_at` for official signals and one D1 `activated_at` shared by every revision in an atomic activation. `/api/backtest?as_of=` resolves signals and SPX/VIX/SOFR with one canonical strict-visibility cutoff; equal-millisecond rows are conservatively deferred.
- Scheduled frozen official `OK`/`PIT` signals against a conservative `17:00:00Z` earliest-US-close eligibility bound. `23:59:59Z` remains only a daily accounting marker, not an exchange timestamp; same-close events collapse to the latest `decision_at`, and late signals remain explicitly unexecuted.
- Added daily close-to-close NAV with SOFR ACT/360 carry, 1 bp commission, 2 bps base slippage, conservative 3 bps high/stale/missing-VIX slippage, and SOFR plus 100 bps financing support above 100% exposure.
- Made missing/stale SOFR and insufficient sessions return typed `DATA_INCOMPLETE` with null total performance, while retaining the old weekly long/flat output as `LEGACY_WEEKLY` diagnostics.
- Exposed event-time assumptions and incomplete-data reasons in `/api/backtest` and the dashboard without changing Champion formulas, weights, thresholds, hysteresis, or snapshot channels.
- Made `DATA_INCOMPLETE` erase all partial NAV/cost/session performance, added same-close superseded-signal audit rows, and rejected active/latest-PIT value mismatches inside the activation transaction.
- Labeled formal inputs `APPEND_ONLY_AS_OF` with `responseReproducible=true`, `asOfCutoff`, max fetch time, source/source-run/activation-run counts, and fail-closed `DATA_INCOMPLETE` handling for synthetic, legacy/no-PIT, missing activation, or missing provenance rows.
- Added `methodology: LEGACY_WEEKLY` to the robustness strategy object and caveats, matching the existing weekly backtest compatibility label.
- Added local-only migration `0009_event_time_backtest.sql`; no deploy, remote D1 access, benchmark, exposure-tier, or tail-metric work was performed.

### PR-08 — Point-in-time observation storage

- Added append-only ALFRED vintage storage, revision reporting, conservative release metadata, manual release overrides, and next-weekday tradability metadata.
- Added inclusive vintage checkpoints and atomically promoted PIT rows beside the existing `observations` compatibility view under the existing database lease fence.
- Added lazy no-lookahead frame resolution using ordered per-series active histories; service rebuilds consume frames directly instead of retaining the full frame set.
- Made frame release/tradability cutoffs cover every scoring-history row and added production-scale coverage for 12×2,500 rows across 500 decision events.
- Added explicit `AVAILABLE`/`MISSING` endpoint audit-index rows for every configured series; full scoring history is reproduced from raw PIT rows plus `decision_at` and `release_resolution_at`.
- Froze PIT official snapshots and their endpoint indexes after a one-time legacy upgrade, including abnormal PIT rows with null run provenance; nowcasts persist provenance without creating a formal endpoint index.
- Lifted each frame's declared tradability to the latest tradability of every scoring-history row and added a second fail-closed endpoint-input gate.
- Loaded all release-calendar validity versions and required every vintage to match exactly one strictly validated interval, failing closed on gaps or overlaps.
- Versioned release-calendar overrides append-only and resolved the latest version created by each run's fixed `release_resolution_at`, without mutating raw rows; same-day fetch time now reflects successful HTTP response completion.
- Moved the fixed release-resolution instant after successful fetch/activation, made its clock injectable, excluded later-fetched backfills and later resolved official events from older universes, and persisted the same cutoff on snapshots.
- Replaced PIT timestamp text comparisons with canonical strict ISO epoch comparisons and D1 `julianday` cutoff/order semantics, including fail-closed equal-instant override ambiguity.
- Validated staged raw timings before write and changed stored-data corruption checks to a SQL `LIMIT 1` guard, avoiding a second full raw-table result set during rebuild.
- Added a post-provenance migration trigger that rejects override inserts backdated at or before any frozen weekly/daily PIT resolution cutoff, while preserving historical override entry before the first frozen snapshot.
- Added a companion raw-observation trigger that rejects genuinely new vintages whose `fetched_at` is at or before any frozen weekly/daily PIT resolution cutoff. Initial historical population and idempotent existing-key replay remain valid; a violating ingest activation rolls back atomically without replacing the ACTIVE run.
- Reloaded frozen hysteresis anchors across the complete decision week when the rebuilt snapshot date differs from the stored date.
- Expanded the final local verification to 27 files / 477 tests, TypeScript strict, diff checks, and fresh local migration first/second-run validation.
- Added local-only migration `0008_point_in_time_observations.sql`; no deployment, remote D1 access, model formula, weight, threshold, hysteresis, or channel-policy change was made.

### PR-07 — Source timestamps and provider fallback

- Added one typed quote/history provider contract with injectable Yahoo, Stooq, and FRED implementations.
- Separated provider market/observation timestamps from fetch time and retained `asof` only with explicit `FETCH_TIME` semantics.
- Added auditable SPX, VIX, DXY, and 10Y quote/history fallback metadata plus named `OK`, `STALE`, `DIVERGENT`, and `FAILED` states.
- Added `SOURCE_DIVERGENCE` detection using documented market-data quality tolerances and shared-date normalized history changes.
- Made live stress fail closed for failed, stale, or divergent required histories while accepting a valid named fallback.
- Routed DXY daily extension through the same Yahoo/Stooq abstraction without changing its level scale or splice semantics.
- Corrected Stooq history parsing to its distinct six-column CSV contract and reject impossible Stooq/FRED calendar dates as `INVALID_TIMESTAMP`.
- Updated snapshot/prices API payloads and the dashboard to show source time, fetch time, provider, market state, delay, fallback, and divergence separately.
- Added no migration and made no Champion scoring, weight, threshold, exposure, channel, ingest, or PIT change.
- Added official FRED fallback for every market input (`SP500`, `VIXCLS`, `DTWEXBGS`, `DGS10`) after optional Stooq, while exposing the actual fallback instrument and preserving DXY return-chain scale.
- Hardened provider trust boundaries with strict/future timestamps, missing-value rejection, Stooq challenge detection, a named injectable timeout, Yahoo market-state whitelisting, and escaped UI provenance.
- Made history divergence symbol-aware: VIX level, SPX/DXY five-day return, and 10Y five-day percentage-point change now disagree on either stress classification or a named material-difference tolerance.

### PR-06 — Atomic ingest runs and staging activation

- Added durable `RUNNING` / `ACTIVE` / `FAILED` ingest-run audit state, per-series attempts, run-scoped staging observations, and an expiring database-backed lease.
- Kept `observations` unchanged during fetch and validation, then promoted staging and switched the single ACTIVE run in one transactional D1 `db.batch()`.
- Preserved failed-run context and the prior production view; snapshot writers now run only after successful activation and retain PR-05 official/nowcast routing.
- Made manual lock contention explicit with HTTP 409 and scheduled contention an explicit typed result.
- Exposed the current ACTIVE and latest FAILED run through snapshot ingest metadata and health responses.
- Added local-only migration `0006_atomic_ingest.sql` without dropping or redirecting legacy production tables.
- Extended the lease through active-view reads, DXY fetches, every snapshot write, success metadata, and snapshot finalization; a lost owner can no longer continue snapshot persistence.
- Added local-only additive migration `0007_ingest_snapshot_outcome.sql` with durable `PENDING` / `SUCCEEDED` / `FAILED` snapshot outcomes, completion/error/count fields, and health failure signaling.
- Opened each series attempt before fetch and durably closed fetch, structural-validation, and staging failures without masking the original exception when audit persistence fails.
- Guarded every activation mutation inside the transactional batch so a missing or non-`RUNNING` target cannot promote observations or demote the prior ACTIVE run.
- Replaced caller-captured lease timestamps with D1-current acquisition and renewal; an expired lease cannot be resurrected.
- Fenced every activation, official/nowcast snapshot, snapshot-outcome, and global ingest-metadata mutation on the database-current live owner, with in-batch terminal assertions that roll back mid-transaction lease loss.
- Published `snapshot_state=SUCCEEDED` and the complete success metadata set atomically, made ACTIVE `PENDING` health explicitly unhealthy, and opened each series attempt before its production-history read.
- Declared the Miniflare version used by real D1 concurrency regressions as the exact direct dev dependency `3.20250718.3`; no schema migration was added by this final hardening pass.

### PR-05 — Official weekly snapshots and daily nowcasts

- Split persisted model output into official `model_snapshot_weekly` and provisional `nowcast_snapshot_daily` channels.
- Routed full rebuilds exclusively to official weekly storage and incremental refreshes exclusively to daily nowcast storage.
- Restricted history, explanation, backtest, walk-forward, and robustness reads to official weekly snapshots.
- Returned explicit `official` and `nowcast` snapshot API fields and labeled both channels in the dashboard.
- Added a conservative WALCL-cadence legacy migration while retaining `daily_snapshot` as a read-only compatibility source.

### PR-04 — Per-series freshness and factor data quality

- Added frequency-aware freshness rules and explicit factor quality states.
- Made critical missing or stale macro inputs return `DATA_INCOMPLETE`.
- Preserved real partial-factor scores while reducing confidence for incomplete optional inputs.
- Propagated current data quality through snapshot, health, explanation, backtest, and UI responses.
- Added local D1 migration `0004_snapshot_quality.sql` and verified it against the local database only.

### PR-03 — Tri-state live stress

- Replaced fail-open stress behavior with `NORMAL`, `STRESSED`, and `UNKNOWN`.
- Blocked risk increases when required live market inputs are unavailable.
- Added API and UI coverage for unavailable real-time risk data.

### PR-02 — Unified decision state

- Centralized macro verdict, display verdict, exposure tier, tone, and blocking decisions.
- Locked score boundary behavior at 45, 50, and 55 with regression tests.

### PR-01 — Incremental rebuild hysteresis

- Added lookup of the latest official snapshot before an incremental rebuild window.
- Initialized incremental hysteresis from that prior verdict without changing model weights, formulas, or thresholds.
- Added regression coverage proving full and incremental rebuild consistency.
