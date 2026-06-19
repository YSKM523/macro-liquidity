// unit: 'M' millions→/1000 billions; 'B' billions; 'P' percent; 'I' index
export const SERIES = {
  WALCL:        { id: 'WALCL',        unit: 'M' },
  WTREGEN:      { id: 'WTREGEN',      unit: 'M' },
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
export const WEIGHTS = { netliqTrend: 0.35, qeqt: 0.15, credit: 0.15, funding: 0.10, rates: 0.10, dollar: 0.08, vol: 0.07 } as const;
export const QEQT_EPSILON_B = 50;        // ΔWALCL 13w dead-band (billions), initial
export const NETLIQ_TREND_WEEKS = 13;    // ~1 quarter
export const RATES_LOOKBACK_DAYS = 20;   // ~4 weeks for Δ10Y
export const VERDICT_BANDS = { bull: 55, bear: 45 } as const;
