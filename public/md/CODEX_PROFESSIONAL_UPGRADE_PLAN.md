# Macro Liquidity Dashboard — 专业版升级执行规格

> 目标仓库：`YSKM523/macro-liquidity`
> 目标系统：Macro Liquidity Dashboard
> 文档用途：交给 Codex 按阶段实施、测试、提交 PR
> 编制日期：2026-07-21
> 核心原则：**先修正确性与可复现性，再升级算法；先建立 point-in-time 数据与真实回测，再讨论新因子和自动调权。**

## 执行状态（2026-07-22）

| PR | 状态 | 本地提交 | 说明 |
|---|---|---|---|
| PR-01 | 已完成 | `2267e21` | 增量重算继承窗口前正式快照的迟滞状态；已覆盖 full/incremental 一致性 |
| PR-02 | 已完成 | `ce7da2b` | 决策状态机与 45/50/55 边界统一 |
| PR-03 | 已完成 | `1c53681` | 实时 Stress 改为 NORMAL/STRESSED/UNKNOWN 并 fail closed |
| PR-04 | 已完成 | `6367de0`–`19ceabc` | 独立 freshness、FactorResult、DATA_INCOMPLETE 与质量传播 |
| PR-05 | 已完成 | `c3ee4d1` | 正式周频快照与 `PROVISIONAL` 日频 nowcast 分表；官方分析只读周频表 |
| PR-06 | 已完成（本地） | `cf7463c`–`732880e` | 原子 ingest run、逐序列 staging、单事务 ACTIVE 切换、数据库时间租约 fencing 与失败审计 |
| PR-07 | 已完成（本地） | `28af59c`–`5a9179c` | 行情 source/fetch 时间分离、统一 provider、全品种官方 fallback 与 divergence fail-closed |
| PR-08 | 已完成（本地） | `07f7c81`–`37fd6c4` | append-only ALFRED vintage、惰性 event-time resolver、冻结 raw universe/override cutoff 与正式 endpoint audit index |
| PR-09 | 已完成（本地） | `0764210`–`02f9e38` | append-only as-of event-time、保守 close eligibility、日频 NAV、SOFR/成本、typed incomplete 与 UI 披露；冻结 PIT 可抵御 legacy 无 provenance 覆盖；29 files / 518 tests + TypeScript strict 已通过，final rereview Ready（0 Critical / 0 Important） |
| PR-10 | 已完成（本地） | `52b551a`–`a3c4262` | dashboard tiers、冻结快照 VIX stress proxy、同窗公平基准与尾部指标已实现；31 files / 551 tests、TypeScript、migration twice 已通过，双重复审 Ready（0 Critical / 0 Important），cache-bust focused 17/17 |
| PR-11 | 已完成（本地） | `276eeb5`–`29c0094` | Raw/Smooth 连续净流动性、prior-only MAD、固定 OOS 评估与 schema-v2 FRED snapshot 已实现；结论 `INCONCLUSIVE` / `DROP_RESEARCH`，replacementEligible=false；40 files / 604 tests、双重复审 Ready（0 Critical / 0 Important / 0 Minor），Champion 不变 |
| PR-12 | 已完成（本地） | `7f64d10`–`54daf01` | 动态准备金 prior-only challenger、独立 freshness/state/OOS 与 schema-v2 双源 artifact；32 files / 640 tests、TypeScript、migration twice 已通过，task/spec 与 whole-branch rereview 均 Ready（0 Critical / 0 Important / 0 Minor）；结论 `DROP_RESEARCH`，replacementEligible=false，Champion 不变 |
| PR-13 | 本地实现与验证完成，待最终独立复审结论 | `9f2a4f6`–`54ad16e` | 模型版本、精确 `as_of` 回放 provenance、完整事件回测配置哈希、v1 API、真实 lint/CI/环境、结构化日志、fail-closed 缓存、告警审计、备份/恢复和治理文档已验证；53 files / 685 tests；未部署 |

当前状态只代表本地仓库已经实现并验证；尚未推送 GitHub、部署 staging/production，也未修改远程数据库。

---

## 0. 给 Codex 的总指令

请先完整阅读本文件，再检查仓库当前实现。不要一次性完成全部改造，也不要直接在生产分支做大规模重构。

执行规则：

1. 每个阶段单独建立分支和 PR。
2. 每个 PR 只解决一个相对独立的问题，保持可回滚。
3. 修改前先补回归测试，修改后运行全部测试。
4. 不得为了提高历史 IC、命中率或 Sharpe 临时调整阈值。
5. 不得在没有样本外证据的情况下替换生产模型权重。
6. 所有历史回测必须遵守：
   - 数据当时已经发布；
   - 使用当时可见的数据版本；
   - 信号只能在最早可交易时间之后执行；
   - 未来修订不得覆盖历史输入。
7. 对缺失、陈旧或失败的数据，禁止静默返回“中性”或“无风险”。
8. 所有生产快照必须可回答：
   - 哪个 Git commit 计算；
   - 使用哪组配置；
   - 使用哪一批数据；
   - 数据截止什么时间；
   - 信号何时可交易。
9. Champion 模型保持不变，任何新算法先作为 Challenger 影子运行。
10. 每完成一个阶段，更新本文件中的 checklist 和 `CHANGELOG.md`。

推荐命令：

```bash
npm ci
npm test
npx tsc --noEmit
npx wrangler deploy --dry-run
```

如果仓库尚未配置 lint、typecheck 或 CI，请在工程化阶段补齐。

---

# 1. 最终目标

将当前项目从“强解释型宏观流动性看板”升级为：

- 数据时点正确；
- 历史输入可复现；
- 正式信号与 nowcast 分离；
- 回测与页面实际交易逻辑一致；
- 缺失数据和实时源故障不会误报安全；
- 算法改动通过 Champion–Challenger 和冻结样本验证；
- 每次输出可审计、可回滚、可追踪；
- 生产环境具备监控、告警、备份和恢复能力。

---

# 2. 不做什么

以下项目在完成 P0 和 Point-in-Time 数据层之前，不进入生产开发：

- 神经网络；
- XGBoost 自动调权；
- 高频动态重训；
- 大量新增宏观因子；
- 根据当前回测临时优化 45/55 阈值；
- 根据当前样本调整所有 `linMap` 边界；
- 将全球央行流动性重新加入基础评分；
- 将同一个 SPX 模型直接套到 QQQ、IWM 或个股；
- 把 nowcast 估算值当作正式历史数据。

---

# 3. 当前系统的关键已知结构

主要文件：

