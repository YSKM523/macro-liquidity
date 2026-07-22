# PR-10 Dashboard-Aligned Portfolio Backtest Report

Base: `f04d4b2`

Branch: `codex/pr-10-portfolio-backtest`

Implementation commits: `52b551a..a3c4262` (whole rereview diff: `f04d4b2..e3c9277`; post-review cache-bust TDD: `a3c4262`)

## Outcome

- Added one pure `DASHBOARD_EXPOSURE_TIERS_V1` numeric mapper used by live guidance and formal event-time signals: strong tailwind 100%, ordinary tailwind 90%, neutral 75%, cautious 50%, headwind 25%, stress brake 25%, and unknown capped at 75%.
- Preserved the existing stress exemption at score 65 and every Champion score, weight, 45/50/55 band, hysteresis rule, PIT cutoff, execution time, cash, and cost assumption.
- Historical stress derives only from immutable weekly `vix_eod` (`PIT_SNAPSHOT_VIX_PROXY`): null is unknown, VIX at/above 28 is stressed, otherwise normal. It never reads a daily VIX revision activated after the signal.
- Formal loader selects frozen `score`, `verdict`, `netliq_dir`, and `vix_eod`, derives explicit target/tier/methodology, and the formal engine returns `DATA_INCOMPLETE` when those policy fields are absent. The old score>55 fallback remains only inside isolated scheduler compatibility behavior.
- Added one reusable daily long/cash simulator shared by formal strategy and benchmarks. It retains prior-date SOFR ACT/360, 1 bp commission, 2 bps base slippage, 3 bps conservative VIX cost, financing support in the generic simulator, and empty/null incomplete behavior.
- Added identical-window 100% SPX, strategy-average-beta static SPX/cash, prior-only 20-session 10%-annualized-volatility target capped at 100%, and prior-close 200DMA risk-control benchmarks.
- Added total return, cumulative timing return difference versus beta-matched static, average beta, annualized volatility, Sharpe, Sortino, maximum drawdown, and maximum drawdown duration. Insufficient history and undefined ratios are null, not fabricated zeros.
- Published named methodologies and a comparison table through `/api/backtest` and the dashboard.

## TDD evidence

- Stage 1 RED: `test/portfolio-policy.test.ts` could not load the missing `src/portfolio-policy.ts`. GREEN: 83/83 focused policy + metrics tests passed.
- Stage 2 RED: the repository query omitted verdict/net-liquidity/VIX and the formal runner incorrectly returned `OK` without an explicit portfolio target. GREEN: 117/117 focused DB/event/metrics tests and TypeScript passed.
- Stage 3 RED: six pure portfolio tests failed because benchmark targets, simulator, and metrics functions did not exist; the formal result then failed because `portfolio` was undefined. GREEN: 50/50 focused portfolio/event/DB tests and TypeScript passed.
- Stage 4 RED: the dashboard contract lacked named portfolio and prior-only benchmark disclosures. GREEN: 32/32 focused worker/UI tests and TypeScript passed.

## Verification and review

- First independent reviews requested changes: return-bearing beta matching, official-field runtime fail-close, cutoff-visible pre-window benchmark warm-up, inception-cost risk returns, the all-observation Sortino denominator, unambiguous cumulative-return-difference naming, and the global same-beta checklist. RED reproduced all findings: terminal `[1,0]` beta was 0.5; invalid score produced HTTP 500 while other invalid fields returned `OK`; warm-up calls failed with exposure-length mismatch; inception volatility was null; Sortino used only negative observations; and the API/UI still exposed `timingAlpha` / “择时 Alpha”.
- Review-fix GREEN: terminal trade remains charged while beta is 1; DB/engine/API fail closed; first-window vol20/MA200 targets use only prior visible rows; exact inception and Sortino formulas pass; API/UI/docs use `CUMULATIVE_RETURN_DIFFERENCE_VS_BETA_MATCHED_STATIC` / “累计择时收益差”. Focused review-fix suite: **5/5 files, 97/97 tests, exit 0**; TypeScript and doc-mirror checks pass.

- Fresh review-fix `env -u NODE_OPTIONS npm test -- --reporter=json --outputFile=/tmp/pr10-review-fix-full.json`: **31/31 files, 551/551 tests, success true, exit 0**.
- Fresh `env -u NODE_OPTIONS npx tsc --noEmit`: **exit 0**.
- `git diff --check f04d4b2..ceb8b25`: **exit 0**; worktree clean before this verification-status update.
- Local migrations at `/tmp/pr10-review-fix-migrations.K9kfvr`: 0001–0009 applied successfully; immediate second invocation returned **No migrations to apply!**. No new migration exists in PR-10.
- Independent task/spec rereview of `f04d4b2..e3c9277`: **Ready**, 0 Critical / 0 Important. Its only Minor was a stale frontend cache token after the API field rename.
- Independent whole-branch rereview of `f04d4b2..e3c9277`: **Ready**, 0 Critical / 0 Important; focused 7 files / 115 tests, TypeScript, diff-check, and clean status passed.
- Post-review cache-bust RED expected `/app.js?v=0722c` while HTML still served `0722b`; GREEN updated the token and passed `test/ui-assets.test.ts`: **17/17**, plus TypeScript and diff-check.

## Known limitations

- FRED SP500 index closes exclude dividends and do not represent a tradable total-return product.
- Historical stress is deliberately narrower than the live four-asset overlay; only frozen weekly VIX is available without inventing event-time live history.
- Benchmark estimators may use cutoff-visible price history before the strategy's evaluation window as warm-up, while all simulated NAV/cost rows remain on the identical evaluation window.
- No separate exchange calendar exists; actual SPX rows define sessions.
- Sharpe/Sortino use daily portfolio returns after cash and costs without subtracting another risk-free series; zero volatility or no downside produces null.

## Production impact and rollback

- No schema migration, deploy, push, staging/production access, remote D1 access, or production database mutation was performed.
- Revert only the PR-10 range after base `f04d4b2`. PR-09 append-only storage and event-time infrastructure require no rollback or data deletion.
