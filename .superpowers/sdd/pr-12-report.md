# PR-12 Delivery Report

Base: `ba74a6c`

Branch: `codex/pr-12-reserve-adequacy`

Implementation range: `7f64d10..9258a0a`

## 1. 修改摘要

新增隔离的动态准备金充裕度 shadow challenger：四个 prior-only 组件、独立 freshness、五状态、13 周 OOS 诊断、canonical current-vintage artifact 与冻结报告。正式结论为 `DROP_RESEARCH`、`replacementEligible=false`。

## 2. 修改文件

- `scripts/reserve-*.mjs`, `scripts/run-reserve-research.mjs`, fetch/generate CLI
- `scripts/data/reserve-current-vintage-2026-07-22-v{1,2}.*`
- `test/reserve-*.test.ts`
- `docs/research/RESERVE_*`, README, CHANGELOG, algorithm docs/mirror, upgrade plan

## 3. 设计决策

- 公式固定为 30/25/25/20；strictly-prior expanding percentiles 最少 52 周。
- rate spread 只做 same-date pair；WRESBAL/GDP/rates/SRF 各自 freshness，任何 required component 不完整即 `DATA_INCOMPLETE`。
- exact source A-001：FRED `TGCRRATE` + official NY Fed Repo results。
- correctness A-002：NY Fed canonical start 强制 `2021-07-29`；v1 混入临时 Repo，`INVALIDATED_BY_REVIEW`；小额 exercises 因无明确 flag 保留。
- current-vintage research 永远不可替换 Champion。

## 4. 新增测试

覆盖 preregistration/source amendments、units/alignment/freshness/fail-close、same-date pairing、median/p95/max、quarter-end non-persistence、strict prior/prefix invariance/weights/states、OOS alignment/bootstrap/folds/quintiles/gate、artifact trust boundary、runner/report/docs。

## 5. 测试结果

- Focused reserve suite: 8 files / 29 tests passed.
- Fresh full Vitest: 48 files / 633 tests passed.
- `env -u NODE_OPTIONS npx tsc --noEmit`: passed.
- `git diff --check ba74a6c..HEAD`: passed.
- Fresh local migrations at `/tmp/pr12-migrations.CbpWa7`: 0001–0009 passed; immediate second run returned `No migrations to apply!`.
- Worktree clean before review package generation.

## 6. 已知限制

- FRED/NY Fed 均为当前版本，不是 ALFRED/PIT；GDP 存在 revision/publication-date bias。
- FRED SP500 不含股息；研究是 IC/ranking，不是可交易组合回测。
- NY Fed small-value exercises 保留，可能高估市场驱动 SRF take-up。
- 13 周 overlapping targets 相关；non-overlap 仅 15 个。
- v1 artifact/report 仅审计，不得用于结论。

## 7. 数据迁移说明

无 migration、无数据库写入。只新增离线代码、测试、文档与 content-addressed artifact。

## 8. 回滚说明

回退 `ba74a6c` 后的 PR-12 commit range；无需数据库回滚。

## 9. 是否改变历史结果

只新增离线 challenger 当前版本研究结果；不修改既有正式历史结果。v1 无效结果被显式保留为 audit-only，canonical v2 独立生成。

## 10. 是否改变生产分数或仓位建议

否。未修改 `src/`、production API、Champion、正式快照、阈值、迟滞或 portfolio policy。
