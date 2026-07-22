# 美股流动性看板 — 总体逻辑与算法(v2,当前线上)

> 线上:https://macro-liquidity-dashboard.pp-account.workers.dev
> 本文件描述**当前**实现(`src/metrics.ts` + `src/config.ts` + `src/backtest.ts`)。v2 改造历程与依据见 `docs/ROADMAP-algo-v2.md`、分析师评审 `docs/qeqt.md`。实时数值以 `/api/snapshot`、`/api/backtest` 为准。

---

## 0. 一句话

**用美联储的"钱多钱少"判断美股顺不顺风。** 净流动性 + 9 个加权因子(含收益率曲线;vol 权重 0、移入风控层)算出一个 **0–100 顺风指数**和 **偏多/偏空/中性** 红绿灯;另有一个**实时风控覆盖层**在市场急变时下调显示结论。

## 1. 它回答的问题 + 诚实定位

回答:**"现在的宏观流动性环境,对美股是顺风还是逆风?"**——慢变量、仓位级(周/月尺度),不是日内择时。

**诚实定位(来自 10 年回测,见 §6)**:这是一个**弱信号的宏观 regime / 风控仪表盘**——综合分对未来 13 周 SPX 的秩相关 IC≈0.23、方向命中率仅~52%、长/空仓策略年化跑输买入持有(但 Sharpe 更高、更会躲回撤)。**它告诉你"现在是顺风还是该收一收",不保证跑赢大盘。**

## 2. 数据(口径隔离)

两套数据故意分开:慢逻辑全用 FRED(dated、可回溯),实时价格只做顶部显示 + 风控覆盖。

### 2.1 FRED = 历史与逻辑的真相源(每 3 小时增量入库)
| 序列 | 含义 | 频率 | 单位处理 | 用途 |
|---|---|---|---|---|
| `WALCL` | Fed 总资产 | 周三 | 百万→÷1000=十亿 | 净流动性 + 资产负债表脉冲 |
| `WDTGAL` | TGA(**周三水平**) | 周三 | 百万→÷1000 | **净流动性减项(主)** |
| `WTREGEN` | TGA(周平均) | 周三 | 百万→÷1000 | 备用(暂不参与打分) |
| `WRBWFRBL` | 银行准备金(周三) | 周三 | 百万→÷1000 | **reserveAdequacy** |
| `RRPONTSYD` | 隔夜逆回购 | 日 | 十亿 | 净流动性减项 |
| `RPONTSYD` | 隔夜回购 | 日 | 十亿 | 应急(尾部) |
| `SOFR`/`IORB` | 担保隔夜/准备金利率 | 日 | % | 资金压力(SOFR−IORB) |
| `BAMLH0A0HYM2` | HY OAS 信用利差 | 日 | % | 信用 |
| `DGS10` | 10Y 收益率 | 日 | % | 利率冲量(Δ20日) |
| `T10Y2Y` | 收益率曲线斜率(10Y−2Y) | 日 | % | curve(领先指标) |
| `VIXCLS` | VIX | 日 | 指数 | (打分权重 0;见 §4 vol) |
| `DTWEXBGS` | 广义美元 | 日 | 指数 | 美元 |
| `SP500` | 标普 500 | 日(滞后1天,~10年) | 指数 | 历史图 + 回测 |

> ⚠️ 单位坑:`WALCL`/`WDTGAL`/`WTREGEN`/`WRBWFRBL` 来自 H.4.1,是**百万**;`RRPONTSYD`/`RPONTSYD` 来自临时公开市场操作,是**十亿**。
> 📌 TGA 用 **`WDTGAL`(周三水平)**,与 WALCL 周三口径对齐(周平均 `WTREGEN` 会平滑掉真实回抽)。

### 2.2 实时价格(不入库)
- 顶部显示与近月历史:SPX/VIX/DXY/10Y 按 Yahoo(主)→Stooq(可用时)→FRED 官方序列 fallback，每次请求现拉。FRED 映射依次为 `SP500` / `VIXCLS` / `DTWEXBGS` / `DGS10`。
- **风控覆盖层**:另拉近 1 个月日线,算 5 日变化(见 §5)。
- 美元口径:主源顶部 = ICE DXY(`DX-Y.NYB`,仅展示);FRED fallback 是不同 instrument 的广义美元 `DTWEXBGS`，API/界面显示实际 symbol/label，不做跨 instrument 点位比较；历史只在共同日期比较标准化变化。打分仍使用 `DTWEXBGS`(可回溯)。

## 3. 总体逻辑

