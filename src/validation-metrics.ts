import { spearman } from './backtest';
import type { ForwardPair } from './evaluation-protocol';

export type MetricStatus =
  | 'OK'
  | 'INSUFFICIENT_SAMPLE'
  | 'NO_ELIGIBLE_OBSERVATIONS'
  | 'ZERO_VARIANCE'
  | 'MISSING_FORMAL_SIGNAL'
  | 'PENDING_MATURITY';

export interface RateEstimate {
  value: number | null;
  hits: number;
  n: number;
  abstentions: number;
  minRequired: number;
  status: MetricStatus;
}

export interface IcEstimate {
  value: number | null;
  n: number;
  status: MetricStatus;
}

const MIN_RATE_N = 5;
const MIN_IC_N = 3;
const MIN_TAIL_CALIBRATION_N = 20;
const MIN_TEST_TAIL_EVENTS = 3;

function rate(hits: number, n: number, abstentions: number, missingFormal = false, minRequired = MIN_RATE_N): RateEstimate {
  if (n === 0) {
    return {
      value: null, hits, n, abstentions, minRequired,
      status: missingFormal ? 'MISSING_FORMAL_SIGNAL' : 'NO_ELIGIBLE_OBSERVATIONS',
    };
  }
  if (n < minRequired) {
    return { value: null, hits, n, abstentions, minRequired, status: 'INSUFFICIENT_SAMPLE' };
  }
  return { value: hits / n, hits, n, abstentions, minRequired, status: 'OK' };
}

export function quantile(values: number[], q: number): number | null {
  const finite = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (finite.length === 0 || !Number.isFinite(q) || q < 0 || q > 1) return null;
  const position = (finite.length - 1) * q;
  const low = Math.floor(position);
  const high = Math.ceil(position);
  return low === high ? finite[low] : finite[low] + (finite[high] - finite[low]) * (position - low);
}

function directionRate(pairs: ForwardPair[]): RateEstimate {
  let hits = 0;
  let n = 0;
  for (const pair of pairs) {
    if (pair.score === 50 || pair.fwd === 0) continue;
    n++;
    if ((pair.score > 50) === (pair.fwd > 0)) hits++;
  }
  return rate(hits, n, pairs.length - n);
}

function verdictRate(pairs: ForwardPair[]): RateEstimate {
  let hits = 0;
  let n = 0;
  let missing = false;
  for (const pair of pairs) {
    if (pair.verdict == null) { missing = true; continue; }
    if (pair.verdict === 'NEUTRAL' || pair.fwd === 0) continue;
    n++;
    if ((pair.verdict === 'BULLISH') === (pair.fwd > 0)) hits++;
  }
  if (missing) return { ...rate(hits, n, pairs.length - n, true), value: null, status: 'MISSING_FORMAL_SIGNAL' };
  return rate(hits, n, pairs.length - n);
}

function riskRates(pairs: ForwardPair[]) {
  const eligible = pairs.filter(pair => pair.targetExposure != null && pair.fwd !== 0);
  const missing = pairs.some(pair => pair.targetExposure == null);
  const riskCalls = eligible.filter(pair => pair.targetExposure! <= .5);
  const downside = eligible.filter(pair => pair.fwd < 0);
  const caught = riskCalls.filter(pair => pair.fwd < 0).length;
  if (missing) return {
    precision: { ...rate(caught, riskCalls.length, pairs.length - riskCalls.length, true), value: null, status: 'MISSING_FORMAL_SIGNAL' as const },
    downsideRecall: { ...rate(caught, downside.length, pairs.length - downside.length, true), value: null, status: 'MISSING_FORMAL_SIGNAL' as const },
  };
  return { precision: rate(caught, riskCalls.length, pairs.length - riskCalls.length), downsideRecall: rate(caught, downside.length, pairs.length - downside.length) };
}

function informationCoefficient(pairs: ForwardPair[]): IcEstimate {
  if (pairs.length < MIN_IC_N) return { value: null, n: pairs.length, status: 'INSUFFICIENT_SAMPLE' };
  const returns = pairs.map(pair => pair.fwd);
  const scores = pairs.map(pair => pair.score);
  if (new Set(returns).size < 2 || new Set(scores).size < 2) return { value: null, n: pairs.length, status: 'ZERO_VARIANCE' };
  const value = spearman(scores, returns);
  return Number.isFinite(value)
    ? { value, n: pairs.length, status: 'OK' }
    : { value: null, n: pairs.length, status: 'ZERO_VARIANCE' };
}

export function evaluateValidationMetrics(pairs: ForwardPair[], tailThreshold: number | null, calibrationN = 0) {
  const risk = riskRates(pairs);
  const tailEvents = tailThreshold == null ? [] : pairs.filter(pair => pair.fwd <= tailThreshold);
  const riskCalls = pairs.filter(pair => pair.targetExposure != null && pair.targetExposure <= .5);
  const caught = tailThreshold == null ? 0 : riskCalls.filter(pair => pair.fwd <= tailThreshold).length;
  const tailReady = tailThreshold != null && calibrationN >= MIN_TAIL_CALIBRATION_N
    && tailEvents.length >= MIN_TEST_TAIL_EVENTS;
  const tailStatus: MetricStatus = tailThreshold == null || calibrationN < MIN_TAIL_CALIBRATION_N
    ? 'INSUFFICIENT_SAMPLE'
    : tailEvents.length < MIN_TEST_TAIL_EVENTS ? 'INSUFFICIENT_SAMPLE' : 'OK';
  const tailRate = (hits: number, n: number): RateEstimate => ({
    value: tailReady && n > 0 ? hits / n : null,
    hits, n, abstentions: pairs.length - n,
    minRequired: MIN_TEST_TAIL_EVENTS,
    status: tailReady && n > 0 ? 'OK' : tailStatus,
  });
  return {
    direction: directionRate(pairs),
    formalVerdict: verdictRate(pairs),
    risk,
    ic: informationCoefficient(pairs),
    tail: {
      recall: tailRate(caught, tailEvents.length),
      precision: tailRate(caught, riskCalls.length),
      tailEvents: tailEvents.length,
      caught,
      riskCalls: riskCalls.length,
      calibrationN,
      threshold: tailThreshold,
      method: 'TRAIN_ONLY_Q10' as const,
    },
  };
}

export type ValidationMetrics = ReturnType<typeof evaluateValidationMetrics>;
