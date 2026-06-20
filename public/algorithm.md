# 美股流动性看板 — 总体逻辑与算法(v2,当前线上)

> 线上:https://macro-liquidity-dashboard.pp-account.workers.dev
> 本文件描述**当前**实现(`src/metrics.ts` + `src/config.ts` + `src/backtest.ts`)。v2 改造历程与依据见 `docs/ROADMAP-algo-v2.md`、分析师评审 `docs/qeqt.md`。实时数值以 `/api/snapshot`、`/api/backtest` 为准。

---

## 0. 一句话

**用美联储的"钱多钱少"判断美股顺不顺风。** 净流动性 + 7 个加权因子算出一个 **0–100 顺风指数**和 **偏多/偏空/中性** 红绿灯;另有一个**实时风控覆盖层**在市场急变时下调显示结论。

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
| `VIXCLS` | VIX | 日 | 指数 | (打分权重 0;见 §4 vol) |
| `DTWEXBGS` | 广义美元 | 日 | 指数 | 美元 |
| `SP500` | 标普 500 | 日(滞后1天,~10年) | 指数 | 历史图 + 回测 |

> ⚠️ 单位坑:`WALCL`/`WDTGAL`/`WTREGEN`/`WRBWFRBL` 来自 H.4.1,是**百万**;`RRPONTSYD`/`RPONTSYD` 来自临时公开市场操作,是**十亿**。
> 📌 TGA 用 **`WDTGAL`(周三水平)**,与 WALCL 周三口径对齐(周平均 `WTREGEN` 会平滑掉真实回抽)。

### 2.2 实时价格(不入库)
- 顶部显示:SPX/VIX/DXY/10Y 走 Yahoo(主)/Stooq(备),每次开页面现拉。
- **风控覆盖层**:另拉近 1 个月日线,算 5 日变化(见 §5)。
- 美元口径:顶部 = ICE DXY(`DX-Y.NYB`,仅展示);打分 = FRED 广义美元 `DTWEXBGS`(可回溯)。

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

## 4. 算法:7 因子加权 0-100

通用工具:`clamp(x)=max(0,min(100,x))`;`linMap(x,a,b)=clamp((x−a)/(b−a)·100)`;`sma`/`asOf`/`changeOverDays` 同前;净流动性按**真周度**序列算 13 周趋势与方向(死区 ±0.2%)。

**权重经 10 年回测的因子 IC 校准**(数据支撑的温和倾斜,非按 IC 比例硬拟合):

| 因子 | 权重 | 13w IC | 公式 / 直觉 |
|---|--:|--:|---|
| **netliqTrend** | **0.40** | +0.19 | `0.5·aboveMA + 0.5·linMap(4周斜率,−200,200)`。最强、最稳健的核心 |
| **dollar** | **0.20** | +0.16 | `linMap(z,1,−1)`,z=(DXY−SMA200)/σ。弱美元→顺风 |
| **reserveAdequacy** | **0.15** | +0.12 | `0.5·linMap(准备金,2800,3800)+0.3·linMap(Δ13周,−300,300)+0.2·linMap(SOFR−IORB,0.10,0)`。RRP 见底后的新缓冲 |
| **credit** | **0.10** | −0.03 | `0.55·calm+0.45·momentum−fragility`(level/momentum/fragility 三拆;低且**上行**才危险) |
| **impulse** | **0.05** | +0.08 | 资产负债表脉冲:EXPANDING 80 / FLAT 55 / CONTRACTING 30 |
| **rates** | **0.05** | +0.06 | `linMap(Δ10Y 20日,+0.5,−0.5)`;收益率快速上冲=逆风 |
| **funding** | **0.05** | −0.04 | `linMap(SOFR−IORB,0.10,0)`;资金压力传感器 |
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

## 6. 验证器 `/api/backtest`(诚实的样本外检验)

阈值是固定启发式、percentile 是 expanding-window(无前视)→ 全历史 IC/Sharpe 本身即样本外。对 4/8/13 周 SPX forward return 算:综合分 IC(spearman/pearson)+ 命中率;**逐因子 IC**(指导配权);long/flat 策略 Sharpe vs 买入持有。

**当前实测(2016-06→2026,534 快照,10 年):**
- 综合分 IC@13周 **0.227**(8周 0.124,4周 0.091);命中率 ~52%。
- 因子 IC@13周:netliqTrend +0.19 > dollar +0.16 > reserveAdequacy +0.12 > impulse +0.08 > rates +0.06 > credit −0.03 > funding −0.04 > vol −0.25。
- 策略 7.9%/年 vs 买入持有 13.6%,**Sharpe 1.03**(躲回撤,绝对收益跑输)。
- v2 改造的 IC 轨迹:0.127(起点)→0.195(去 vol)→0.208(信用三拆)→**0.227**(reweight)。

## 7. 数据流水线 + 可信度

- `cron`(每 3 小时)→ FRED 增量 → 重算近 14 天 `daily_snapshot`;全量回填按 WALCL **周线**采样(避免逐日 O(N²))。
- 存储:D1 `observations`(FRED 长表)/ `daily_snapshot`(每日状态 + `factors_json` + `coverage`)。
- **coverage**:7 因子里几个用真实数据(非 50 兜底);**staleness**(前端:数据截至 X 天前)——缺数据不再静默装"中性可靠"。
- 纯逻辑 `src/metrics.ts` + `src/backtest.ts`,90+ 单测。

## 8. 一个真实算例(2026-06-17 线上)

`WALCL=6736.4B, TGA(WDTGAL)=956.5B, RRP=6.8B` → **净流动性 = 5773.1B**;准备金 `WRBWFRBL=2936.4B`(偏紧端);`HY OAS=2.63%`(极低)、`SOFR−IORB=−0.02`、`10Y=4.49%`、`DXY=119.5`、`VIX=18.4`。

```
netliqTrend     28.3 × 0.40 = 11.32   (净流动性在收 → 趋势分低)
dollar          59.3 × 0.20 = 11.86
reserveAdequacy 38.7 × 0.15 =  5.81   (准备金偏紧且在降)
credit          93.3 × 0.10 =  9.33
funding        100.0 × 0.05 =  5.00
impulse         80.0 × 0.05 =  4.00
rates           46.0 × 0.05 =  2.30
vol             64.2 × 0.00 =  0.00   (不进分,VIX 在 overlay)
                            ───────
                     score = 49.6  →  贴中性线,靠迟滞维持 BULLISH
```
资产负债表脉冲 = EXPANDING、净流动性方向 = DOWN、**政策 = RESERVE_MGMT(QT 已结束)**、coverage = 7/7、VIX 16.8 未触发 overlay → `display_verdict = BULLISH`。
读数解读:**净流动性在收 + 准备金在降,被极平静的信用/资金面勉强托住——中性偏多、别上头。**

## 9. 局限与待办

- **弱信号**:命中率~52%、策略跑输被动(见 §1/§6),当宏观背景用,别当择时机。
- **in-sample**:权重在 2016–2026 同一段上调,有过拟合风险;真·train/test 滚动 walk-forward 是 P3。
- **历史短**:回测样本 2016+(FRED SP500 限制),要 2003+ 需另接长 SPX 源。
- **阈值是初值**:reserveAdequacy 的 2800/3800、各 linMap 边界、verdict 55/45、STRESS 阈值等都待校准。

---

*实现:`src/metrics.ts`(打分)、`src/config.ts`(参数)、`src/service.ts`(流水线)、`src/backtest.ts`(验证)。改造历程见 `docs/ROADMAP-algo-v2.md`。*