```
        ┌──────────────────────────────────────────────────────┐
 FRED ─▶ │ 净流动性(核心) · 资产负债表脉冲+政策标签 · 7因子加权 │
        └───────────────────────┬──────────────────────────────┘
                                ▼
                  0-100 顺风指数 ─分带+迟滞─▶ 宏观 verdict 偏多/偏空/中性
                                ▼
              实时价格 ─▶ live-stress overlay ─▶ display_verdict(显示用,可被下调)
```

- **净流动性 = WALCL − WDTGAL(TGA) − RRP**:真正在市场里流动的钱。核心驱动。
- **资产负债表脉冲**(EXPANDING/CONTRACTING/FLAT,按 WALCL 13 周变化)+ **独立政策标签**(QE/QT/RESERVE_MGMT,按 2025-12-01 QT 结束日期派生)——机械方向与政策叙事分开,不把技术性扩表叫"QE"。
- **背离**显式表达:如"缩表却放水→净流动性仍升→偏多"。
- **live-stress overlay**:实时风险只改**显示**结论,**绝不污染宏观分**。

## 4. 算法:9 因子加权 0-100

通用工具:`clamp(x)=max(0,min(100,x))`;`linMap(x,a,b)=clamp((x−a)/(b−a)·100)`;`sma`/`asOf`/`changeOverDays` 同前;净流动性按**真周度**序列算 13 周趋势与方向(死区 ±0.2%)。

**权重经 10 年回测的因子 IC 校准**(温和的 IC 方向倾斜,非按 IC 比例硬拟合 —— walk-forward 警告别过度调权,见 §6.1):

| 因子 | 权重 | 13w IC | 公式 / 直觉 |
|---|--:|--:|---|
| **netliqTrend** | **0.35** | +0.19 | `0.5·aboveMA + 0.5·linMap(4周斜率,−200,200)`。最强、最稳健的核心 |
| **dollar** | **0.18** | +0.16 | `linMap(z,1,−1)`,z=(DXY−SMA200)/σ。弱美元→顺风 |
| **curve** | **0.15** | +0.17 | `0.5·linMap(10Y−2Y斜率,−0.5,1.5)+0.5·linMap(Δ20日,−0.3,0.3)`。收益率曲线:陡/走陡→顺风。**唯一经 walk-forward 验证、真正加分的新因子**(把零调参等权 OOS IC 0.206→0.252) |
| **reserveAdequacy** | **0.12** | +0.12 | `0.5·linMap(准备金,2800,3800)+0.3·linMap(Δ13周,−300,300)+0.2·linMap(SOFR−IORB,0.10,0)`。RRP 见底后的新缓冲 |
| **credit** | **0.06** | −0.03 | `0.55·calm+0.45·momentum−fragility`(level/momentum/fragility 三拆;低且**上行**才危险) |
| **impulse** | **0.05** | +0.08 | 资产负债表脉冲:EXPANDING 80 / FLAT 55 / CONTRACTING 30 |
| **rates** | **0.05** | +0.06 | `linMap(Δ10Y 20日,+0.5,−0.5)`;收益率快速上冲=逆风 |
| **funding** | **0.04** | −0.04 | `linMap(SOFR−IORB,0.10,0)`;资金压力传感器 |
| **vol** | **0.00** | −0.25 | **不进打分**(回测稳健反指)→ 移入 live-stress overlay(§5) |

权重和 = 1.00。`score = clamp(Σ 因子·权重)`。

**红绿灯 + 迟滞**:`score>55`→偏多,`<45`→偏空,`45–55`→维持上一日(死区=迟滞防抖)。
**背离文案**:`CONTRACTING & 方向UP`→"缩表却放水";`EXPANDING & 方向DOWN`→"扩表却收水"。

## 5. live-stress 实时风控覆盖层

实时近 5 个交易日,任一触发即"实时风险":`VIX>28` · `SPX 5日<−4%` · `10Y 5日>+0.25pp` · `美元 5日>+2%`。

```
display_verdict = (stressed && macro_score < 65) ? 降一级(BULLISH→NEUTRAL→BEARISH) : 宏观 verdict
```
触发时前端显示琥珀横幅 + 把大标签换成降级后的 `display_verdict`,但**宏观 score/verdict 不变、不入库**。强环境(score≥65)压过短期噪音,不降级。