```text
src/
  metrics.ts       核心打分、状态和 guidance
  config.ts        权重、阈值、系列配置
  service.ts       FRED 摄取和快照重算
  fred.ts          FRED 请求与解析
  db.ts            D1 数据访问
  worker.ts        API 路由、实时覆盖层
  prices.ts        Yahoo / Stooq 实时数据
  backtest.ts      IC、命中率、long-flat 策略
  walkforward.ts   扩窗 walk-forward
  robustness.ts    Bootstrap、非重叠 IC、regime
  explain.ts       分数和净流动性归因
  health.ts        健康检查
  global.ts        全球流动性展示
public/
  app.js
  index.html
  styles.css
docs/
  ALGORITHM.md
  ROADMAP-algo-v2.md
```

当前核心公式：

```text
净流动性 = WALCL − WDTGAL − RRPONTSYD
```

当前基础评分实际为：

```text
8 个有权重宏观因子
+ 1 个权重为 0、独立进入 live-stress 的波动因子
```

---

# 4. 实施路线总览

| Gate | 目标 | 进入下一阶段的硬条件 |
|---|---|---|
| Gate 1 | 正确性 | 全量与增量重算一致；状态无冲突；缺数据不伪装安全 |
| Gate 2 | Point-in-Time 数据 | 任意历史信号可以按当时可用信息重建 |
| Gate 3 | 真实回测 | 执行时间、现金收益、成本、仓位逻辑与页面一致 |
| Gate 4 | 算法 Challenger | 新算法在 OOS、尾部风险和稳定性上不劣于 Champion |
| Gate 5 | 生产工程 | CI、staging、监控、告警、备份、恢复、审计齐全 |
| Gate 6 | 模型治理 | Champion–Challenger、Model Card、冻结样本、变更审批运行 |

---

# 5. Phase 1 — 正确性修复

## P0-01 修复增量重算时的迟滞状态错误

### 当前问题

`service.ts` 在重算最近 14 天时，将：

```ts
let prev: Verdict | undefined;
```

重新初始化为空。

如果重算窗口第一天的分数处于 45–55 死区，`verdictFromScore()` 无法继承窗口之前的真实 verdict，可能错误回到 `NEUTRAL`，并向后传播。

### 修改方向

1. 新增数据库方法：

```ts
snapshotBefore(db, date)
```

2. 在增量重算开始前读取：

```ts
const prior = await snapshotBefore(env.DB, dates[0]);
let prev: Verdict | undefined = prior?.verdict;
```

3. 全量重建仍然从 `undefined` 开始。
4. 若历史快照不存在，明确记录状态初始化原因。

### 可能涉及文件

```text
src/service.ts
src/db.ts
test/service.test.ts
test/metrics.test.ts
```

### 测试

- 连续 20 个快照分数均在 45–55；
- 起始 verdict 为 BULLISH；
- 增量重算结果必须持续保持 BULLISH；
- 全量重建与增量重建输出完全一致。

### 验收标准

```text
full_rebuild(snapshot_date) === incremental_rebuild(snapshot_date)
```

比较字段至少包括：

```text
score
verdict
netliq_dir
qe_qt_regime
factors_json
reason
```

---

## P0-02 分离正式周频信号与日频 Nowcast

### 当前问题

全量历史按 WALCL 周频日期生成，日常任务又把最近 14 天生成日频快照，导致历史频率混合。

### 修改方向

建立两张表：

```sql
model_snapshot_weekly
nowcast_snapshot_daily
```

`model_snapshot_weekly`：

- 只保存正式模型输出；
- 固定每周一个决策点；
- 进入正式 backtest / walk-forward / robustness；
- 保持 verdict 迟滞连续。

`nowcast_snapshot_daily`：

- 用于周中观察；
- 明确标记 `PROVISIONAL`；
- 不进入正式历史回测；
- 允许每日更新。

### 迁移策略

1. 新增两张表；
2. 从旧 `daily_snapshot` 迁移周频正式数据；
3. 保留旧表作为只读兼容层；
4. API 改为显式返回：

```json
{
  "official": {},
  "nowcast": {}
}
```

### 可能涉及文件

```text
migrations/
src/db.ts
src/service.ts
src/worker.ts
src/backtest.ts
public/app.js
```

### 验收标准

- 正式回测每周最多一条信号；
- 日频 nowcast 不进入 `loadBacktestRows()`；
- 前端明确标注“正式信号”和“周中预估”；
- 历史正式信号频率统一。

---

## P0-03 建立唯一决策状态机

### 当前问题

宏观 verdict、display verdict 和 guidance 分别根据不同规则计算，边界可能不一致。

特别需要检查：

```text
score > 55
score >= 55
score < 45
45–55 迟滞
stress 降级
guidance 仓位档
```

### 修改方向

新增统一函数：

```ts
deriveDecisionState(input): DecisionState
```

输入：

```ts
interface DecisionInput {
  score: number;
  previousVerdict?: Verdict;
  netliqState: NetliqState;
  balanceSheetRegime: BalanceSheetRegime;
  policyRegime: PolicyRegime;
  stressStatus: StressStatus;
  confidence: number;
}
```

输出：

```ts
interface DecisionState {
  macroVerdict: Verdict;
  displayVerdict: Verdict | 'UNKNOWN';
  exposureTier: ExposureTier;
  tone: Tone;
  reason: string;
  blocked: boolean;
}
```

其他函数不得自行重新判断阈值。

### 边界定义

必须统一并写入测试：

```text
score = 45
score = 50
score = 55
```

建议规则：

```text
score > 55       → BULLISH
score < 45       → BEARISH
45 <= score <=55 → 继承前态；无前态则 NEUTRAL
```

### 可能涉及文件

```text
src/metrics.ts
src/worker.ts
src/config.ts
public/app.js
test/metrics.test.ts
```

### 验收标准

顶部 verdict、颜色、仓位建议和触发器永不冲突。

---

## P0-04 将 Stress 改为三态

### 当前问题

实时源完全失败时，空数组最终可能得到：

```text
stressed = false
```

这属于 fail-open。

### 修改方向

```ts
type StressStatus = 'NORMAL' | 'STRESSED' | 'UNKNOWN';
```

规则：

```text
关键数据齐全且无触发 → NORMAL
关键数据齐全且有触发 → STRESSED
任一关键源缺失/陈旧 → UNKNOWN
```

UNKNOWN 时：

- 不允许提高仓位；
- 显示“实时风险层不可用”；
- 保留宏观分；
- guidance 不得写“当前未触发”。

### 可能涉及文件

```text
src/prices.ts
src/worker.ts
src/metrics.ts
public/app.js
test/prices.test.ts
```

### 验收标准

模拟 Yahoo 全部失败，API 必须返回：

```json
{
  "status": "UNKNOWN"
}
```

---

## P0-05 缺失数据不得默认伪装成 50 分

### 当前问题

多个因子在数据缺失时返回 50，导致“真正中性”和“不可计算”难以区分。

### 修改方向

每个因子返回：

