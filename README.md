# 美股流动性看板 · Macro Liquidity Dashboard

> 用美联储的「钱多钱少」判断美股顺不顺风。**净流动性 + 9 个加权因子** → **0–100 顺风指数** 和 **偏多 / 中性 / 偏空** 红绿灯,外加**实时风控覆盖层**和**「操作建议 · 仓位旋钮」**。

🔗 **在线**:https://macro-liquidity-dashboard.pp-account.workers.dev
📄 **算法说明(站内)**:[`/algorithm`](https://macro-liquidity-dashboard.pp-account.workers.dev/algorithm) · 全文 [`docs/ALGORITHM.md`](docs/ALGORITHM.md)

> ⚠️ **诚实定位**:这是一个**弱信号的宏观环境 / 风控仪表盘,不是择时预言机**。方向命中率仅 **~52%**(被市场 ~76% 的上涨漂移钳死),真正价值在 **IC / Sharpe 的风险排序**,不在猜涨跌。详见 [§ 诚实定位](#-诚实定位为什么别盯命中率)。**仅供研究 / 教育,不构成投资建议。**

---

## 这是什么

起点是一份 TradingView Pine 脚本(Ultimate Macro Command Center),改造成独立网页 dashboard:把美联储**净流动性**(QE/QT 背后真正驱动股市的「水位」)和一组宏观因子,合成一个对 **S&P 500** 环境的判断 —— 顺风(可多)、逆风(收一收)还是中性。核心卖点是把「**缩表却放水 / 扩表却收水**」这种**背离**显式讲出来,并配一套诚实的样本外验证。

---

## 架构

```mermaid
flowchart LR
  FRED["FRED API（宏观序列，唯一真相源）"] -->|"cron 每 3 小时"| W["Cloudflare Worker"]
  YH["Yahoo 主源 / Stooq + FRED 备用源（行情与 stress）"] -->|"每次请求"| W
  W -->|"分批 staging，原子激活"| D1[("D1：ingest runs / observations / official weekly / daily nowcast")]
  W --> ST["Static Assets：public/ 前端"]
  W -->|"/api/*"| U["用户浏览器"]
  ST --> U
```

- **单个 Cloudflare Worker** 托管前端(Workers Static Assets)、`/api/*` 接口和每日 `cron`。
- **FRED = 宏观历史与模型逻辑的唯一真相源**；实时行情层按 Yahoo → Stooq（可用时）→ FRED 官方序列降级，只影响顶部读数和 live-stress、**不入库且不改变宏观分**。FRED 映射为 SPX=`SP500`、VIX=`VIXCLS`、DXY=`DTWEXBGS`、10Y=`DGS10`。每个结果分别携带实际 instrument/provider 的行情时间和抓取时间；无合法 provider 时间戳时不会拿抓取时间代替。
- **D1**(SQLite)先按 `run_id` 保存逐序列尝试、兼容 staging 和 ALFRED vintage staging；全部校验通过后在一个 fenced 事务中更新兼容表 `observations`、追加 `observations_pit` 并切换唯一 ACTIVE run。失败 run 保留审计信息且不改变两张生产观测表。正式快照冻结完整 configured-series endpoint 索引，`cron` 每 3 小时增量更新 nowcast，正式历史只由全量 PIT 重建写入。

Point-in-Time 层使用 ALFRED `output_type=3`，从最后 `vintage_date`（含）继续抓取新值与修订。原始 vintage、正式 `snapshot_inputs` 和 release override 均 append-only；override 以 `(series_id, vintage_date, created_at)` 版本化，并按抓取/激活完成后固定的 `release_resolution_at` 选择当时已创建的最新版本。任一 weekly/daily PIT 快照冻结后，数据库拒绝插入 `created_at` 小于或等于任一既有非空 resolution cutoff 的 override，防止后来写入者通过 backdate 改写旧重放；尚无冻结 PIT 快照时仍允许录入历史 override。审计重放同时排除该 cutoff 之后才 `fetched_at` 的 late backfill，正式事件也排除 cutoff 之后才发布的 resolved release。同一 PIT 主键 checksum 冲突会让整批激活回滚。`snapshot_inputs` 是每个 configured series 的 endpoint audit index，并不是全部评分历史行；完整评分历史由原始 vintage、`decision_at` 与 `release_resolution_at` 重放。所有 PIT 时间戳先做 strict canonical ISO 校验并按 epoch 比较，SQL cutoff/排序使用 `julianday`，避免无毫秒与 `.sss` 混合精度的文本排序错误。ALFRED 只保证 vintage 日期，因此历史发布日期保守取当天 `23:59:59Z`，同日实际抓到的值使用 HTTP 成功响应后的 `fetchedAt`；默认可交易时间为之后下一个工作日 `14:30Z`。frame 的 `data_cutoff` 与可交易时间分别覆盖所有实际评分历史输入的最晚 `releasedAt` / `tradableAt`。该 weekday 规则尚不包含美股假日，PR-09 才会加入交易日历和执行引擎。

---

## 算法

### 1）净流动性

```
净流动性 = WALCL（Fed 总资产) − TGA（WDTGAL，财政部账户) − RRP（隔夜逆回购)
```

钱从 Fed 资产负债表流出、但被 TGA 重建或 RRP 抽走,股市拿到的「净水位」其实在降 —— 这就是看板要抓的背离。

### 2）9 个加权因子(权重由 10 年回测的因子 IC 校准,非按 IC 硬拟合)

| 因子 | 权重 | 13w IC | 直觉 |
|---|--:|--:|---|
| **netliqTrend** | 0.35 | +0.19 | 净流动性 13 周趋势(最强核心) |
| **dollar** | 0.18 | +0.16 | 弱美元 → 顺风 |
| **curve** | 0.15 | +0.17 | 收益率曲线(10Y−2Y)走陡 → 顺风 |
| **reserveAdequacy** | 0.12 | +0.12 | 银行准备金充裕度(RRP 见底后的新缓冲) |
| **credit** | 0.06 | −0.03 | HY 信用利差(level/momentum/fragility 三拆) |
| **impulse** | 0.05 | +0.08 | 资产负债表脉冲(扩/缩/平) |
| **rates** | 0.05 | +0.06 | Δ10Y 利率冲量(快速上冲 = 逆风) |
| **funding** | 0.04 | −0.04 | SOFR−IORB 资金压力 |
| **vol** | 0.00 | −0.25 | 稳健反指 → **移出打分**,进风控层 |

`score = clamp(Σ 因子 × 权重)` ∈ [0,100]。**红绿灯 + 迟滞**:`>55` 偏多,`<45` 偏空,`45–55` 维持上一日(死区防抖)。

### 3)评分流程

```mermaid
flowchart TD
  WALCL["WALCL Fed 总资产"] --> NL["净流动性<br/>WALCL − TGA − RRP"]
  TGA["WDTGAL 财政部 TGA"] --> NL
  RRP["RRP 隔夜逆回购"] --> NL
  NL --> F1["netliqTrend · 0.35"]
  DXY["广义美元 DTWEXBGS"] --> F2["dollar · 0.18"]
  CV["10Y−2Y 曲线斜率"] --> F3["curve · 0.15"]
  RS["银行准备金"] --> F4["reserveAdequacy · 0.12"]
  HY["HY OAS 信用利差"] --> F5["credit · 0.06"]
  IM["资产负债表脉冲"] --> F6["impulse · 0.05"]
  RT["Δ10Y 利率冲量"] --> F7["rates · 0.05"]
  FD["SOFR−IORB"] --> F8["funding · 0.04"]
  F1 --> S["加权 0–100<br/>顺风指数"]
  F2 --> S
  F3 --> S
  F4 --> S
  F5 --> S
  F6 --> S
  F7 --> S
  F8 --> S
  S --> V{"红绿灯 + 迟滞<br/>&gt;55 偏多 · &lt;45 偏空"}
  STR["VIX / SPX / 美元<br/>5 日急变"] --> OV["live-stress 覆盖层"]
  V --> OV
  OV --> DV["display_verdict"]
  DV --> G["操作建议 · 仓位旋钮"]
```

### 4)live-stress 实时风控覆盖层

近 5 个交易日任一触发(`VIX>28` / `SPX 5日<−4%` / `10Y 5日>+0.25pp` / `美元 5日>+2%`)→ 把**显示**结论降一级(偏多→中性→偏空),但**宏观 score 不变、不入库**。强环境(score≥65)压过短期噪音、不降级。主源失败但备用源有效时继续工作并显示实际 provider/instrument；任一必需历史为 `FAILED`、`STALE` 或 `DIVERGENT` 时，live-stress 返回 `UNKNOWN` 并暂停风险增加。历史一致性按各品种的同一 stress 语义比较（VIX 水平、SPX/DXY 5 日收益、10Y 5 日百分点变化），触发分类不同或差异超过命名容差均 fail closed。

### 5)操作建议 · 仓位旋钮

把读数翻译成**相对基准的仓位档**(不假设你的具体仓位):偏多+净流动性在放 → `基准 +15~20pp`;中性 → `基准`;偏空+净流动性在收 → `基准 −15~20pp`;stress 触发 → `刹车`。并给出背离提示和两个触发点(分数跌破 45 / stress 触发)。

---

## 🎯 诚实定位(为什么别盯命中率)

| 前瞻 | 市场上涨比例(=「永远做多」命中率) | 本模型方向命中 |
|---|--:|--:|
| 13 周 | **76.2%** | ~52% |

市场大多数时候在涨,所以**方向命中率是个误导性指标** —— 想把它拉到 76% 的唯一办法是让模型永远偏多,那就废了。**本模型的价值在排序 / 风控**:它更看空时,未来收益更低、回撤更集中 —— 这被 **IC(综合 +0.255 @13w)** 和 **Sharpe(1.10,风险调整后跑赢买入持有)** 捕捉。**正确的记分牌是 IC / Sharpe / 躲回撤,不是命中率。**

---

## 验证(诚实的样本外检验)

- **`/api/backtest`** —— 对 4/8/13 周 SPX forward return 算综合分 IC、命中率、逐因子 IC、long/flat 策略 Sharpe。阈值固定 + percentile expanding-window(无前视)。
- **`/api/walkforward`** —— 扩窗 train → embargo → OOS test 滚动,三臂对比(WF 自动拟合 / 等权 / 当前手调)。**裁决:自动调权过拟合;等权 ≈ 手调;edge 在因子选择不在精确权重。**
- **综合 IC@13w 轨迹**:`0.127 → 0.195 → 0.208 → 0.227 → 0.255`,**Sharpe 0.83 → 1.10**,每步有回测撑腰。
- **负结果归档(`docs/ALGORITHM.md` §10)**:测过「全球央行流动性(Fed+ECB+BOJ)领先美股」—— 24 年两种构造都**弱、regime 不稳、不比 Fed-only 强 → 不采用**。离线研究脚本见 [`scripts/`](scripts/)。

---

## 数据源(FRED)

| 序列 | 含义 | 用途 |
|---|---|---|
| `WALCL` | Fed 总资产 | 净流动性 + 脉冲 |
| `WDTGAL` / `WTREGEN` | 财政部 TGA | 净流动性 |
| `RRPONTSYD` / `RPONTSYD` | 隔夜逆回购 / 回购 | 净流动性 |
| `WRBWFRBL` | 银行准备金 | reserveAdequacy |
| `SOFR` / `IORB` | 担保隔夜 / 准备金利率 | 资金面 |
| `BAMLH0A0HYM2` | HY OAS 信用利差 | credit |
| `DGS10` / `T10Y2Y` | 10Y 收益率 / 曲线斜率 | rates / curve |
| `DTWEXBGS` | 广义美元 | dollar |
| `VIXCLS` | VIX | 风控层 |
| `SP500` | 标普 500 | 历史图 + 回测 |

> ⚠️ 单位坑:`WALCL`/`WDTGAL`/`WTREGEN`/`WRBWFRBL` 来自 H.4.1 是**百万**;`RRPONTSYD`/`RPONTSYD` 来自临时公开市场操作是**十亿**。

---

## 技术栈

- **Cloudflare Worker**(TypeScript)+ **Workers Static Assets** + **D1**(SQLite)+ **Cron Triggers**
- 数据:**FRED**(宏观与官方行情 fallback)+ **Yahoo / Stooq**(实时价格)
- 前端:原生 HTML / CSS / JS + 自托管 [Lightweight-Charts](https://github.com/tradingview/lightweight-charts),仿 Stripe 纯色风格
- 测试:**Vitest**(474 测试，覆盖模型逻辑、原子摄取、PIT/vintage、冻结 endpoint audit index、provider fallback、锁与 API)
- 部署:`wrangler`

---

## 项目结构

```
src/
  metrics.ts      纯函数打分大脑(computeSnapshot / 各 scoreXxx / buildGuidance)
  config.ts       SERIES / WEIGHTS / 阈值
  backtest.ts     /api/backtest（IC / 命中率 / Sharpe）
  walkforward.ts  /api/walkforward（样本外裁决）
  service.ts      FRED staging / 原子激活 / 回填流水线
  worker.ts       路由 + snapshot 组装（display_verdict / live_stress / guidance）
  db.ts           D1 读写、ingest run、租约锁与激活事务
  prices.ts       Yahoo/Stooq/FRED provider、行情 provenance、fallback/divergence 与 live-stress
public/           前端：index.html / app.js / styles.css / algorithm.html
docs/             ALGORITHM.md（算法全文）/ ROADMAP / qeqt（分析师评审）
scripts/          全球流动性长史研究（离线，Fed+ECB+BOJ vs SPX）
test/             Vitest
migrations/       D1 schema（ingest/staging + latest observations + append-only PIT + official endpoint index + snapshots）
```

---

## API

| 端点 | 说明 |
|---|---|
| `GET /api/snapshot` | 显式 `official` 正式信号 + `nowcast` 周中预估(`PROVISIONAL`) + guidance + live_stress + ACTIVE/最近 FAILED ingest run（含 snapshot outcome） |
| `GET /api/health` | 数据健康度 + 当前 ACTIVE / 最近 FAILED ingest run 与 `PENDING`/`SUCCEEDED`/`FAILED` snapshot 状态；ACTIVE snapshot 非 `SUCCEEDED`（包括 `PENDING`）返回 503 和显式原因 |
| `GET /api/history?from=YYYY-MM-DD` | 正式周频净流动性 / SPX 历史(画图用) |
| `GET /api/prices` | 兼容数字字段 + 每个行情的 `sourceTimestamp` / `fetchedAt` / provider / market state / delay / fallback / quality status；`asof` 明确只代表 `FETCH_TIME`。FRED 官方 fallback 显式标记 `OFFICIAL`/延迟：SP500、VIXCLS、DGS10 最长 4 个工作日，DTWEXBGS 最长 7 个工作日 |
| `GET /api/backtest` | IC / 命中率 / 逐因子 IC / 策略 Sharpe |
| `GET /api/walkforward` | 样本外三臂裁决 |
| `POST /api/admin/refresh` | 回填(Bearer `ADMIN_TOKEN`;`?all=1` 全量)；已有有效 ingest 租约时返回 `409` |

---

## 本地开发

```bash
npm install
# 准备密钥(已 gitignore,切勿提交)
printf 'FRED_API_KEY=你的key\nADMIN_TOKEN=随便一个长随机串\n' > .dev.vars
npm test            # Vitest
npx wrangler dev    # 本地起 Worker
```

部署:`npx wrangler deploy`(D1 需先 `wrangler d1 migrations apply`,密钥用 `wrangler secret put`)。

---

## 免责声明

本项目仅作**研究与教育**用途,**不构成任何投资建议**。模型是弱信号宏观仪表盘,请勿据其单次信号 all-in / all-out,并结合你自己的风险管理与判断。

**作者:[YSKM523](https://github.com/YSKM523)**

---

## 许可 License

[MIT](LICENSE) © 2026 YSKM523
