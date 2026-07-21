import type { Obs } from './fred';
import type { StressStatus } from './prices';
import type { FreshnessRule } from './config';
export type { Obs };
export type SeriesMap = Record<string, Obs[]>;

import { QEQT_EPSILON_B, NETLIQ_TREND_WEEKS, WEIGHTS, COVERAGE_FACTORS, RATES_LOOKBACK_DAYS, CREDIT_LOOKBACK_DAYS, VERDICT_BANDS, QT_END_DATE, RESERVE_LOW, RESERVE_HIGH, STRESS_SCORE_CEILING, SERIES } from './config';

export type Impulse = 'EXPANDING' | 'CONTRACTING' | 'FLAT';
export type Direction = 'UP' | 'DOWN' | 'FLAT';

export const clamp = (x: number, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, x));
export const linMap = (x: number, a: number, b: number) => clamp(((x - a) / (b - a)) * 100);

export function sma(values: number[], n: number): number | null {
  if (values.length < n || n <= 0) return null;
  const slice = values.slice(values.length - n);
  return slice.reduce((s, v) => s + v, 0) / n;
}

export function asOf(series: Obs[], date: string): number | null {
  let val: number | null = null;
  for (const o of series) { if (o.date <= date) val = o.value; else break; }
  return val;
}

export interface FreshnessResult {
  value: number | null;
  observationDate: string | null;
  ageDays: number | null;
  status: 'FRESH' | 'STALE' | 'MISSING';
}

const UTC_DAY_MS = 24 * 60 * 60 * 1000;

function utcDayNumber(date: string): number {
  const [year, month, day] = date.split('-').map(Number);
  return Date.UTC(year, month - 1, day) / UTC_DAY_MS;
}

function businessDaysBetween(fromDate: string, toDate: string): number {
  const fromDay = utcDayNumber(fromDate);
  const toDay = utcDayNumber(toDate);
  let businessDays = 0;
  for (let day = fromDay + 1; day <= toDay; day++) {
    const weekday = new Date(day * UTC_DAY_MS).getUTCDay();
    if (weekday !== 0 && weekday !== 6) businessDays++;
  }
  return businessDays;
}

export function asOfFresh(series: Obs[], date: string, freshnessRule: FreshnessRule): FreshnessResult {
  let latest: Obs | null = null;
  for (const observation of series) {
    if (observation.date <= date && (latest == null || observation.date > latest.date)) {
      latest = observation;
    }
  }

  if (latest == null) {
    return { value: null, observationDate: null, ageDays: null, status: 'MISSING' };
  }

  const ageDays = utcDayNumber(date) - utcDayNumber(latest.date);
  const ageBusinessDays = businessDaysBetween(latest.date, date);
  const stale = ageDays > freshnessRule.maxStaleCalendarDays
    || ageBusinessDays > freshnessRule.maxStaleBusinessDays
    || (freshnessRule.fallbackPolicy === 'NONE' && latest.date !== date);

  return {
    value: stale ? null : latest.value,
    observationDate: latest.date,
    ageDays,
    status: stale ? 'STALE' : 'FRESH',
  };
}

export function buildWeeklyNetliq(m: SeriesMap, upTo: string): number[] {
  const walcl = m.WALCL ?? [];
  const out: number[] = [];
  for (const w of walcl) {
    if (w.date > upTo) break;
    const tga = asOf(m.WDTGAL ?? [], w.date);
    const rrp = asOf(m.RRPONTSYD ?? [], w.date);
    if (tga == null || rrp == null) continue;
    out.push(w.value - tga - rrp);
  }
  return out;
}

export function changeOverDays(series: Obs[], date: string, days: number): number | null {
  const latest = asOf(series, date);
  if (latest == null) return null;
  const d = new Date(date + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - days);
  const past = asOf(series, d.toISOString().slice(0, 10));
  return past == null ? null : latest - past;
}

