// unit: 'M' millions→/1000 billions; 'B' billions; 'P' percent; 'I' index
export const SERIES = {
  WALCL:        { id: 'WALCL',        unit: 'M' },
  WTREGEN:      { id: 'WTREGEN',      unit: 'M' },
  WDTGAL:       { id: 'WDTGAL',       unit: 'M' },
  RRPONTSYD:    { id: 'RRPONTSYD',    unit: 'B' },
  RPONTSYD:     { id: 'RPONTSYD',     unit: 'B' },
  SOFR:         { id: 'SOFR',         unit: 'P' },
  IORB:         { id: 'IORB',         unit: 'P' },
  BAMLH0A0HYM2: { id: 'BAMLH0A0HYM2', unit: 'P' },
  DGS10:        { id: 'DGS10',        unit: 'P' },
  VIXCLS:       { id: 'VIXCLS',       unit: 'I' },
  DTWEXBGS:     { id: 'DTWEXBGS',     unit: 'I' },
  SP500:        { id: 'SP500',        unit: 'I' },
} as const;

export const SERIES_IDS: string[] = Object.values(SERIES).map(s => s.id);
export const UNIT_BY_ID: Record<string, string> =
  Object.fromEntries(Object.values(SERIES).map(s => [s.id, s.unit]));

export const START_DATE = '2003-01-01';
// Fed 在 2025-10-29 FOMC 宣布证券持仓缩减于 2025-12-01 结束(分析师引用,如有变更改此处)
export const QT_END_DATE = '2025-12-01';
// P2-1a: vol weight → 0 (backtest: VIX score is robustly CONTRARIAN, not a bullish factor; VIX moves to the live-stress overlay).
// vol still computed/stored so /api/backtest keeps measuring its IC. Freed 0.07 → the two robustly-positive factors (netliqTrend, dollar). Sum = 1.00.
export const WEIGHTS = { netliqTrend: 0.50, impulse: 0.05, credit: 0.15, funding: 0.10, rates: 0.10, dollar: 0.10, vol: 0.00 } as const;
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
