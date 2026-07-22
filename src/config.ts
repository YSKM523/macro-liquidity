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
const CHAMPION_SCORING = {
  scoreRange: { minimum: 0, maximum: 100, neutral: 50 },
  weights: { netliqTrend: 0.35, impulse: 0.05, credit: 0.06, funding: 0.04, rates: 0.05, dollar: 0.18, vol: 0.00, reserveAdequacy: 0.12, curve: 0.15 },
  coverageFactors: [
    'netliqTrend', 'impulse', 'credit', 'funding', 'rates', 'dollar', 'reserveAdequacy', 'curve',
  ],
  verdictBands: { bull: 55, bear: 45 },
  qeQt: { deadBandBillions: 50, lookbackWeeks: 13 },
  netLiquidityTrend: {
    lookbackWeeks: 13, directionRelativeGap: 0.002, aboveMovingAverageScore: 60,
    belowMovingAverageScore: 40, slopeLookbackWeeks: 4, slopeMinimumBillions: -200,
    slopeMaximumBillions: 200, levelWeight: 0.5, slopeWeight: 0.5,
  },
  impulse: { expanding: 80, contracting: 30, flat: 55 },
  credit: {
    lookbackDays: 20, momentumNeutral: 50, momentumWidening: 1,
    momentumTightening: -0.25, fragilityPercentile: 0.15,
    fragilityWidening: 0.20, fragilityPenalty: 15, levelWeight: 0.55, momentumWeight: 0.45,
  },
  funding: { stressedSpread: 0.10, calmSpread: 0 },
  rates: { lookbackDays: 20, headwindChange: 0.5, tailwindChange: -0.5 },
  dollar: { movingAverageDays: 200, headwindZScore: 1, tailwindZScore: -1 },
  volatility: { stressedVix: 30, calmVix: 12 },
  reserveAdequacy: {
    lowBillions: 2800, highBillions: 3800, lookbackDays: 91,
    momentumMinimumBillions: -300, momentumMaximumBillions: 300,
    levelWeight: 0.5, momentumWeight: 0.3, fundingWeight: 0.2,
  },
  curve: {
    lookbackDays: 20, levelMinimum: -0.5, levelMaximum: 1.5,
    changeMinimum: -0.3, changeMaximum: 0.3, levelWeight: 0.5, momentumWeight: 0.5,
  },
  factorQuality: { missing: 0, partial: 0.5, complete: 1 },
  pillarPassingScore: 50,
  requiredPrimaryFactor: 'netliqTrend',
  cadenceGapDays: {
    daily: { minimum: 1, maximum: 4 }, weekly: { minimum: 5, maximum: 10 },
    monthly: { minimum: 20, maximum: 45 },
  },
} as const;
// data-grounded weights from measured factor IC (13w spearman, 2016-2026): netliqTrend +0.19, curve +0.17,
// dollar +0.16, reserveAdequacy +0.12 (top-4 → ~0.80 of weight); impulse/rates weak, credit/funding ~neutral kept low;
// vol = robust contrarian → 0, lives in the live-stress overlay.
// curve EARNED its weight: adding it raises the zero-tuning equal-weight OOS IC 0.206→0.252 and it's selected
// top-2 in every walk-forward fold (genuinely orthogonal, not overfitting). Walk-forward warns: don't over-tune —
// the edge is the factor SET, not precise weights, so this is a modest IC-direction tilt, not an IC-proportional fit.
// sum check: 0.35+0.05+0.06+0.04+0.05+0.18+0.00+0.12+0.15 = 1.00
export const WEIGHTS = CHAMPION_SCORING.weights;
// coverage = 真正参与评分(权重>0)的因子里，有真实数据的比例。vol 权重为 0(已移入 live-stress overlay)，不计入。
export const COVERAGE_FACTORS = CHAMPION_SCORING.coverageFactors;
export const RESERVE_LOW = CHAMPION_SCORING.reserveAdequacy.lowBillions;
export const RESERVE_HIGH = CHAMPION_SCORING.reserveAdequacy.highBillions;
export const QEQT_EPSILON_B = CHAMPION_SCORING.qeQt.deadBandBillions;
export const NETLIQ_TREND_WEEKS = CHAMPION_SCORING.netLiquidityTrend.lookbackWeeks;
export const RATES_LOOKBACK_DAYS = CHAMPION_SCORING.rates.lookbackDays;
export const CREDIT_LOOKBACK_DAYS = CHAMPION_SCORING.credit.lookbackDays;
export const VERDICT_BANDS = CHAMPION_SCORING.verdictBands;