行情与近 5 日历史统一走 typed provider contract：四个品种均按 Yahoo→Stooq（可用时）→FRED 官方序列 fallback。每个结果记录实际 `sourceSymbol`/`sourceLabel`、provider 的 `sourceTimestamp` 与调用方 `fetchedAt`；未来时间戳、非法日历/时间、空值和 HTML/JavaScript challenge 会被拒绝，命名超时阻止单个 provider 无限挂起。数据质量状态为 `OK / STALE / DIVERGENT / FAILED`。历史只在共同日期按各品种 stress 语义比较：VIX 最新水平、SPX/DXY 5 日收益率、10Y 5 日百分点变化；stress 分类不同或指标差异超过 `MARKET_DATA_QUALITY.historyReturnTolerance` 时返回 `SOURCE_DIVERGENCE`。`DTWEXBGS` 沿用其 7 个工作日发布滞后窗口，且不与 ICE DXY 做点位比较。任何必需 stress 输入非 `OK` 都 fail closed 为 `UNKNOWN`，有效 fallback 则可继续使用。以上容差只用于数据质量，不属于 Champion 评分或 stress 触发阈值。

## 6. 验证器 `/api/backtest`(诚实的样本外检验)

阈值是固定启发式、percentile 是 expanding-window(无前视)→ 全历史 IC/Sharpe 本身即样本外。对 4/8/13 周 SPX forward return 算:综合分 IC(spearman/pearson)+ 命中率;**逐因子 IC**(指导配权);long/flat 策略 Sharpe vs 买入持有。

正式绩效块为 `event_time`：只接受 `decision_status=OK`、`pit_status=PIT` 且具有 `decision_at/tradable_at` 的周频正式信号，在 `tradable_at` **严格之后**第一个实际 SPX 日线的 `23:59:59Z` 收盘执行；同一收盘只采用最新 `decision_at`。净值逐个实际交易日按前一收盘敞口结算，空闲现金使用区间起点**之前日期**的最新 SOFR（保守反映次工作日发布、拒绝同日 fixing 前视）、ACT/360 简单计息。每单位换手收 1bp 手续费 + 2bps 基础滑点；VIX≥28、VIX 陈旧或缺失时再加 3bps。超过 100% 敞口的通用引擎按 SOFR + 100bps 融资，但本 PR 的兼容目标仍只是 `score>55 ? 100% : 0%`。SPX `adjusted_close` 明确是 FRED SP500 指数收盘，不代表含股息总回报。

SOFR 缺失/超过 4 个日历日、没有可执行信号或不足两个执行后交易 session 时，`event_time` 返回 `DATA_INCOMPLETE`：`nav=[]`，且 `totalReturn`、`tradingCostRate`、`sessions` 全部为 null，不展示部分或伪零绩效。旧 `strategy_long_flat` 继续服务历史比较，但显式标为 `LEGACY_WEEKLY`，不再是正式绩效路径。

当前 API 使用日频表的**当前修订值**，provenance 标记 `CURRENT_REVISION_MUTABLE`、严格 epoch 的最大 `fetched_at` cutoff、source 集合、run 数和 synthetic 状态，并明确 `responseReproducible=false`。未来 FRED correction 会改变既往回测；raw PIT 可审计和重建，但当前 payload 没有冻结完整输入，所以响应本身不能独立复现。

**`LEGACY_WEEKLY` 当前实测(2016-06→2026,534 快照,10 年；非正式 event-time 指标):**
- 综合分 IC@13周 **0.255**(8周 0.149,4周 0.106);**命中率 ~52%**(为什么这么低、为什么是错指标,见 §6.2)。
- 因子 IC@13周:netliqTrend +0.19 > **curve +0.17** > dollar +0.16 > reserveAdequacy +0.12 > impulse +0.08 > rates +0.06 > credit −0.03 > funding −0.04 > vol −0.25。
- `LEGACY_WEEKLY` 策略 8.1%/年 vs 买入持有 13.6%,Sharpe 1.10（仅历史诊断）。
- v2 改造的 IC 轨迹:0.127(起点)→0.195(去 vol)→0.208(信用三拆)→0.227(reweight)→**0.255**(加 curve)。每步都有回测撑腰。

### 6.1 walk-forward 样本外裁决(`/api/walkforward`)

扩窗 train → embargo(≥horizon)→ 样本外 test 滚动(6 folds,296 OOS 观测,13 周),三臂对比:

| 权重方案(9 因子,含 curve) | OOS IC | 命中率 |
|---|--:|--:|
| WF 自动拟合(train 内 IC 定权) | **0.125** | 47% |
| 等权(零调参,不偷看数据) | **0.252** | 66% |
| 当前手调权重(有 in-sample 污染,别全信) | 0.402 | 60% |

