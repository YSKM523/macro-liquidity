export type ExpectedFrequency = 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'IRREGULAR';
export type FallbackPolicy = 'NONE' | 'FORWARD_FILL';

export interface FreshnessRule {
  expectedFrequency: ExpectedFrequency;
  maxStaleCalendarDays: number;
  maxStaleBusinessDays: number;
  releaseLag: number;
  requiredForScore: boolean;
  fallbackPolicy: FallbackPolicy;
}

export interface SeriesDefinition extends FreshnessRule {
  id: string;
  unit: 'M' | 'B' | 'P' | 'I';
}

// unit: 'M' millions→/1000 billions; 'B' billions; 'P' percent; 'I' index
export const SERIES = {
  WALCL:        { id: 'WALCL',        unit: 'M', expectedFrequency: 'WEEKLY', maxStaleCalendarDays: 10, maxStaleBusinessDays: 7, releaseLag: 1, requiredForScore: true,  fallbackPolicy: 'FORWARD_FILL' },
  WTREGEN:      { id: 'WTREGEN',      unit: 'M', expectedFrequency: 'WEEKLY', maxStaleCalendarDays: 10, maxStaleBusinessDays: 7, releaseLag: 1, requiredForScore: false, fallbackPolicy: 'FORWARD_FILL' },
  WDTGAL:       { id: 'WDTGAL',       unit: 'M', expectedFrequency: 'WEEKLY', maxStaleCalendarDays: 10, maxStaleBusinessDays: 7, releaseLag: 1, requiredForScore: true,  fallbackPolicy: 'FORWARD_FILL' },
  WRBWFRBL:     { id: 'WRBWFRBL',     unit: 'M', expectedFrequency: 'WEEKLY', maxStaleCalendarDays: 10, maxStaleBusinessDays: 7, releaseLag: 1, requiredForScore: true,  fallbackPolicy: 'FORWARD_FILL' },
  RRPONTSYD:    { id: 'RRPONTSYD',    unit: 'B', expectedFrequency: 'DAILY',  maxStaleCalendarDays: 4,  maxStaleBusinessDays: 2, releaseLag: 0, requiredForScore: true,  fallbackPolicy: 'FORWARD_FILL' },
  RPONTSYD:     { id: 'RPONTSYD',     unit: 'B', expectedFrequency: 'DAILY',  maxStaleCalendarDays: 4,  maxStaleBusinessDays: 2, releaseLag: 0, requiredForScore: false, fallbackPolicy: 'FORWARD_FILL' },
  SOFR:         { id: 'SOFR',         unit: 'P', expectedFrequency: 'DAILY',  maxStaleCalendarDays: 4,  maxStaleBusinessDays: 2, releaseLag: 1, requiredForScore: true,  fallbackPolicy: 'FORWARD_FILL' },
  IORB:         { id: 'IORB',         unit: 'P', expectedFrequency: 'DAILY',  maxStaleCalendarDays: 4,  maxStaleBusinessDays: 2, releaseLag: 0, requiredForScore: true,  fallbackPolicy: 'FORWARD_FILL' },
  BAMLH0A0HYM2: { id: 'BAMLH0A0HYM2', unit: 'P', expectedFrequency: 'DAILY',  maxStaleCalendarDays: 4,  maxStaleBusinessDays: 2, releaseLag: 1, requiredForScore: true,  fallbackPolicy: 'FORWARD_FILL' },
  DGS10:        { id: 'DGS10',        unit: 'P', expectedFrequency: 'DAILY',  maxStaleCalendarDays: 4,  maxStaleBusinessDays: 2, releaseLag: 1, requiredForScore: true,  fallbackPolicy: 'FORWARD_FILL' },
  VIXCLS:       { id: 'VIXCLS',       unit: 'I', expectedFrequency: 'DAILY',  maxStaleCalendarDays: 4,  maxStaleBusinessDays: 2, releaseLag: 1, requiredForScore: false, fallbackPolicy: 'NONE' },
  DTWEXBGS:     { id: 'DTWEXBGS',     unit: 'I', expectedFrequency: 'DAILY',  maxStaleCalendarDays: 10, maxStaleBusinessDays: 7, releaseLag: 7, requiredForScore: true,  fallbackPolicy: 'FORWARD_FILL' },
  SP500:        { id: 'SP500',        unit: 'I', expectedFrequency: 'DAILY',  maxStaleCalendarDays: 4,  maxStaleBusinessDays: 2, releaseLag: 1, requiredForScore: false, fallbackPolicy: 'NONE' },
  T10Y2Y:       { id: 'T10Y2Y',       unit: 'P', expectedFrequency: 'DAILY',  maxStaleCalendarDays: 4,  maxStaleBusinessDays: 2, releaseLag: 1, requiredForScore: true,  fallbackPolicy: 'FORWARD_FILL' },
  ECBASSETSW:   { id: 'ECBASSETSW',   unit: 'I', expectedFrequency: 'WEEKLY', maxStaleCalendarDays: 14, maxStaleBusinessDays: 10, releaseLag: 4, requiredForScore: false, fallbackPolicy: 'FORWARD_FILL' }, // ECB total assets, millions EUR (raw)
  JPNASSETS:    { id: 'JPNASSETS',    unit: 'I', expectedFrequency: 'MONTHLY', maxStaleCalendarDays: 45, maxStaleBusinessDays: 32, releaseLag: 10, requiredForScore: false, fallbackPolicy: 'FORWARD_FILL' }, // BOJ total assets, 億円 (raw)
  DEXUSEU:      { id: 'DEXUSEU',      unit: 'I', expectedFrequency: 'DAILY',  maxStaleCalendarDays: 4,  maxStaleBusinessDays: 2, releaseLag: 1, requiredForScore: false, fallbackPolicy: 'FORWARD_FILL' }, // USD per EUR
  DEXJPUS:      { id: 'DEXJPUS',      unit: 'I', expectedFrequency: 'DAILY',  maxStaleCalendarDays: 4,  maxStaleBusinessDays: 2, releaseLag: 1, requiredForScore: false, fallbackPolicy: 'FORWARD_FILL' }, // JPY per USD
} as const satisfies Record<string, SeriesDefinition>;