```ts
interface FactorResult {
  score: number | null;
  quality: number;
  status: 'OK' | 'PARTIAL' | 'STALE' | 'MISSING';
  asOf: string | null;
  components: Record<string, unknown>;
}
```

总分规则：

```text
关键因子缺失：
  不生成正式 verdict
  decision status = DATA_INCOMPLETE

非关键因子缺失：
  对可用权重重新归一
  降低 confidence
```

关键因子建议至少包括：

```text
WALCL
WDTGAL
RRPONTSYD
净流动性趋势所需历史
```

### 可能涉及文件

```text
src/metrics.ts
src/config.ts
src/service.ts
src/worker.ts
src/db.ts
public/app.js
```

### 验收标准

缺少 WALCL 或 TGA 时，不得生成正式“偏多/偏空”结论。

---

## P0-06 为每个序列加入独立新鲜度规则

### 修改方向

扩展 series config：

```ts
{
  id,
  unit,
  expectedFrequency,
  maxStaleCalendarDays,
  maxStaleBusinessDays,
  releaseLag,
  requiredForScore,
  fallbackPolicy
}
```

已实现：

```ts
asOfFresh(series, date, freshnessRule)
```

返回：

```ts
{
  value,
  observationDate,
  ageDays,
  status
}
```

### 验收标准

- 每个因子显示自己的 as-of；
- 旧数据不能无限 forward-fill；
- stale 数据在 API 中显式标记；
- 关键数据 stale 时，正式信号进入 `DATA_INCOMPLETE`。

---

## P0-07 修复实时行情时间戳

### 当前问题

当前 `asof` 更接近抓取时间，而非行情实际时间。

### 修改方向

解析并保存：

```text
sourceTimestamp
fetchedAt
marketState
isDelayed
sourceName
```

页面区分：

```text
行情时间
抓取时间
数据源
市场状态
```

### 验收标准

周末或收盘后，不得把旧行情显示为“刚刚更新”。

---

## P0-08 给 DXY、10Y 和 Stress 增加备用源

### 修改方向

实现统一 Provider 接口：

```ts
interface MarketDataProvider {
  fetchQuote(symbol): Promise<QuoteResult>;
  fetchHistory(symbol): Promise<SeriesResult>;
}
```

支持：

```text
Yahoo
Stooq
官方/FRED/Treasury
未来可接第二商业源
```

返回：

```text
OK
STALE
DIVERGENT
FAILED
```

### 验收标准

- 单一源失败不导致整个系统误报；
- 主备偏差过大时返回 `SOURCE_DIVERGENCE`；
- 页面显示实际使用的数据源。

---

## P0-09 摄取流程原子化

### 当前问题

序列逐个写入，若中途失败，数据库可能出现半新半旧。

### 修改方向

新增：

```sql
ingest_runs
ingest_series_attempts
staging_observations
ingest_lock
```

流程：

```text
1. 创建 run_id，状态 RUNNING
2. 所有新数据写 staging
3. 完整性与数量级检查
4. 全部成功后标记 ACTIVE
5. 兼容表 `observations` 只在激活事务中更新，正式查询继续只读该生产最新视图
6. 失败 run 标记 FAILED，不影响生产数据
```

数据库租约锁由 `runIngest()` 自身获取；有效租约拒绝第二个 run，过期租约可接管，且 `finally` 只按 owner `run_id` 释放。手动争用返回 HTTP 409，scheduled 争用返回显式 typed conflict。

### 验收标准

- [x] 任一系列失败时，旧 `observations` 与 ACTIVE run 保持不变
- [x] 零行增量被记录为成功尝试，仅在生产已有该序列时通过校验
- [x] 激活使用一个事务性的 D1 `db.batch()`
- [x] 激活失败不触发 official / nowcast snapshot 写入
- [x] staging 不进入 backtest / walk-forward / robustness

---

## P0-10 后台错误不得静默吞掉

### 修改方向

- scheduled job 记录结构化错误；
- 更新 `ingest_runs`；
- 发送外部告警；
- 记录失败系列、HTTP 状态、run_id；
- 可重试错误使用指数退避；
- 持续失败升级告警。

### 验收标准

模拟 FRED 500，必须：

```text
run_status = FAILED
health = degraded
external alert emitted
previous active run preserved
```

---

## P0-11 统一“8 个计分因子 + 1 个风险覆盖层”

### 修改方向

统一所有文档和 UI 文案：

```text
8 个宏观计分因子
1 个实时风险覆盖层
```

不要再写“9 个加权因子”。

### 验收标准

以下位置一致：

```text
README
ALGORITHM.md
前端
API
config
测试
```

---

# 6. Phase 2 — Point-in-Time 数据架构

## PIT-01 保存观察日期、发布日期、摄取时间和可交易时间

新增字段：

```text
observation_date
released_at
fetched_at
tradable_at
source
```

正式信号只允许使用：

```text
released_at <= decision_at
tradable_at <= execution_at
```

---

## PIT-02 引入 FRED/ALFRED Vintage

### 数据表

```sql
CREATE TABLE observations_pit (
  series_id TEXT NOT NULL,
  observation_date TEXT NOT NULL,
  vintage_date TEXT NOT NULL,
  released_at TEXT,
  value REAL NOT NULL,
  fetched_at TEXT NOT NULL,
  source TEXT NOT NULL,
  checksum TEXT,
  PRIMARY KEY (
    series_id,
    observation_date,
    vintage_date
  )
);
```

### 查询原则

历史回测时：

```sql
选择 decision_at 时已经可见的最新 vintage
```

禁止使用今天修订后的历史值替代当时数据。

---

## PIT-03 原始数据 Append-Only

### 规则

- 原始观测不得 update 覆盖；
- 清洗表可以保存 latest view；
- 模型必须引用明确的 `data_run_id` 和 `vintage_id`；
- 修订记录旧值、新值、修订幅度。

### 验收标准

重跑历史模型时，可以选择：

```text
当时初值
当前修订值
```

并生成差异报告。

---

## PIT-04 建立正式 Release Calendar

新增可维护表：

```sql
release_calendar (
  series_id,
  expected_release_weekday,
  expected_release_time,
  timezone,
  source_url,
  valid_from,
  valid_to
)
```

对特殊假期和延迟发布允许人工修订。

---

## PIT-05 保存每次正式信号的输入清单

建议新增：

```sql
snapshot_inputs (
  snapshot_id,
  series_id,
  observation_date,
  vintage_date,
  released_at,
  value
)
```

任何历史信号必须可逐项审计。

---

# 7. Phase 3 — 真实回测系统

## BT-01 使用最早可交易时间

流程：

```text
官方数据发布
→ 模型计算
→ next tradable timestamp
→ 执行
```

H.4.1 观察日不得直接视为决策日。

---

## BT-02 使用日频价格执行周频信号