**三条硬结论:**
1. **别让数据自动选权重** —— 自动按 IC 调权在 10 年样本上过拟合(WF 臂远低于等权);**选对因子 > 精调权重**。
2. **curve 是真加分**:把它加进因子集,零调参的等权 OOS IC 从 0.206 升到 **0.252**,且它在**每个 fold 都被选进 top-2** —— 这是真·正交信号,不是过拟合(其它改动多是 in-sample 调权)。
3. **别把权重当精密科学**:等权与手调在样本外差不多;edge 在因子集合,不在精确权重。

### 6.2 ⚠️ 为什么"方向命中率 ~52%"是个**误导性指标**(必读)

| 前瞻 | **市场上涨比例**(="永远看多"的命中率) | 本模型方向命中 |
|---|--:|--:|
| 4 周 | 69.1% | ~53% |
| 8 周 | 73.2% | ~52% |
| 13 周 | **76.2%** | ~52% |

2016–2026,SPX 在 **76% 的 13 周窗口里是涨的**。所以:

> **一个"永远喊多"的傻瓜,命中率 76%;本模型 52%。** 作为**方向预测器,它远不如无脑做多** —— 因为市场大多数时候在涨,模型每次喊"不看多"基本都喊错。

**所以对带强上涨漂移的资产,"方向命中率"根本是错的记分牌。** 而且——**想把命中率拉到 76%,唯一办法是让模型永远偏多**(忽略宏观信号),那它就退化成 permabull、**彻底丢掉唯一价值**(提示何时减仓)。**追命中率 = 自毁。**

**本模型的价值不在猜涨跌,在排序/风控**:它更看空时,未来收益更低、回撤更集中 —— 这被 **IC(+0.255)** 和 **Sharpe(1.10,风险调整后跑赢买入持有)** 捕捉。**正确的记分牌是 IC / Sharpe / 躲回撤,不是命中率。**

## 7. 数据流水线 + 可信度

- `cron`(每 3 小时)→ 用 D1 当前时间获取数据库租约 → 建立序列 attempt → 以 ALFRED `output_type=3` 和 inclusive `realtime_start` 抓取 vintage → 双 staging → 完整性校验 → 单个 D1 事务更新兼容 `observations`、append-only `observations_pit`、SPX/VIX 日收盘与 SOFR 现金表并切换唯一 ACTIVE run → 按逐日 event-time cutoff 重算近 14 天 nowcast。日频表从相同 observation 的最新匹配 PIT vintage 继承真实 `source/fetched_at/data_run_id`；0009 对旧 compatibility rows 的 backfill 明确使用 synthetic migration provenance，后续同值 activation 仅在存在真实 PIT 行时升级。checksum 冲突、租约转移或任一语句失败都会让整批回滚。
- 存储:D1 保留运行审计和 latest compatibility view；`observations_pit` 以 series/observation/vintage 为不可变身份，`observation_revisions` 展示旧值、新值与修订幅度。正式 `model_snapshot_weekly` 保存 `data_run_id/data_cutoff/decision_at/tradable_at/pit_status`，并在同一 fenced batch 写入每个 configured series 恰好一行 `AVAILABLE`/`MISSING` 的 append-only `snapshot_inputs`。legacy 行只允许升级一次，PIT 正式行及其 manifest 永不覆盖；nowcast 保存 provenance 但不建立正式 manifest。
- 时间策略:数据只有在 `released_at <= decision_at` 时进入 frame；frame 的 `tradable_at` 是事件原值与全部实际评分历史行最晚可交易时间的最大值，正式 manifest 写入前再次 fail closed。ALFRED 历史 vintage 默认按日期末 `23:59:59Z` 发布，同日实际观测使用 HTTP 成功响应后的抓取时间；人工 override 在读取时覆盖时间语义、严格验证 ISO 顺序，但不修改 append-only raw。默认 tradable 是之后下一个工作日 `14:30Z`，尚未处理交易所假日，留给 PR-09。
- **coverage**:7 因子里几个用真实数据(非 50 兜底);**staleness**(前端:数据截至 X 天前)——缺数据不再静默装"中性可靠"。
- 纯逻辑 `src/metrics.ts` + `src/backtest.ts`,90+ 单测。

## 8. 一个真实算例(2026-06-17 线上)

`WALCL=6736.4B, TGA(WDTGAL)=956.5B, RRP=6.8B` → **净流动性 = 5773.1B**;准备金 `WRBWFRBL=2936.4B`(偏紧端);`HY OAS=2.63%`(极低)、`SOFR−IORB=−0.02`、`10Y=4.49%`、`DXY=119.5`、`VIX=18.4`。

