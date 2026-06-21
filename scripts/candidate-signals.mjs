/**
 * candidate-signals.mjs — Phase R candidate predictor builders.
 * Each returns an ascending [{date, value}] "signal" (already a predictor, not a level).
 * sign metadata lives in CANDIDATES (sign>0: higher → bullish; sign<0: higher → bearish).
 */
import { asOf, pctChangeWeeks, buildGlobalGrowthLC } from './global-lib.mjs';
import { addDays } from './research-lib.mjs';

// Fiscal issuance pace: 13-week % change in total public debt. Faster issuance = drain = bearish.
export function fiscalIssuanceSignal(debt, weeks = 13) {
  const out = [];
  for (const { date } of debt) {
    const g = pctChangeWeeks(debt, date, weeks);
    if (g !== null) out.push({ date, value: g });
  }
  return out;
}

// Term premium momentum: change in ACM TP10 over `days`. Rising TP = headwind = bearish.
export function termPremiumSignal(tp, days = 20) {
  const out = [];
  for (const { date } of tp) {
    const curr = asOf(tp, date);
    const past = asOf(tp, addDays(date, -days));
    if (curr === null || past === null) continue;
    out.push({ date, value: curr - past });
  }
  return out;
}

// Earnings momentum: YoY growth of trailing EPS, using only data available `lagDays` before t.
export function earningsMomentumSignal(earnings, lagDays = 60) {
  const out = [];
  for (const { date } of earnings) {
    const asof = addDays(date, -lagDays);          // publication lag → only past-published EPS
    const curr = asOf(earnings, asof);
    const base = asOf(earnings, addDays(asof, -365));
    if (curr === null || base === null || base === 0) continue;
    out.push({ date, value: (curr - base) / Math.abs(base) });
  }
  return out;
}

// Global liquidity: FX-neutral 13-week CB expansion rate (reuses the studied builder).
export function globalLiquiditySignal(walcl, ecb, boj, dexuseu, dexjpus, weeks = 13) {
  return buildGlobalGrowthLC(walcl, ecb, boj, dexuseu, dexjpus, weeks);
}

export const CANDIDATES = [
  { key: 'global_liquidity', sign: +1, label: '全球流动性(FX中性增速)' },
  { key: 'fiscal_issuance',  sign: -1, label: '财政发行(债务净发行速率)' },
  { key: 'term_premium',     sign: -1, label: '期限溢价(ACM 10Y Δ20d)' },
  { key: 'earnings_momentum',sign: +1, label: '盈利动量(滚动 EPS YoY)' },
];