正式信号可以周频，但组合净值必须日频计算。

新增市场价格表：

```sql
market_prices_daily (
  symbol,
  date,
  close,
  adjusted_close,
  source,
  fetched_at
)
```

---

## BT-03 回测页面实际仓位状态机

不要只测试：

```text
score > 55 → 1
else → 0
```

测试建议：

| 状态 | 初始测试仓位 |
|---|---:|
| 强顺风 | 100% |
| 普通顺风 | 90% |
| 中性 | 75% |
| 谨慎 | 50% |
| 逆风 | 25% |
| Stress | 0%–25% |
| Unknown | 不高于中性档 |

先验证无杠杆版本，再考虑 100% 以上敞口。

---

## BT-04 加入现金收益和交易成本

加入：

```text
现金收益：3M T-bill 或 SOFR
融资成本：超过 100% 敞口时
手续费
滑点
高波动期额外滑点
```

页面显示所有假设。

---

## BT-05 增加公平基准

至少比较：

```text
100% SPX
与策略平均 Beta 相同的静态 SPX/现金组合
波动率目标 SPX
200 日均线风险控制
```

报告：

```text
总收益
择时 alpha
平均 Beta
波动率
Sharpe
Sortino
最大回撤
回撤持续时间
```

---

## BT-06 Purged Walk-Forward

同时报告：

```text
重叠样本 IC
非重叠 IC
Bootstrap CI
Purged walk-forward
完全冻结 holdout
```

不要把重叠窗口数量当成独立样本量。

---

## BT-07 修正命中率定义

分别报告：

```text
方向命中率
正式 verdict 命中率
风险命中率
IC
尾部风险识别率
```

---

## BT-08 分数单调性

按分数桶报告：

```text
0–20
20–35
35–45
45–55
55–65
65–80
80–100
```

每桶：

```text
4/8/13 周平均收益
中位数收益
负收益概率
10% 尾部收益
最大回撤
样本量
```

---

## BT-09 多重检验控制

候选因子研究必须记录：

```text
测试过多少候选
多少方向
多少窗口
多少参数
```

增加：

```text
Benjamini-Hochberg FDR
Deflated Sharpe Ratio
预登记方向
预登记通过门槛
```

---

## BT-10 历史压力测试库

固定重放：

```text
2018 Q4
2019 回购压力
2020 疫情
2021 TGA / RRP 结构变化
2022 加息与 QT
2023 区域银行危机
2024 日元套利平仓
2025–2026 准备金管理阶段
```

每次模型修改自动生成对比报告。

---

# 8. Phase 4 — 核心算法 Challenger

所有项目先影子运行，不直接替换 Champion。

## ALG-01 净流动性拆成三个维度

后端输出：

```text
netliqLevel
netliqChange1w
netliqImpulse4w
netliqTrend13w
netliqGapTo13wMA
netliqAcceleration
```

前端示例：

```text
1 周：−36B
4 周：+174B
13 周：高于均线 +1.5%
```

---

## ALG-02 连续化净流动性评分

候选公式：

```text
gap13 =
  (netliq - SMA13)
  / rollingMAD(netliq - SMA13, 156w)

impulse4 =
  Δ4w netliq
  / rollingMAD(Δ4w netliq, 156w)

impulse13 =
  Δ13w netliq
  / rollingMAD(Δ13w netliq, 156w)

score =
  sigmoid(
    0.45 * gap13
  + 0.35 * impulse4
  + 0.20 * impulse13
  )
```

要求：

- expanding window；
- 无未来数据；
- MAD 优先于标准差；
- 与旧模型并行；
- 只有 OOS 稳健改善才替换。

---

## ALG-03 Raw 与 Smooth 双轨净流动性

```text
Raw =
  WALCL Wed
  − WDTGAL Wed
  − RRP as-of

Smooth =
  WALCL Wed
  − WTREGEN week average
  − SMA5(RRP)
```

规则：

```text
同方向 → 高置信
反方向 → 过渡/低置信
```

---

## ALG-04 TGA 冲击乘以缓冲池状态

建立：

```text
RRP 充足
RRP 低
RRP 耗尽
```

候选：

```text
effectiveTgaShock =
  ΔTGA * bufferMultiplier
```

阈值必须通过样本外验证，不能直接凭直觉上线。

---

## ALG-05 重构准备金充裕度

候选组成：

```text
30% 准备金 / GDP 或银行资产
25% 13 周准备金变化
25% SOFR−IORB 的中位数和 95 分位
20% EFFR−IORB、TGCR−IORB、SRF 使用量
```

状态：

```text
ABUNDANT
AMPLE
TRANSITION
SCARCE
STRESSED
```

要求：

- 高准备金但资金利差恶化时，分数必须下降；
- 季末单日跳升不得造成长期状态误判；
- 每个组件有独立 freshness。

---

## ALG-06 政策阶段事件化

新增：

```sql
policy_regimes (
  effective_from,
  effective_to,
  regime,
  source_document,
  approved_by,
  created_at
)
```

枚举：

```text
QE
QT
RESERVE_MANAGEMENT
REINVESTMENT_ONLY
CRISIS_LIQUIDITY
NEUTRAL
UNKNOWN
```

不再只依赖硬编码日期。

---

## ALG-07 资产负债表扩张按政策阶段解释

建议：

```text
QE 扩表                    → 80
准备金管理扩表            → 55–60
正常再投资                → 50–55
危机工具扩张              → 独立危机状态
QT 缩表                    → 30
```

不允许把所有 WALCL 上升都等同于 QE。

---

## ALG-08 Credit / Funding Ablation

测试四臂：

```text
A 当前模型
B 移除 credit
C 移除 funding
D 两者移出基础分，进入 fragility / stress
```

评价：

```text
OOS IC
非重叠 IC
Beta 匹配 Sharpe
尾部损失
最大回撤
```

---

## ALG-09 修正等权基准

比较：

```text
8 因子等权
当前 8 因子权重
50% 等权 + 50% 当前权重
vol 独立 overlay
```

不要把 vol 重新放回基础等权模型。

---

## ALG-10 分离 4 周和 13 周模型

```text
Tactical Score（4 周）
Strategic Score（13 周）
```

最终仓位：

```text
战略分决定基础风险预算
战术分决定上下微调
```

---

## ALG-11 增加模型置信度

置信度组成：

```text
数据完整度
数据新鲜度
当前 regime 历史样本量
主要因子一致性
Raw / Smooth 是否同向
```

输出：

```text
score
confidence
reason
```

高分低置信不得给出激进仓位建议。

---

## ALG-12 多资产独立验证

分别验证：

```text
SPX
QQQ
IWM
HYG
```

共享宏观输入可以，但目标和仓位映射必须独立。

---

# 9. Phase 5 — 实时风控和组合映射

## RISK-01 Stress 严重度分数