export function balanceSheetImpulse(walclWeekly: number[]): Impulse {
  if (walclWeekly.length < 14) return 'FLAT';
  const latest = walclWeekly[walclWeekly.length - 1];
  const past = walclWeekly[walclWeekly.length - 14]; // 13 weeks back
  const d = latest - past;
  if (d > QEQT_EPSILON_B) return 'EXPANDING';
  if (d < -QEQT_EPSILON_B) return 'CONTRACTING';
  return 'FLAT';
}

export function netliqDirection(netliqWeekly: number[]): Direction {
  const n = NETLIQ_TREND_WEEKS;
  const ma = sma(netliqWeekly, n);
  if (ma == null) return 'FLAT';
  const latest = netliqWeekly[netliqWeekly.length - 1];
  const rel = (latest - ma) / Math.max(1, Math.abs(ma)); // relative gap
  if (rel > 0.002) return 'UP';
  if (rel < -0.002) return 'DOWN';
  return 'FLAT';
}

export interface Factors {
  netliqTrend: number; impulse: number; credit: number; funding: number;
  rates: number; dollar: number; vol: number; reserveAdequacy: number; curve: number;
}

export type FactorStatus = 'OK' | 'PARTIAL' | 'STALE' | 'MISSING';
export interface FactorResult {
  score: number | null;
  quality: number;
  status: FactorStatus;
  asOf: string | null;
  components: Record<string, unknown>;
}
export type FactorResults = { [K in keyof Factors]: FactorResult };
export type DecisionStatus = 'OK' | 'DATA_INCOMPLETE';

export function percentileRank(value: number, history: number[]): number {
  if (history.length === 0) return 0.5;
  const below = history.filter(h => h <= value).length;
  return below / history.length;
}

export function scoreNetliqTrend(netliqWeekly: number[], n = NETLIQ_TREND_WEEKS): number {
  if (netliqWeekly.length < n + 1) return 50;
  const latest = netliqWeekly[netliqWeekly.length - 1];
  const ma = sma(netliqWeekly, n)!;
  const aboveMa = latest > ma ? 60 : 40;
  const idx4 = Math.max(0, netliqWeekly.length - 1 - 4);
  const slope = latest - netliqWeekly[idx4];       // ~4-week $B change
  const slopeScore = linMap(slope, -200, 200);
  return clamp(0.5 * aboveMa + 0.5 * slopeScore);
}

export function scoreImpulse(impulse: Impulse): number {
  return impulse === 'EXPANDING' ? 80 : impulse === 'CONTRACTING' ? 30 : 55;
}

export function scoreCredit(hyLatest: number, hyHistory: number[], delta20: number | null): number {
  const pct      = percentileRank(hyLatest, hyHistory);            // 0 low .. 1 high
  const calm     = clamp((1 - pct) * 100);                         // level: low OAS → high (original logic)
  const momentum = delta20 == null ? 50 : linMap(delta20, 1.00, -0.25); // spread tightening (Δ<0) → high; widening (Δ>0) → low
  // fragility: spread at historical extreme low (<15th pct) but starting to widen (Δ>0.20pp) = complacency cracking
  const fragility = (pct < 0.15 && delta20 != null && delta20 > 0.20) ? 15 : 0;
  return clamp(0.55 * calm + 0.45 * momentum - fragility);
}

export function scoreFunding(sofrIorb: number): number {
  // <=0 calm → 100; rises through +0.10 → 0
  return linMap(sofrIorb, 0.10, 0.0);
}

export function scoreRates(delta10y: number | null): number {
  if (delta10y == null) return 50;
  // +0.5pp over lookback = strong headwind (0); -0.5pp = tailwind (100)
  return linMap(delta10y, 0.5, -0.5);
}

export function scoreDollar(dxySeries: Obs[], date: string): number {
  const n = 200;
  const vals = dxySeries.filter(o => o.date <= date).map(o => o.value);
  if (vals.length < n) return 50;
  const ma = sma(vals, n)!;
  const slice = vals.slice(vals.length - n);
  const mean = slice.reduce((s, v) => s + v, 0) / n;
  const sd = Math.sqrt(slice.reduce((s, v) => s + (v - mean) ** 2, 0) / n);
  const latest = vals[vals.length - 1];
  const z = sd > 0 ? (latest - ma) / sd : 0;
  // strong dollar (z high) = headwind; below mean = tailwind
  return linMap(z, 1.0, -1.0);
}

