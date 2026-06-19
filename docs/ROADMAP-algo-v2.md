# 算法改进路线图 v2(分析师评审 + 核实结论)

> 来源:分析师对线上看板的评审(`docs/qeqt.md`)+ 我对其论点逐条核实(代码 + FRED API,2026-06-19)。
> 状态:**仅路线图,代码未改。** 每项标注优先级、改法、核实状态、证伪条件。
>
> 图例:✅ 已核实属实 · 🔧 我对分析师的纠正 · ⚠️ 方向对但须回测验证后才动 · 📊 需要数据/校准

---

## 0. 总结论

框架本身是对的(dated 数据不被实时价格污染、净流动性 = WALCL−TGA−RRP、背离显性化),**不推倒重来**。真正要升级的是 5 处:**TGA 口径、RRP 见底后的边际失效、QE/QT 命名、阈值尺度自适应、低信用利差被误读为单纯利好**。分析师约 90% 正确;我核实后有 2 处纠正(见 §4)。

最关键的一句:**别用"看起来更合理"替换阈值就当改进——每个打分模型改动都要有 walk-forward 证据证明它确实更能预测 forward SPX,否则只是漂亮但不可交易。**

---

## 1. 已核实的事实(我用 FRED key 实拉,2026-06-19)

| 论点 | 核实 | 证据 |
|---|---|---|
| TGA 口径错位:WALCL 是周三水平,但我用了周平均 WTREGEN | ✅ | `WTREGEN`(周平均)6/17 = 880,713M;**`WDTGAL`(周三水平)6/17 = 956,502M** → 差 **75.8B**。6/10 两者 828,122 vs 801,084 → 差额**反向**。settlement 周附近这个符号翻转会扭曲 4 周斜率,而 `netliqDirection` 死区只有 0.2%。 |
| `WDTGAL` / `WRBWFRBL` 可用、口径一致 | ✅ | 都是周频、周三水平、百万美元——和 WALCL 同口径同单位,可直接替换/相加。 |
| RRP 已见底,缓冲池消失 | ✅ | `RRPONTSYD` 6/17 = 6.8B → **6/18 = 0.251B**。 |
| RRP 见底后,准备金(而非 RRP)成为边际 | ✅ **本周活证据** | 本周 TGA(周三) **+155B**(801→956),同期准备金 `WRBWFRBL` **−175B**(3,111→2,936),RRP 已≈0。没了 RRP 垫子,TGA 补库直接抽干准备金——正是分析师的核心论点。 |

---

## 2. 路线图(按优先级)

### P0 — 立即修(口径/文案,低风险,已核实对)

| 项 | 改法 | 核实 | 证伪条件 |
|---|---|---|---|
| **TGA 主口径** | `netliq = WALCL − WTREGEN − RRP` → **`WALCL − WDTGAL − RRP`**(周三对齐);保留 `WTREGEN` 版做 smooth 噪音过滤 | ✅ 差 75.8B 且符号会翻 | 改后历史 4–8 周 forward SPX 命中率**反而下降** → 说明周平均平滑更适合做信号,退回 |
| **单位文案** | `ALGORITHM.md` 的 "ε=50亿美元" → **"$50B(=500亿美元)"** | 🔧 我写错了(代码逻辑没错,只中文注释 10× 错) | — |
| **美元口径前端说明** | 明确标注:顶部 = 交易员的 ICE DXY(`DX-Y.NYB`),打分 = 可回溯广义美元(`DTWEXBGS`,Jan2006=100) | ✅ 口径不同 | 用户仍把顶部数字对因子分 → 文案再优化 |

### P1 — 一周内(命名/防双计/可信度,中等改动)