把 bool 改成 0–100：

```text
VIX 水平和变化
SPX 5 日/20 日回撤
10Y 冲击
美元冲击
HY OAS 冲击
资金市场压力
```

状态：

```text
0–30    NORMAL
30–50   WATCH
50–70   CAUTION
70–85   HIGH_STRESS
85–100  CRISIS
UNKNOWN 数据不可用
```

---

## RISK-02 Stress 进入与解除迟滞

建议：

```text
进入：
  单次极端触发
  或连续两日中度触发

解除：
  全部指标恢复后连续 2–3 个交易日
```

---

## RISK-03 删除“高宏观分完全忽略 Stress”的硬豁免

强宏观环境只能减少降级幅度，不能覆盖危机级压力。

---

## RISK-04 仓位建议升级为风险预算

输出：

```text
目标 Beta
目标波动率
最大总敞口
最大单次变动
风险预算
允许加仓速度
```

---

## RISK-05 人工覆盖和审计

支持：

```text
AUTO
MANUAL_OVERRIDE
RISK_FREEZE
DATA_FREEZE
```

记录：

```text
操作者
原因
开始时间
结束条件
原模型建议
覆盖后建议
```

---

## RISK-06 TGA / 财政 Nowcast

作为独立层：

```text
未来 5 个工作日 TGA 方向
主要税期
国债结算
季度末现金管理
准备金冲击区间
```

Nowcast 不进入正式历史模型，除非完成 PIT 回测。

---

# 10. Phase 6 — 工程、生产和治理

## ENG-01 CI/CD

新增 npm scripts：

```json
{
  "typecheck": "tsc --noEmit",
  "lint": "...",
  "test": "vitest run",
  "deploy:dry": "wrangler deploy --dry-run"
}
```

CI：

```text
npm ci
typecheck
lint
unit tests
integration tests
migration dry-run
no-lookahead test
full-vs-incremental consistency test
deploy dry-run
```

---

## ENG-02 Dev / Staging / Production 分离

建立：

```text
dev Worker + dev D1
staging Worker + staging D1
production Worker + production D1
```

生产部署要求人工批准。

---

## ENG-03 模型版本和配置哈希

每个快照保存：

```text
model_version
config_hash
code_commit_sha
data_run_id
data_cutoff
decision_at
created_at
```

---

## ENG-04 API Schema 与版本化

使用 Zod 或等价方案验证：

```text
FRED
Yahoo
Snapshot API
Backtest API
Robustness API
```

API 版本：

```text
/api/v1/snapshot
/api/v1/backtest
```

---

## ENG-05 结构化日志和 SLO

日志示例：

```json
{
  "event": "fred_ingest",
  "run_id": "abc",
  "series_id": "WALCL",
  "status": "success",
  "rows": 1,
  "source_age_hours": 2,
  "duration_ms": 310
}
```

建议 SLO：

```text
页面可用率 >= 99.9%
正式数据发布后成功摄取率 >= 99%
关键快照失败必须告警
```

---

## ENG-06 备份和恢复

实施：

```text
每日关键信号导出
每周完整数据库导出
长期保存到 R2
定期恢复演练
```

---

## ENG-07 管理端点安全

对 `/api/admin/refresh`：

```text
Cloudflare Access / Service Token
权限隔离
Rate limit
Token 轮换
操作审计
全量重建二次确认
```

---

## ENG-08 缓存和熔断

不要每次页面访问都直接打 Yahoo。

增加：

```text
短 TTL 缓存
stale-while-revalidate
超时
重试
熔断
最近有效值
STALE 标记
```

---

## ENG-09 历史 As-Of 回放

允许选择历史时间，显示：

```text
当时可用数据
当时模型版本
当时裁决
当时建议仓位
之后 4/8/13 周表现
```

---

## ENG-10 导出和告警

导出：

```text
CSV
JSON
Webhook
每日信号
模型变更记录
```

告警：

```text
净流动性急降
4 周趋势反转
准备金状态恶化
SOFR−IORB 异常
信用利差扩大
score 穿越 45/55
stress 升级
数据源失效
模型版本变化
```

---

## ENG-11 Model Card

每个版本必须包含：

```text
用途
不适用场景
目标资产
时间框架
数据源
因子定义
权重
阈值
样本区间
OOS 结果
失败 regime
已知局限
回滚方法
```

---

## ENG-12 Champion–Challenger

生产：

```text
Champion：当前稳定模型
```

影子：

```text
Challenger A：连续净流动性
Challenger B：动态准备金
Challenger C：8 因子收缩权重
```

上线门槛：

```text
无前视
多数 OOS fold 为正
非重叠 IC 不恶化
Beta 匹配表现改善
尾部风险不恶化
逻辑可解释
```

---

# 11. 推荐 PR 拆分

## PR-01

```text
fix: preserve hysteresis state during incremental rebuild
```

内容：

- `snapshotBefore()`
- 初始化 `prev`
- full vs incremental 回归测试

---

## PR-02

```text
refactor: unify decision state and threshold boundaries
```

内容：

- 唯一状态机
- 45/50/55 边界测试
- guidance 读取统一结果

---

## PR-03

```text
fix: make live stress tri-state and fail closed
```

内容：

- NORMAL/STRESSED/UNKNOWN
- 数据源失败测试
- 前端 UNKNOWN 显示

---

## PR-04

```text
feat: add per-series freshness and factor data quality
```

内容：

- `asOfFresh`
- series freshness config
- FactorResult
- DATA_INCOMPLETE

---

## PR-05

```text
refactor: split official weekly snapshots from daily nowcasts
```

内容：

- [x] 新表和 WALCL 节奏保守迁移
- [x] API 显式返回 `official` / `nowcast`
- [x] backtest / walk-forward / robustness 只读 official
- [x] full rebuild 只写 official，incremental 只写 nowcast
- [x] 前端标注“正式信号”与“周中预估 · PROVISIONAL”

---

## PR-06

```text
feat: atomic ingest runs and staging activation
```

内容：

- [x] `ingest_runs` 的 RUNNING / ACTIVE / FAILED / SUPERSEDED 审计状态
- [x] `ingest_series_attempts` 与 run-scoped `staging_observations`
- [x] 单个 ACTIVE run 与 `observations` 兼容生产视图的原子激活
- [x] 带过期时间、owner-scoped release 的数据库并发锁
- [x] 租约覆盖激活后的读取、外部 DXY、每次 snapshot 写入、metadata 与最终化
- [x] 手动 HTTP 409 与 scheduled typed conflict
- [x] fetch 前创建 series attempt，fetch / 结构校验 / staging 失败均持久化 FAILED
- [x] batch 内数据库 guard 阻止缺失或非 RUNNING target 的 promotion / ACTIVE demotion
- [x] 激活后才重建快照，且 full→official、incremental→nowcast 不变
- [x] ACTIVE run 持久化 snapshot PENDING / SUCCEEDED / FAILED、完成时间、错误与数量
- [x] health / snapshot API 暴露 ACTIVE、最近 FAILED run 与 snapshot outcome
- [x] 本地 migration、全量测试与 TypeScript strict 验证