export const STRESS = {
  vix: 28,       // VIX absolute level
  spxDd: -0.04,  // SPX 5-day return < -4%
  y10: 0.25,     // 10Y 5-day change > +0.25pp
  dxy: 0.02,     // DXY 5-day return > +2%
} as const;
export const STRESS_SCORE_CEILING = 65; // macro score >= this → no downgrade (strong regime beats short noise)

// Event-time backtest execution/accounting assumptions. These do not alter
// Champion scoring, verdict bands, hysteresis, or dashboard exposure guidance.
export const EVENT_BACKTEST_ASSUMPTIONS = {
  executionPrice: 'FRED_SP500_INDEX_CLOSE',
  adjustedCloseSemantics: 'INDEX_CLOSE_NO_DIVIDENDS',
  earliestUsCloseEligibilityUtc: '17:00:00Z',
  accountingCloseUtc: '23:59:59Z',
  accountingTimestampSemantics: 'DAILY_ACCOUNTING_MARKER_NOT_EXCHANGE_TIMESTAMP',
  cashRate: 'SOFR',
  cashDayCount: 'ACT/360',
  cashFixingAvailability: 'PRIOR_DATE_ONLY',
  cashRateMaxStaleCalendarDays: 4,
  commissionBps: 1,
  baseSlippageBps: 2,
  highVolExtraSlippageBps: 3,
  vixStressLevel: STRESS.vix,
  vixMaxStaleCalendarDays: 4,
  financingSpreadBps: 100,
} as const;

// Market-data quality gates only. These tolerances decide whether two providers
// agree and whether a source observation is usable; they do not affect Champion
// factor scores, verdict bands, exposure tiers, or the stress trigger levels.
export const MARKET_DATA_QUALITY = {
  providerTimeoutMs: 4_000,
  maxFutureSkewMinutes: 5,
  quoteMaxAgeBusinessDays: 2,
  historyMaxAgeBusinessDays: 4,
  fredMaxAgeBusinessDays: {
    DTWEXBGS: SERIES.DTWEXBGS.maxStaleBusinessDays,
  },
  quoteRelativeTolerance: {
    spx: 0.01,
    vix: 0.05,
    dxy: 0.02,
    us10y: 0.03,
  },
  historyReturnTolerance: {
    spx: 0.01,
    vix: 0.05,
    dxy: 0.01,
    us10y: 0.10,
  },
} as const;

// cron 每 3h 跑一次；上次成功摄取超过这个小时数 → 判为不健康(容忍漏 1 拍)。
export const INGEST_STALE_HOURS = 6;

// Ingest 加固:主 cron 之外有一条 hourly 重试 cron(见 wrangler.toml),
// 仅在上次失败或成功摄取超过 RETRY_MAX_AGE_HOURS 时补跑;连续第 2 次失败发邮件告警(限频)。
export const MAIN_CRON = '0 */3 * * *';
export const RETRY_MAX_AGE_HOURS = 4;
export const ALERT_MIN_INTERVAL_HOURS = 12;
export const INGEST_LOCK_LEASE_SECONDS = 15 * 60;

function deepFreeze<T>(value: T): T {
  if (value != null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

export const CHAMPION_MODEL_CONFIG = deepFreeze({
  schema: 'macro-liquidity-champion-config/v2',
  modelVersion: 'champion-v1.0.0',
  scoring: CHAMPION_SCORING,
  policyRegime: { qtEndDate: QT_END_DATE },
  freshness: SERIES,
  stress: { thresholds: STRESS, scoreCeiling: STRESS_SCORE_CEILING },
  portfolio: {
    methodology: 'DASHBOARD_EXPOSURE_TIERS_V1', bullishUpOrFlat: 1, bullishDown: 0.9,
    bearish: 0.25, neutralBelowSplit: 0.5, neutralAtOrAboveSplit: 0.75,
    neutralScoreSplit: 50, stressed: 0.25, unknownMaximum: 0.75,
  },
  guidance: { bearTriggerArmedDistance: 2 },
  eventBacktest: EVENT_BACKTEST_ASSUMPTIONS,
  marketDataQuality: MARKET_DATA_QUALITY,
} as const);