export function scoreVol(vix: number | null): number {
  if (vix == null) return 50;
  // VIX 12 → 100, 30 → 0
  return linMap(vix, 30, 12);
}

/**
 * Reserve Adequacy score (0–100).
 * @param reservesLevel  Bank reserve balances at Fed ($B, from WRBWFRBL /1000)
 * @param deltaReserves13w  13-week change in reserves ($B); positive = building
 * @param sofrIorb  SOFR − IORB spread (pp); approximates funding stress (simplified from 20d p95)
 */
export function scoreReserveAdequacy(
  reservesLevel: number | null,
  deltaReserves13w: number | null,
  sofrIorb: number | null,
): number {
  const lvl  = reservesLevel    == null ? 50 : linMap(reservesLevel,    RESERVE_LOW,  RESERVE_HIGH); // abundant → high
  const mom  = deltaReserves13w == null ? 50 : linMap(deltaReserves13w, -300,          300);           // rising → high
  const fund = sofrIorb         == null ? 50 : linMap(sofrIorb,          0.10,         0.00);          // calm → high
  return clamp(0.5 * lvl + 0.3 * mom + 0.2 * fund);
}

/**
 * Yield-curve slope score (0–100).
 * @param slope       T10Y2Y level (pp): -0.5 inverted → 0, +1.5 steep → 100
 * @param slopeChange20  20-day change in T10Y2Y: -0.3 (flattening) → 0, +0.3 (steepening) → 100
 */
export function scoreCurve(slope: number | null, slopeChange20: number | null): number {
  const lvl = slope == null ? 50 : linMap(slope, -0.5, 1.5);
  const mom = slopeChange20 == null ? 50 : linMap(slopeChange20, -0.3, 0.3);
  return clamp(0.5 * lvl + 0.5 * mom);
}

export function weightedScore(f: Factors): number {
  const s =
    f.netliqTrend * WEIGHTS.netliqTrend + f.impulse * WEIGHTS.impulse +
    f.credit * WEIGHTS.credit + f.funding * WEIGHTS.funding +
    f.rates * WEIGHTS.rates + f.dollar * WEIGHTS.dollar + f.vol * WEIGHTS.vol +
    f.reserveAdequacy * WEIGHTS.reserveAdequacy + f.curve * WEIGHTS.curve;
  return clamp(s);
}

// ── Part 3b: buildGuidance — pure mapping function ────────────────────────────

export interface GuidanceInput {
  score: number;
  verdict: Verdict;
  netliqDir: Direction;
  qeQtRegime: Impulse;
  stressStatus: StressStatus;
  stressApplied?: boolean;
}

export interface GuidanceTrigger {
  label: string;
  detail: string;
  armed: boolean;
}

export interface Guidance {
  tone: 'bull' | 'neutral' | 'bear' | 'brake' | 'unknown';
  tierLabel: string;
  exposure: string;
  lean: string;
  divergence: string | null;
  triggers: GuidanceTrigger[];
}