---

## PR-07

```text
feat: persist source timestamps and provider fallback
```

内容：

- [x] Yahoo `regularMarketTime`、market state、delay 与 fetch time 分离
- [x] Yahoo / Stooq / FRED typed provider abstraction，fetch 可注入
- [x] SPX / VIX / DXY / 10Y quote 与 live-stress history fallback
- [x] DXY 日线 extension 走相同主备源且保持原 scale/chaining 语义
- [x] 命名数据质量容差与共同日期窗口 divergence 检查
- [x] `OK` / `STALE` / `DIVERGENT` / `FAILED` 和 `SOURCE_DIVERGENCE`
- [x] stress 对 FAILED / STALE / DIVERGENT 必需输入 fail closed
- [x] `/api/snapshot`、`/api/prices` 与前端显示实际 source/fetch/provider/market status
- [x] 无 migration；全量测试与 TypeScript strict 本地验证
- [x] 全品种 Yahoo→Stooq（可用时）→FRED 官方 fallback，显示实际 instrument
- [x] 未来时间戳/空值/challenge 拒绝、provider timeout、market-state 白名单与 UI provenance 转义
- [x] 按 VIX 水平、SPX/DXY 5 日收益、10Y 5 日百分点变化执行语义一致性检查

---

## PR-08

```text
feat: point-in-time observation storage
```

内容：

- [x] ALFRED vintage schema 与 inclusive checkpoint
- [x] `released_at` / `fetched_at` / `tradable_at` 与 release calendar override
- [x] append-only raw observations、revision view 与原子激活
- [x] 惰性 event-time no-lookahead frame；`data_cutoff` / `tradable_at` 覆盖完整评分历史
- [x] `snapshot_inputs` 冻结每序列 endpoint audit index；原始行 + `decision_at` + `release_resolution_at` 可重放完整评分历史
- [x] release calendar 按 vintage 唯一选取版本，缺失/重叠 fail closed；override append-only 版本化并按 post-fetch 固定 resolution cutoff 解析
- [x] raw universe 同时冻结 `fetched_at <= release_resolution_at`；正式 event 排除 cutoff 后的 resolved release
- [x] weekly/daily PIT cutoff 冻结后，DB trigger 拒绝 backdated 或 equal-cutoff override；无冻结快照时仍允许历史 override
- [x] weekly/daily PIT cutoff 冻结后，DB trigger 拒绝 backdated 或 equal-cutoff 的新 raw vintage；初始历史装载与同主键幂等 replay 保持可用，违规 activation 原子回滚且不切换 ACTIVE
- [x] strict canonical ISO/epoch 比较与 SQL `julianday` cutoff/排序，覆盖混合毫秒精度及不存在日期
- [x] legacy 一次升级；任何既有 PIT 正式快照均冻结，包括异常 `data_run_id IS NULL` 行；迟滞锚点按完整 decision week 读取
- [x] 本地 fresh migration 首次应用与二次幂等检查、477 tests 与 TypeScript strict 验证（实现 commits `07f7c81..37fd6c4`）

PR-08 已知限制：ALFRED 历史只提供 vintage 日期时仍使用保守日末发布时间；默认 next-weekday 规则尚未覆盖美股假日。resolver 不再保留全部 frame，但当前服务仍一次加载并排序 cutoff-visible PIT 行；stored timing 异常检查只返回至多一条坏行，不再额外物化全表。`snapshot_inputs` 仅是 endpoint audit index，不应被解释为全部评分行 manifest。这些限制留给 PR-09 的交易日历/执行引擎或独立的流式数据库读取改造，不在 PR-08 扩展模型公式、权重或阈值。

PR-08 回滚：完整本地 PR 使用 `git revert --no-commit e415f5d..HEAD` 后创建单独 revert commit；仅本地验证库可删除对应 `--persist-to` 临时目录后从 0001 重建。0008 尚未应用远程数据库；若未来已远程应用，不应回写或删除 append-only PIT 数据或移除冻结保护，应先停止新写入并以向前 migration 恢复兼容结构。

---

## PR-09

```text
refactor: event-time backtest engine
```

内容：

- [x] BT-01：正式 PIT 信号按 `17:00Z` 保守最早收盘 eligibility 选择同日/下一实际 SPX 行；`23:59:59Z` 仅为 accounting marker；同执行日取最新 decision，末端信号显式未执行
- [x] BT-02：SPX/VIX 日频表、SOFR 现金表、既有 observations 可审计 synthetic backfill、append-only revisions 与 scoped ingest activation 原子物化
- [x] BT-04：日频净值、SOFR ACT/360、手续费/滑点、高波动额外滑点与 >100% 融资支持
- [x] `/api/backtest?as_of=` 使用同一个 D1 strict-visibility cutoff 提供 `APPEND_ONLY_AS_OF` 正式 `event_time` 与 typed `DATA_INCOMPLETE`；旧周频与 robustness strategy 均标记 `LEGACY_WEEKLY`
- [x] 页面披露 eligibility/accounting 区别、strict cutoff、source/run provenance、现金、成本、VIX 保守政策与 legacy/event-time 区别
- [x] legacy 无 provenance writer 不可覆盖已冻结 PIT row/`recorded_at`，固定 `as_of` replay 保持不变（Important RED→GREEN）
- [x] 当前候选 head 的 29 files / 518 tests、TypeScript strict 与 diff-check
- [x] fresh local 0001–0009 migration 首次全部成功，紧接二次返回 `No migrations to apply!`
- [x] 固定 `37fd6c4..02f9e38` 的 review package 与 final rereview：Ready，0 Critical / 0 Important
- [x] BT-03：dashboard exposure tiers 仓位状态机（PR-10 本地候选）
- [x] BT-05：公平基准与尾部指标（PR-10 本地候选）

PR-09 已知限制：SPX/VIX 来自 FRED 指数收盘，`adjusted_close` 不包含股息；交易日历由现有 SPX 行自然形成，没有独立交易所 calendar。全年统一 `17:00Z` 只是不会晚于任何正常/early-close session 的保守 eligibility lower bound，并非真实交易所收盘时间。正式策略本 PR 仍沿用 `score>55 ? 100% : 0%` 兼容政策；exposure tiers、公平基准和尾部指标留给 PR-10。SOFR 缺失或超过 4 个日历日会 fail closed，NAV 为空且全部绩效 totals 为 null。Synthetic migration backfill 与 legacy/no-PIT rows 仅供审计，formal gate 会保持 `DATA_INCOMPLETE`，直到对应日期取得真实 PIT provenance；append-only correction 可通过相同 `as_of` cutoff 重放旧结果。