| 项 | 改法 | 核实 | 证伪条件 |
|---|---|---|---|
| **QE/QT 改名** | `qeQtRegime` → `balanceSheetImpulse`(EXPANDING/CONTRACTING/FLAT)+ 独立 `policyRegime` 标签(QE/QT/QT_ENDED/RESERVE_MANAGEMENT/CRISIS/UNKNOWN,规则或人工维护) | ✅ 2025-12 QT 结束后,WALCL 上升≠QE(注:QT-end 日期我未独立核实,依分析师引用的 Oct-2025 FOMC) | 用户理解成本反升 → 保留 QE/QT 文案但改注解为"资产负债表13周脉冲" |
| **qeqt 降权(防双重计数)** | WALCL 已在 `netliq` 里,`qeqt`(=fΔWALCL)与 `netliqTrend` 双重计数 → **label-only(权重0)或 ≤0.05** | ✅ metrics.ts:178 `netliq` 与 :190 `qeqt` 都吃 WALCL | 去掉后总分对拐点反应变差 |
| **数据新鲜度** | 输出每点 as-of + `coverageScore` + `stalenessFlag`;缺数据不再静默给 50 装"中性可靠" | ✅ 当前 `?? 50` 会掩盖断档 | 前端复杂度明显伤可读性 |

### P2 — 两周内(新因子/风控覆盖,⚠️ 须回测)

| 项 | 改法 | 核实 | 证伪条件 |
|---|---|---|---|
| **准备金因子** `reserveAdequacy`(WRBWFRBL) | 见 §3.1 公式。RRP 见底后准备金才是前置库存变量,比 `SOFR−IORB`(压力已冒出)更早 | ✅ WRBWFRBL 存在;本周活证据 | 与未来 4–8 周 SPX/credit 表现无关 |
| **信用三拆** | `credit` 由单一 level percentile → level/momentum/fragility(见 §3.2)。低 OAS = 没事故 ≠ 强看多;低位**开始上行**最危险 | ✅ 当前 `credit`=98 因 OAS 处历史极低分位 | 低 OAS 持续平稳时频繁误报 |
| **Live Stress Overlay** | `liveStress` 触发则把**显示**结论降一级(标"实时风险覆盖"),**不污染宏观分**(见 §3.3)。即此前说的"日内会动的版本"的正确实现 | ✅ 与我之前建议一致 | 实时 overlay 频繁误报 |
| **netliqTrend 去二元化** | `aboveMA 60/40` 二元 → 连续 z(gap13/impulse4/impulse13 → sigmoid,见 §3.4) | ⚠️ 方向对 | 改后样本外不优于旧版 |
| **自适应标准化** | 固定 `±200B / ±50bp` → rolling z-score / MAD / 占 GDP 比 + sigmoid 打分 | ✅ 名义规模在涨,固定阈值会漂 | 标准化后历史信号更噪、命中率下降 |

### P3 — 后续(校准,决定可不可交易)📊

| 项 | 改法 | 证伪条件 |
|---|---|---|
| **多窗口校准** | 三套并排:2003–今(长周期 base rate)/ 2018–2020(准备金稀缺/回购压力镜像)/ 2020–2026(现代 RRP/TGA/QT)。需把 `START_DATE` 拉到 2003 并接受回填变慢 | 长窗口阈值反而劣化近端表现 |
| **walk-forward 回测** | 对 4/8/13 周 SPX forward return 做**样本外**检验,用信息比率当"能不能交易"的硬指标 | **OOS 信息比率 ≈ 0 → 看板只能当宏观背景,不能用于仓位调整** |

---

## 3. 关键公式(分析师提案 + 我的标注)

### 3.1 准备金充裕度 `reserveAdequacy`(⚠️ 阈值待校准)
```ts
reserveAdequacy =
  0.5 * linMap(WRBWFRBL_level,        lowReserveThreshold, highReserveThreshold)
+ 0.3 * linMap(ΔWRBWFRBL_13w,         -300, +300)
+ 0.2 * linMap(SOFR_IORB_20d_p95,     +0.10, 0.00)
```
`WRBWFRBL` = Reserve Balances, Wednesday Level(百万,周频)。6/17 = 2,936,355M。

### 3.2 信用三拆 `creditScore`(⚠️)
```ts
creditCalm     = 100 - percentileRankExpanding(HY_OAS_level, d)   // 已是 expanding,见 §4
creditMomentum = linMap(ΔHY_OAS_20d, +1.00, -0.25)
creditFragility= (HY_OAS_percentile < 15 && ΔHY_OAS_20d > 0.20) ? penalty(10~20) : 0
creditScore    = 0.55*creditCalm + 0.45*creditMomentum - creditFragility
```
要义:真正 bullish 是**低且继续下行/稳定**;最危险是**低位开始上行**(风险补偿不够 + 仓位拥挤 + 止损连锁)。