export function buildGuidance(input: GuidanceInput): Guidance {
  const { score, verdict, netliqDir, qeQtRegime, stressStatus } = input;
  const stressed = stressStatus === 'STRESSED';
  const stressApplied = input.stressApplied ?? stressed;

  // Tier logic (ordered: stress first, then score bands)
  let tone: Guidance['tone'];
  let tierLabel: string;
  let exposure: string;
  let lean: string;

  if (stressStatus === 'UNKNOWN') {
    tone = 'unknown';
    tierLabel = '实时风险层不可用';
    exposure = '暂停加仓,风险敞口不高于基准';
    lean = '等待实时风险数据恢复';
  } else if (stressApplied) {
    tone = 'brake';
    tierLabel = 'RISK-OFF · 刹车';
    exposure = '立刻停止加仓、收到基准以下';
    lean = '现金/防御,等实时风险解除';
  } else if (verdict === 'BULLISH') {
    if (netliqDir === 'DOWN') {
      tone = 'neutral';
      tierLabel = '偏多但留意背离';
      exposure = '基准附近偏上,别追到满仓';
      lean = 'beta 可拿但控量';
    } else {
      tone = 'bull';
      tierLabel = '顺风 · 可加码';
      exposure = '基准 +15~20pp';
      lean = 'beta/成长(QQQ、高弹性)';
    }
  } else if (verdict === 'BEARISH') {
    if (netliqDir === 'DOWN') {
      tone = 'bear';
      tierLabel = '逆风 · 减仓';
      exposure = '基准 −15~20pp';
      lean = '质量/防御、现金';
    } else {
      tone = 'bear';
      tierLabel = '偏空 · 降一档';
      exposure = '基准以下';
      lean = '质量/防御';
    }
  } else if (score < 50) {
    tone = 'neutral';
    tierLabel = '中性偏谨慎';
    exposure = '维持基准或略低';
    lean = '均衡;别上杠杆,留点干火药';
  } else {
    tone = 'neutral';
    tierLabel = '中性偏多';
    exposure = '维持基准';
    lean = '均衡';
  }

  // Divergence detection
  let divergence: string | null = null;
  if (qeQtRegime === 'EXPANDING' && netliqDir === 'DOWN') {
    divergence = '扩表却收水:真正驱动股市的净流动性在抽水,别被 Fed 扩表骗';
  } else if (qeQtRegime === 'CONTRACTING' && netliqDir === 'UP') {
    divergence = '缩表却放水:净流动性反在改善';
  }

  // Triggers (two fixed)
  const trigger0: GuidanceTrigger = score >= VERDICT_BANDS.bear
    ? {
        label: `分数跌破 ${VERDICT_BANDS.bear} → 主动减一档`,
        detail: '当前 ' + score.toFixed(1) + `,距 ${VERDICT_BANDS.bear} 还有 ` + (score - VERDICT_BANDS.bear).toFixed(1),
        armed: (score - VERDICT_BANDS.bear) <= 2,
      }
    : {
        label: `分数已在 ${VERDICT_BANDS.bear} 下方 → 维持减仓`,
        detail: '当前 ' + score.toFixed(1),
        armed: true,
      };

  const trigger1: GuidanceTrigger = stressStatus === 'UNKNOWN'
    ? { label: '实时风险层不可用', detail: '实时风险层不可用：关键行情缺失,当前风险状态未知', armed: true }
    : stressed
    ? stressApplied
      ? { label: '实时风险(stress)触发 → 立刻刹车', detail: '已触发', armed: true }
      : {
          label: '实时风险已触发 · 强环境未降级',
          detail: `已触发,但当前分数 ${score.toFixed(1)} 达到 ${STRESS_SCORE_CEILING} 豁免线,强环境未下调`,
          armed: true,
        }
    : { label: '实时风险(stress)触发 → 立刻刹车', detail: '当前未触发', armed: false };

  return { tone, tierLabel, exposure, lean, divergence, triggers: [trigger0, trigger1] };
}

// ── Part 4: verdict + reason + computeSnapshot ────────────────────────────────

export type Verdict = 'BULLISH' | 'BEARISH' | 'NEUTRAL';

export interface Snapshot {
  date: string;
  walcl: number | null; tga: number | null; rrp: number | null; repo: number | null;
  netliq: number | null; netliqTrend: number | null;
  sofrIorb: number | null; hyOas: number | null; dgs10: number | null;
  dxy: number | null; vix: number | null;
  bsImpulse: Impulse; netliqDir: Direction; verdict: Verdict | null; score: number | null;
  factors: Partial<Factors>; factorResults: FactorResults; freshness: Record<string, FreshnessResult>;
  decisionStatus: DecisionStatus;
  p0: boolean; p1: boolean; p2: boolean; p3: boolean; reason: string;
  coverage: number;
}