PR-09 回滚：完整本地代码可从 PR-09 base `37fd6c4` 对 reviewed head 做单独 revert；0009 仅在本地临时数据库验证且未部署。若未来已应用到共享数据库，不应删除/更新 append-only revision 表或绕过 triggers；应先停止依赖写入/读取，再以向前 migration 停用或迁移结构。本地验证库可丢弃对应临时 `--persist-to` 目录后从 0001 重建。

---

## PR-10

```text
feat: portfolio backtest aligned with dashboard exposure tiers
```

内容：

- [x] live guidance 与正式 PIT 回测共用单一数值仓位策略：100/90/75/50/25%，stress 25%，unknown 上限 75%，保留 score 65 豁免
- [x] 历史 stress 只读冻结 snapshot `vix_eod`（`PIT_SNAPSHOT_VIX_PROXY`），缺字段正式绩效 fail closed
- [x] 同一窗口比较 100% SPX、平均 Beta 静态组合、prior-only 20-session vol target、prior-close 200DMA
- [x] 全部组合共用 SOFR prior-date、费用、VIX 滑点与 incomplete gate
- [x] 报告总收益、相对 Beta 静态组合的累计择时收益差、平均 Beta、波动、Sharpe、Sortino、最大回撤与持续期；不足样本返回 null
- [x] review-fix 后 fresh full 31 files / 551 tests、TypeScript strict、diff-check、local 0001–0009 migrations twice
- [x] independent task/spec + whole-branch rereview：Ready，0 Critical / 0 Important；review 后 cache-bust TDD 17/17

PR-10 已知限制：SPX 是不含股息的 FRED 指数收盘；历史 stress 仅用冻结周快照 VIX 水平 proxy，不复建完整实时四资产 stress overlay。20-session 波动目标和 200DMA 可借用同一 `as_of` cutoff 已可见的 evaluation-window 前价格作 warm-up，但净值/成本严格从策略首个执行日开始；若整个可见历史仍不足 20/200 条则持有现金。Sharpe/Sortino 使用日频已含现金与成本的组合收益，不另减无风险利率；无负收益或零波动时相应比率返回 null。没有独立交易所 calendar，仍由 SPX 实际行定义 session。

PR-10 回滚：对 PR-10 base `f04d4b2` 之后的本 PR commit range 做专用 revert；本 PR 无 migration、无远程数据库变更，回滚不需要删表或改数据。PR-09 append-only 日频存储和 event-time API 基础保持不动。

---

## PR-11

```text
research: continuous net liquidity challenger
```

内容：

- [x] gap13 / impulse4 / impulse13，严格 prior-only 156 周 MAD、至少 52 周历史
- [x] Raw/Smooth 双轨、周三 observation / 审计后保守 `Wed+7` availability 与 HIGH/LOW/TRANSITION agreement
- [x] overlapping/non-overlapping IC、seeded moving-block bootstrap、固定六个日历 fold、quintile 与 disagreement diagnostics
- [x] 主 FRED CSV 当前版本 schema-v2 snapshot + manifest + exact id/cosd/coed URL/date range/SHA-256
- [x] 保留抓取前原预注册；初版报告标记 `INVALIDATED_BY_REVIEW`，corrected 报告一次性生成
- [x] 冻结结论 `INCONCLUSIVE`、决策 `DROP_RESEARCH`、`RESEARCH_CURRENT_VINTAGE`、replacementEligible=false
- [x] Shadow only；未修改 Champion、正式 API/快照、仓位或数据库
- [x] review-correction 后独立 task/spec 与 whole-branch rereview 均 Ready（0 Critical / 0 Important / 0 Minor）

PR-11 审计版本 `PR11_RESEARCH_V2_REVIEW_AMENDED`明确记录三项修订：节假日发布正确性使 availability 从 Wed+2 变为 `Wed+7`；7 日 SPX 行匹配上限属 `POST_FETCH_DATA_HYGIENE`而非原预注册；快照改为严格验证的 schema-v2 provenance。公式、权重、prior-only MAD、horizon、folds、bootstrap 与 gate 均未调参。

PR-11 corrected 实证摘要：Raw overlapping/non-overlapping IC 为 0.2655/0.2201（n=509/40），Smooth 为 0.2846/0.3229（n=509/40），agreement-confirmed 为 0.2959/0.1559（n=465/39），bootstrap 95% CI [0.1019, 0.4455]、p=0.0015，agreement rate 91.36%。固定六 fold 中两个因 FRED SP500 仅覆盖 2016-07 起而为空，2013–2016 可评估尾段为负，其余三个为正；空 fold 未动态重分，正 fold 数 3 未达到至少 4 个的未改变门槛。

PR-11 已知限制：本地 artifact 是 2026-07-22 抓取的 FRED 当前版本，不是 ALFRED/PIT，无法证明历史时点可见值；SP500 是不含股息的价格指数且只有约 10 年；`Wed+7` 保守 lag 只修复节假日周时序，不能修复 revision bias；本研究只报告 IC/排序，不是可交易组合回测。Snapshot/manifest 是未签名的 content-addressed artifact；若两者与全部哈希被协同替换，完整性依赖 Git object/commit 作为外部锚。

PR-11 回滚：回退 base `f803705` 后的 PR-11 commits 即可；本 PR 无 migration、无生产/远程数据库写入，不需要删除或恢复任何数据库数据。

---

## PR-12

```text
research: dynamic reserve adequacy challenger
```

内容：

- [x] 相对准备金与 13 周变化，严格 prior-only expanding percentile、至少 52 个完整 prior weeks
- [x] SOFR−IORB median/p95 与 EFFR/TGCR/SRF 辅助压力，同日配对、独立 freshness、缺失/陈旧 fail closed
- [x] ABUNDANT / AMPLE / TRANSITION / SCARCE / STRESSED 状态及高准备金但利差恶化降分、季度末 spike 不延续测试
- [x] next-Monday 13 周目标、overlap/non-overlap IC、seeded bootstrap、固定六 folds、quintile tail/monotonic gate
- [x] A-001 exact source 修正；A-002 将 NY Fed 边界冻结为 SRF 上线日 2021-07-29，v1 `INVALIDATED_BY_REVIEW`
- [x] schema-v2 FRED + NY Fed current-vintage snapshot/manifest，精确 URL/schema/row range/response+normalized+snapshot SHA-256 校验
- [x] corrected report 一次性生成：IC 0.2363/−0.0071（n=194/15），3 个正 fold，top tail gate 失败，决策 `DROP_RESEARCH`
- [x] `RESEARCH_CURRENT_VINTAGE`、replacementEligible=false；Shadow only，未改 Champion、API、快照、migration 或数据库