### 3.3 实时风控覆盖 `liveStress`(不改宏观分,只改提示)
```ts
liveStress =
  liveVix > 30 || liveDxy_5d_change > threshold ||
  live10y_5d_change > 0.25 || spx_5d_drawdown < -0.04

displayVerdict = (liveStress && macroScore < 65)
  ? downgradeOneLevel(macroVerdict, "实时风险覆盖")
  : macroVerdict
```

### 3.4 净流动性脉冲去二元化 + 自适应(⚠️)
```ts
gap13     = (netliq - sma(netliq,13))      / rollingStd(netliq - sma(netliq,13), 156w)
impulse4  = (netliq - netliq[4])           / rollingStd(Δ4w_netliq, 156w)
impulse13 = (netliq - netliq[13])          / rollingStd(Δ13w_netliq, 156w)
netliqTrendScore = sigmoidScore(0.45*gap13 + 0.35*impulse4 + 0.20*impulse13)
```

### 3.5 主公式双版本(P0)
```ts
netliqLevel(d)  = WALCL_Wed(d) - WDTGAL_Wed(d) - RRP_asOf(d)          // 前端默认 + 打分主用
netliqSmooth(d) = WALCL_Wed(d) - WTREGEN_weekAvg(d) - SMA5(RRP_daily) // 噪音过滤/确认
```

---

## 4. 我对分析师的纠正(核实后)

1. **前视偏差(他的 B5)——已经规避。** `computeSnapshot` 的 `hyHistory` 已过滤 `o.date <= date`(metrics.ts:184),是 expanding window,线上算的快照**没有**全样本前视。真正问题是**参考窗口短**(我为回填速度设了 `START_DATE=2020`),那是他的 C 点 → 归到 P3 拉长历史,而不是"去前视"。
2. **"50亿" 是我文案错。** `QEQT_EPSILON_B=50` 是 **$50B = 500亿美元**;代码逻辑(与 ΔWALCL 十亿比)没错,只我的中文注解 10× 错 → P0 修。

---

## 5. 权重对照(分析师 v1 提案,⚠️ 待回测定稿)

| 当前 | 权重 | → 提案 | 权重 |
|---|--:|---|--:|
| netliq | 0.35 | netliqImpulse | 0.35 |
| qeqt | 0.15 | policyRegime | **label only(或 ≤0.05)** |
| credit | 0.15 | creditMomentum | 0.12 |
| funding | 0.10 | fundingStress | 0.15 |
| rates | 0.10 | ratesImpulse | 0.10 |
| dollar | 0.08 | dollarImpulse | 0.08 |
| vol | 0.07 | volStress | 0.05 |
| — | — | **reserveAdequacy(新)** | **0.15** |

> 落地顺序建议(分析师 3 阶段,我认同):P0 只修口径/文案 → P1 加新鲜度+命名+防双计 → P2 加准备金/信用拆/overlay → P3 walk-forward 校准。一次别重构过度。

---

## 6. 监测日历(未来两周,跟踪证伪)

| 日期 | 事件 | 影响 |
|---|---|---|
| 2026-06-25 | WALCL/WDTGAL/WRBWFRBL/RRP(H.4.1,周四 16:30 发) + PCE | 净流动性 + 准备金 + 利率/美元因子 |
| 2026-07-02 | H.4.1 周更 + 6 月非农就业(08:30 ET) | 同上 + 10Y/美元/信用/Fed 预期 |
| 2026-07-28/29 | 下次 FOMC | 两周内无决议,但市场提前交易 |

---

*核实方法:代码逐行(`src/metrics.ts`、`src/service.ts`)+ FRED API 实拉(WTREGEN/WDTGAL/WRBWFRBL/RRPONTSYD)。原始评审见 `docs/qeqt.md`,当前算法见 `docs/ALGORITHM.md`。*