export function verdictFromScore(score: number, prev?: Verdict): Verdict {
  if (score > VERDICT_BANDS.bull) return 'BULLISH';
  if (score < VERDICT_BANDS.bear) return 'BEARISH';
  return prev ?? 'NEUTRAL'; // dead-zone keeps previous verdict (hysteresis)
}

export function downgradeVerdict(v: Verdict): Verdict {
  return v === 'BULLISH' ? 'NEUTRAL' : v === 'NEUTRAL' ? 'BEARISH' : 'BEARISH';
}

const IMPULSE_CN: Record<Impulse, string> = { EXPANDING: '扩表', CONTRACTING: '缩表', FLAT: '横住' };
const DIR_CN: Record<Direction, string> = { UP: '在升', DOWN: '在收', FLAT: '走平' };
const VERDICT_CN: Record<Verdict, string> = { BULLISH: '偏多', BEARISH: '偏空', NEUTRAL: '中性' };

export function buildReason(impulse: Impulse, dir: Direction, verdict: Verdict): string {
  const divergence =
    (impulse === 'CONTRACTING' && dir === 'UP') ? '(缩表却放水,留意背离)' :
    (impulse === 'EXPANDING' && dir === 'DOWN') ? '(扩表却收水,留意背离)' : '';
  return `Fed ${IMPULSE_CN[impulse]}、净流动性${DIR_CN[dir]} → 环境${VERDICT_CN[verdict]}${divergence}`;
}

export interface DecisionInput {
  score: number | null;
  previousVerdict?: Verdict | null;
  netliqDir: Direction;
  qeQtRegime: Impulse;
  stressStatus: StressStatus;
  decisionStatus?: DecisionStatus;
}

export interface DecisionState {
  macroVerdict: Verdict | null;
  displayVerdict: Verdict | 'UNKNOWN';
  reason: string;
  guidance: Guidance;
}

export function deriveDecisionState(input: DecisionInput): DecisionState {
  if (input.decisionStatus === 'DATA_INCOMPLETE' || input.score == null) {
    return {
      macroVerdict: null,
      displayVerdict: 'UNKNOWN',
      reason: '宏观数据不完整，暂停方向性判断',
      guidance: {
        tone: 'unknown',
        tierLabel: '宏观数据不完整',
        exposure: '暂停风险增加，风险敞口不高于基准',
        lean: '等待关键宏观数据恢复',
        divergence: null,
        triggers: [{ label: '关键宏观数据恢复后再评估', detail: '当前无法形成可靠宏观判定', armed: true }],
      },
    };
  }
  const macroVerdict = verdictFromScore(input.score, input.previousVerdict ?? undefined);
  const stressApplied = input.stressStatus === 'STRESSED' && input.score < STRESS_SCORE_CEILING;
  const displayVerdict = input.stressStatus === 'UNKNOWN'
    ? 'UNKNOWN'
    : stressApplied ? downgradeVerdict(macroVerdict) : macroVerdict;
  const guidance = buildGuidance({
    score: input.score,
    verdict: macroVerdict,
    netliqDir: input.netliqDir,
    qeQtRegime: input.qeQtRegime,
    stressStatus: input.stressStatus,
    stressApplied,
  });
  return {
    macroVerdict,
    displayVerdict,
    reason: buildReason(input.qeQtRegime, input.netliqDir, macroVerdict),
    guidance,
  };
}

export type PolicyRegime = 'QE' | 'QT' | 'RESERVE_MGMT' | 'NEUTRAL';

export function policyRegime(impulse: Impulse, date: string): PolicyRegime {
  if (date >= QT_END_DATE) return 'RESERVE_MGMT';   // QT 已结束 → 资产负债表变动是准备金管理/T-bill 再投资,不是 QE/QT
  if (impulse === 'EXPANDING') return 'QE';
  if (impulse === 'CONTRACTING') return 'QT';
  return 'NEUTRAL';
}