export const SERIES_IDS: string[] = Object.values(SERIES).map(s => s.id);
export const UNIT_BY_ID: Record<string, string> =
  Object.fromEntries(Object.values(SERIES).map(s => [s.id, s.unit]));

export const START_DATE = '2003-01-01';
// Fed 在 2025-10-29 FOMC 宣布证券持仓缩减于 2025-12-01 结束(分析师引用,如有变更改此处)
export const QT_END_DATE = '2025-12-01';
// data-grounded weights from measured factor IC (13w spearman, 2016-2026): netliqTrend +0.19, curve +0.17,
// dollar +0.16, reserveAdequacy +0.12 (top-4 → ~0.80 of weight); impulse/rates weak, credit/funding ~neutral kept low;
// vol = robust contrarian → 0, lives in the live-stress overlay.
// curve EARNED its weight: adding it raises the zero-tuning equal-weight OOS IC 0.206→0.252 and it's selected
// top-2 in every walk-forward fold (genuinely orthogonal, not overfitting). Walk-forward warns: don't over-tune —
// the edge is the factor SET, not precise weights, so this is a modest IC-direction tilt, not an IC-proportional fit.
// sum check: 0.35+0.05+0.06+0.04+0.05+0.18+0.00+0.12+0.15 = 1.00
export const WEIGHTS = { netliqTrend: 0.35, impulse: 0.05, credit: 0.06, funding: 0.04, rates: 0.05, dollar: 0.18, vol: 0.00, reserveAdequacy: 0.12, curve: 0.15 } as const;
// coverage = 真正参与评分(权重>0)的因子里，有真实数据的比例。vol 权重为 0(已移入 live-stress overlay)，不计入。
export const COVERAGE_FACTORS = [
  'netliqTrend', 'impulse', 'credit', 'funding', 'rates', 'dollar', 'reserveAdequacy', 'curve',
] as const;
export const RESERVE_LOW  = 2800;  // bank reserves ($B) tight end (~LCLOR zone) → adequacy low
export const RESERVE_HIGH = 3800;  // abundant end → adequacy high
export const QEQT_EPSILON_B = 50;        // ΔWALCL 13w dead-band (billions), initial
export const NETLIQ_TREND_WEEKS = 13;    // ~1 quarter
export const RATES_LOOKBACK_DAYS = 20;   // ~4 weeks for Δ10Y
export const CREDIT_LOOKBACK_DAYS = 20;  // ΔHY OAS 动量窗口(~4 周)
export const VERDICT_BANDS = { bull: 55, bear: 45 } as const;

export const STRESS = {
  vix: 28,       // VIX absolute level
  spxDd: -0.04,  // SPX 5-day return < -4%
  y10: 0.25,     // 10Y 5-day change > +0.25pp
  dxy: 0.02,     // DXY 5-day return > +2%
} as const;
export const STRESS_SCORE_CEILING = 65; // macro score >= this → no downgrade (strong regime beats short noise)

// cron 每 3h 跑一次；上次成功摄取超过这个小时数 → 判为不健康(容忍漏 1 拍)。
export const INGEST_STALE_HOURS = 6;

// Ingest 加固:主 cron 之外有一条 hourly 重试 cron(见 wrangler.toml),
// 仅在上次失败或成功摄取超过 RETRY_MAX_AGE_HOURS 时补跑;连续第 2 次失败发邮件告警(限频)。
export const MAIN_CRON = '0 */3 * * *';
export const RETRY_MAX_AGE_HOURS = 4;
export const ALERT_MIN_INTERVAL_HOURS = 12;