PR-12 corrected methodology 为 `PR12_RESEARCH_V2_SRF_BOUNDARY`。v1 在 fetch 后、正式发布前被审查发现包含 2021-07-29 之前的临时 Repo，已保留为无效审计件；v2 严格拒绝 launch 前行。NY Fed 小额 exercises 因没有无歧义字段而保留，可能夸大市场驱动的 SRF 使用，是明确限制。公式、权重、状态阈值、freshness、folds、bootstrap、OOS gate 与资格均未调参。

PR-12 实证摘要：这些结果仅是 current-vintage retrospective pseudo-OOS；GDP observation-date alignment is not release-aware。1231 个 Friday anchors 中 248 个完整、196 个在 52 prior weeks 后可评分；194 个成熟目标 overlapping IC 为 0.2363，15 个 interval-non-overlap IC 为 −0.0071；bootstrap 95% CI [−0.0492, 0.4805]、p=0.0515。六个固定 fold 中前两个为空，剩余四个只有三个为正；Q5 mean 高于 Q1，但 Q5 10% tail 更差，因此冻结 gate 给出 `DROP_RESEARCH`。

PR-12 回滚：回退 base `ba74a6c` 后的 PR-12 commits。没有 migration 或生产/远程数据写入，无需数据库回滚。

---

## PR-13

```text
feat: model versioning, CI, staging, observability and backup
```

内容：

- config hash
- commit sha
- CI
- logs
- alert
- backup

---

# 12. Codex 每个 PR 的标准输出

每完成一个 PR，必须提供：

```text
1. 修改摘要
2. 修改文件
3. 设计决策
4. 新增测试
5. 全部测试结果
6. 已知限制
7. 数据迁移说明
8. 回滚说明
9. 是否改变历史结果
10. 是否改变生产分数或仓位建议
```

---

# 13. 强制测试清单

## 正确性

- [x] full rebuild 与 incremental rebuild 一致
- [x] 45/50/55 阈值一致
- [x] stress 数据失败返回 UNKNOWN
- [x] 缺关键数据返回 DATA_INCOMPLETE
- [x] stale 序列不会无限 forward-fill
- [x] mixed vintage 不会进入生产
- [x] 同时运行 cron 和 refresh 不会并发写坏数据

## Point-in-Time

- [x] 发布前数据无法读取
- [x] 未来 vintage 无法进入历史信号
- [x] 观察日与发布日期区分
- [x] 每个快照列出每序列 endpoint audit index，完整评分历史可由 raw + 两个时间 cutoff 重放
- [x] 历史修订不会改变冻结快照

## 回测

- [x] 信号在 next tradable time 执行
- [x] 使用日频价格
- [x] 现金收益不为 0
- [x] 成本纳入
- [x] 与相同 Beta 基准比较（PR-10：仅按实际承担收益区间的 exposure 匹配）
- [x] overlapping 和 non-overlapping 分开（PR-11 shadow current-vintage research）
- [ ] purged walk-forward
- [ ] 分数桶大体单调
- [ ] 极端事件压力测试

## 工程

- [x] TypeScript strict 通过
- [x] 全部 Vitest 通过
- [x] worktree-local D1 migration apply 通过（未访问 remote D1）
- [ ] staging 部署通过
- [x] 结构化日志已实现并由测试验证（尚未部署，远程日志检索待 staging）
- [x] 失败告警可注入触发并审计（仅 fake endpoint 测试，未发送真实告警）
- [x] 数据库恢复演练通过（完全本地 fixture；生产备份恢复仍需授权）

---

# 14. 生产上线门槛

任何算法 Challenger 只有同时满足以下条件才可替换 Champion：

- [ ] Point-in-Time 数据；
- [ ] 无发布时点前视；
- [ ] 样本外多数 fold 为正；
- [ ] 非重叠 IC 不显著恶化；
- [ ] Beta 匹配后 Sharpe 或尾部风险改善；
- [ ] 成本翻倍后不崩溃；
- [ ] 关键历史事件没有明显退化；
- [ ] 逻辑可解释；
- [ ] 已影子运行；
- [ ] 有回滚方案；
- [ ] Model Card 已更新。

---

# 15. 最终专业版页面建议

Primary Screen：

```text
宏观环境：中性偏多
正式信号日期：YYYY-MM-DD
模型置信度：中
战略敞口：基准附近
战术调整：暂不加仓

净流动性：
1 周：−36B
4 周：+174B
13 周：高于均线 +1.5%

准备金状态：
AMPLE / TRANSITION / SCARCE

风险层：
NORMAL / WATCH / CAUTION / HIGH_STRESS / CRISIS / UNKNOWN

数据质量：
8/8 因子可用
官方数据截止
实时行情时间
模型版本
```

分析层：

```text
分数变化归因
净流动性 Raw / Smooth
TGA 冲击
准备金与资金利差
正式模型与 Challenger 差异
历史 As-Of 回放
回测与稳健性
```

---

# 16. 第一批最优先执行项

若一次只能处理六项，严格按以下顺序：

1. `P0-01` 增量重算迟滞状态；
2. `P0-03` 唯一决策状态机；
3. `P0-04` Stress 三态；
4. `P0-06` 每序列 freshness；
5. `P0-02` 正式周频与日频 nowcast 分离；
6. `P0-09` 原子摄取。

完成后，再开始 Point-in-Time 数据层。

---

# 17. 给 Codex 的第一条执行提示词

将下面内容直接交给 Codex：

```text
请阅读仓库 YSKM523/macro-liquidity 和根目录中的
CODEX_PROFESSIONAL_UPGRADE_PLAN.md。

本轮只执行 PR-01：
fix: preserve hysteresis state during incremental rebuild

要求：
1. 先定位 service.ts 中增量重算最近 14 天的逻辑；
2. 新增 snapshotBefore 或等价数据库查询；
3. 使用重算起始日期之前最近一条正式快照的 verdict 初始化 prev；
4. 不改变评分公式、权重或阈值；
5. 先补失败测试，再修复；
6. 增加 full rebuild 与 incremental rebuild 一致性测试；
7. 运行 npm test 和 npx tsc --noEmit；
8. 输出修改摘要、涉及文件、测试结果、已知限制和回滚方式；
9. 不执行部署，不修改生产数据库；
10. 如果发现正式周频与日频快照混合影响测试，只记录为后续问题，不在本 PR 顺手重构。
```

---

# 18. Definition of Done

专业版完成的定义：

```text
系统不只是能给出一个分数，
而是能证明这个分数：
- 使用了当时可见的数据；
- 在当时确实可交易；
- 可以完整复现；
- 缺数据不会误报安全；
- 回测与页面实际建议一致；
- 新算法经过冻结样本验证；
- 生产失败可发现、可告警、可恢复、可回滚。
```