export function computeSnapshot(m: SeriesMap, date: string, prev?: Verdict): Snapshot {
  const freshness: Record<string, FreshnessResult> = {};
  for (const [seriesId, rule] of Object.entries(SERIES)) {
    freshness[seriesId] = asOfFresh(m[seriesId] ?? [], date, rule);
  }

  const components = (seriesIds: string[], extra: Record<string, unknown> = {}) => ({
    ...Object.fromEntries(seriesIds.map(seriesId => [seriesId, freshness[seriesId]])),
    ...extra,
  });
  const oldestAsOf = (seriesIds: string[]): string | null => {
    const dates = seriesIds.map(seriesId => freshness[seriesId]?.observationDate);
    return dates.some(observationDate => observationDate == null)
      ? null
      : (dates as string[]).sort()[0];
  };
  const result = (
    seriesIds: string[],
    score: number | null,
    options: { partial?: boolean; historyUsable?: boolean; extra?: Record<string, unknown> } = {},
  ): FactorResult => {
    const statuses = seriesIds.map(seriesId => freshness[seriesId]?.status ?? 'MISSING');
    const unavailable = statuses.includes('MISSING') ? 'MISSING'
      : statuses.includes('STALE') ? 'STALE'
      : options.historyUsable === false ? 'MISSING'
      : null;
    if (unavailable) {
      return {
        score: null,
        quality: 0,
        status: unavailable,
        asOf: oldestAsOf(seriesIds),
        components: components(seriesIds, options.extra),
      };
    }
    return {
      score,
      quality: options.partial ? 0.5 : 1,
      status: options.partial ? 'PARTIAL' : 'OK',
      asOf: oldestAsOf(seriesIds),
      components: components(seriesIds, options.extra),
    };
  };

  const walclWeekly = (m.WALCL ?? []).filter(o => o.date <= date).map(o => o.value);
  const netliqWeekly = buildWeeklyNetliq(m, date);

  const walcl = freshness.WALCL.value;
  const tga = freshness.WDTGAL.value;
  const rrp = freshness.RRPONTSYD.value;
  const repo = freshness.RPONTSYD.value;
  const netliq = (walcl != null && tga != null && rrp != null) ? walcl - tga - rrp : null;

  const sofr = freshness.SOFR.value;
  const iorb = freshness.IORB.value;
  const sofrIorb = (sofr != null && iorb != null) ? sofr - iorb : null;
  const hyOas = freshness.BAMLH0A0HYM2.value;
  const hyHistory = (m.BAMLH0A0HYM2 ?? []).filter(o => o.date <= date).map(o => o.value);
  const creditDelta = changeOverDays(m.BAMLH0A0HYM2 ?? [], date, CREDIT_LOOKBACK_DAYS);
  const dgs10 = freshness.DGS10.value;
  const delta10y = changeOverDays(m.DGS10 ?? [], date, RATES_LOOKBACK_DAYS);
  const dxy = freshness.DTWEXBGS.value;
  const vix = freshness.VIXCLS.value;

  const bsImpulse = balanceSheetImpulse(walclWeekly);
  const netliqDir = netliqDirection(netliqWeekly);

  const reservesLevel = freshness.WRBWFRBL.value;
  const deltaReserves13w = changeOverDays(m.WRBWFRBL ?? [], date, 91); // ~13 weeks

  const curveSlope = freshness.T10Y2Y.value;
  const curveChange20 = changeOverDays(m.T10Y2Y ?? [], date, 20);

  const netliqHistoryUsable = netliqWeekly.length >= NETLIQ_TREND_WEEKS + 1;
  const impulseHistoryUsable = walclWeekly.length >= 14;
  const fundingUsable = sofrIorb != null;
  const factorResults: FactorResults = {
    netliqTrend: result(
      ['WALCL', 'WDTGAL', 'RRPONTSYD'],
      netliqHistoryUsable ? scoreNetliqTrend(netliqWeekly) : null,
      { historyUsable: netliqHistoryUsable, extra: { historyObservations: netliqWeekly.length } },
    ),
    impulse: result(
      ['WALCL'],
      impulseHistoryUsable ? scoreImpulse(bsImpulse) : null,
      { historyUsable: impulseHistoryUsable, extra: { historyObservations: walclWeekly.length } },
    ),
    credit: result(
      ['BAMLH0A0HYM2'],
      hyOas != null ? scoreCredit(hyOas, hyHistory, creditDelta) : null,
      { partial: creditDelta == null, extra: { lookbackChange: creditDelta } },
    ),
    funding: result(['SOFR', 'IORB'], fundingUsable ? scoreFunding(sofrIorb) : null),
    rates: result(
      ['DGS10'],
      delta10y != null ? scoreRates(delta10y) : null,
      { historyUsable: delta10y != null, extra: { lookbackChange: delta10y } },
    ),
    dollar: result(
      ['DTWEXBGS'],
      (m.DTWEXBGS ?? []).filter(o => o.date <= date).length >= 200 ? scoreDollar(m.DTWEXBGS ?? [], date) : null,
      {
        historyUsable: (m.DTWEXBGS ?? []).filter(o => o.date <= date).length >= 200,
        extra: { historyObservations: (m.DTWEXBGS ?? []).filter(o => o.date <= date).length },
      },
    ),
    vol: result(['VIXCLS'], vix != null ? scoreVol(vix) : null),
    reserveAdequacy: result(
      ['WRBWFRBL'],
      reservesLevel != null ? scoreReserveAdequacy(reservesLevel, deltaReserves13w, sofrIorb) : null,
      {
        partial: deltaReserves13w == null || !fundingUsable,
        extra: { deltaReserves13w, SOFR: freshness.SOFR, IORB: freshness.IORB },
      },
    ),
    curve: result(
      ['T10Y2Y'],
      curveSlope != null ? scoreCurve(curveSlope, curveChange20) : null,
      { partial: curveChange20 == null, extra: { lookbackChange: curveChange20 } },
    ),
  };
  const factors = Object.fromEntries(
    Object.entries(factorResults)
      .filter(([, factor]) => factor.score != null)
      .map(([key, factor]) => [key, factor.score]),
  ) as Partial<Factors>;
  const availableWeightedFactors = (Object.keys(WEIGHTS) as (keyof Factors)[])
    .filter(key => WEIGHTS[key] > 0 && factorResults[key].score != null);
  const availableWeight = availableWeightedFactors.reduce((sum, key) => sum + WEIGHTS[key], 0);
  const aggregateScore = availableWeight === 0 ? null : clamp(
    availableWeightedFactors.reduce((sum, key) => sum + factorResults[key].score! * WEIGHTS[key], 0) / availableWeight,
  );
  const decisionStatus: DecisionStatus = factorResults.netliqTrend.status === 'OK' ? 'OK' : 'DATA_INCOMPLETE';
  const score = decisionStatus === 'OK' ? aggregateScore : null;
  const decision = deriveDecisionState({
    score,
    previousVerdict: prev,
    netliqDir,
    qeQtRegime: bsImpulse,
    stressStatus: 'NORMAL',
    decisionStatus,
  });

  const coverage = COVERAGE_FACTORS
    .reduce((sum, key) => sum + factorResults[key].quality, 0) / COVERAGE_FACTORS.length;

  return {
    date, walcl, tga, rrp, repo, netliq, netliqTrend: sma(netliqWeekly, NETLIQ_TREND_WEEKS),
    sofrIorb, hyOas, dgs10, dxy, vix, bsImpulse, netliqDir, verdict: decision.macroVerdict, score, factors,
    factorResults, freshness, decisionStatus,
    p0: (factorResults.rates.score ?? -Infinity) >= 50 && (factorResults.funding.score ?? -Infinity) >= 50 && (factorResults.credit.score ?? -Infinity) >= 50,
    p1: (factorResults.netliqTrend.score ?? -Infinity) >= 50 || (factorResults.impulse.score ?? -Infinity) >= 50,
    p2: (factorResults.dollar.score ?? -Infinity) >= 50,
    p3: (factorResults.vol.score ?? -Infinity) >= 50,
    reason: decision.reason,
    coverage,
  };
}