收益率曲线 `T10Y2Y` 不陡(curve 因子 30.6)。

```
netliqTrend     28.3 × 0.35 =  9.91   (净流动性在收 → 趋势分低)
dollar          59.3 × 0.18 = 10.67
curve           30.6 × 0.15 =  4.59   (曲线不陡 → 偏低)
reserveAdequacy 38.7 × 0.12 =  4.64   (准备金偏紧且在降)
credit          93.3 × 0.06 =  5.60
impulse         80.0 × 0.05 =  4.00
rates           46.0 × 0.05 =  2.30
funding        100.0 × 0.04 =  4.00
vol             64.2 × 0.00 =  0.00   (不进分,VIX 在 overlay)
                            ───────
                     score = 45.7  →  贴近偏空线(45),靠迟滞勉强维持 BULLISH
```
资产负债表脉冲 = EXPANDING、净流动性方向 = DOWN、**政策 = RESERVE_MGMT(QT 已结束)**、coverage = 7/7、VIX 16.8 未触发 overlay → `display_verdict = BULLISH`。
读数解读:**净流动性在收 + 准备金在降 + 曲线不陡,被极平静的信用/资金面勉强托住——已逼近中性偏空,别上头。**

## 9. 局限与待办

- **弱信号**:命中率~52%、策略跑输被动(见 §1/§6),当宏观背景用,别当择时机。
- **过拟合已检验(见 §6.1)**:walk-forward 表明**自动调权重在样本外塌成 ~0**、等权≈手调 —— 所以**不要再为提高历史命中率去精调权重/阈值**,那只会 p-hack 出虚假的高命中。真正的提升只能来自更长/更干净的样本或新的**领先**因子,二者都受限。
- **历史短**:主回测样本 2016+。瓶颈不是 SPX(Yahoo `range=max` 可取几十年,全球流动性研究已用),而是**因子数据**:`SOFR`(2018 起)、`IORB`(2021 起)、`DTWEXBGS`(2006 起)在那之前不存在,所以完整 9 因子模型没法在 ~2021 前评估。
- **阈值是初值**:reserveAdequacy 的 2800/3800、各 linMap 边界、verdict 55/45、STRESS 阈值等都待校准。
- **PR-09 回测边界**：交易日历由实际 SPX 行自然形成，没有单独的交易所日历；FRED SP500 是不含股息的指数收盘。正式目标仓位暂沿用兼容 long/flat，dashboard exposure tiers、公平基准和尾部指标留给 PR-10。SOFR 缺失/陈旧时 fail closed，不做零利率替代。

## 10. 已验证过、决定不采用的方向(负结果归档)

- **全球央行流动性(Fed+ECB+BOJ)**:测了那个流行的"全球流动性领先美股 ~13 周"说法,24 年(2002–2026)、两种构造:
  - **FX 折算版**被美元波动污染(剔不开,部分就是已有的 dollar 因子)→ IC 仅 0.05,不如 Fed-only。
  - **FX-中性本币增速版**(修了污染)好些(最佳 lead 22 周 IC 0.137),但**仍只≈ Fed-only(0.123,+0.01 噪音级)**,且 **regime 不稳**(GFC/QE/COVID 符号翻转),lead ~22 周而非传说的 13 周。
  - **裁决:加 ECB+BOJ 不比单看美联储强,且不稳 → 不采用。Fed-centric 更好更简单。** 研究脚本 `scripts/global-liquidity-study.mjs` 备查。
  - 日元 carry-unwind(2024-08 式)是**快冲击**,由 live-stress overlay(5 日 VIX/SPX/美元)覆盖,不需要慢因子。中国/PBOC 无干净 FRED 数据;RBA/RBNZ 占比 <5%;新主席等政权变更是离散事件、非统计因子。
- **自动/精细调权重**:walk-forward 证明会过拟合(§6.1),不做。

> 教训:`scripts/` 那次首跑,GL 算成 \$40,000,000 万亿——是 runner 里 fetch 结果**变量解构顺序与 fetch 顺序错位**(JPNASSETS↔DEXUSEU);单测全绿(bug 在 fetch 测试边界外),靠**实跑 + 数量级 sanity check**(GL 应 ~\$18T)才抓到。集成 bug ≠ 单测能保。

---

*实现:`src/metrics.ts`(打分)、`src/config.ts`(参数)、`src/service.ts`(流水线)、`src/backtest.ts`(旧周频诊断)、`src/event-backtest.ts`(正式 event-time 绩效)。改造历程见 `docs/ROADMAP-algo-v2.md`。*
