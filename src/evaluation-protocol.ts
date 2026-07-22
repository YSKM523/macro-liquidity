import { addDays, spearman } from './backtest';
import { sha256Hex } from './model-version';
import { evaluateValidationMetrics, quantile } from './validation-metrics';
import type { ValidationMetrics } from './validation-metrics';

export type FormalVerdict = 'BULLISH' | 'BEARISH' | 'NEUTRAL';

export interface ValidationSnap {
  date: string;
  score: number;
  spx: number;
  factors: Record<string, number>;
  verdict?: FormalVerdict | null;
  targetExposure?: number | null;
  pitStatus?: string | null;
  provenanceStatus?: 'GOVERNED' | 'LEGACY' | string | null;
}

export interface ForwardPair {
  startIdx: number;
  endIdx: number;
  signalDate: string;
  outcomeDate: string;
  score: number;
  fwd: number;
  verdict: FormalVerdict | null;
  targetExposure: number | null;
  factors: Record<string, number>;
}

export const VALIDATION_PROTOCOL = Object.freeze({
  protocol: 'PURGED_VALIDATION_V1' as const,
  horizonWeeks: 13,
  embargoDays: 91,
  holdoutFrom: '2026-07-23',
  purgeRule: 'OUTCOME_ON_OR_AFTER_TEST_FROM',
  independentRule: 'GREEDY_INTERVAL_NON_OVERLAP',
  tailRule: 'TRAIN_ONLY_Q10',
  minimumRateN: 5,
  minimumTailCalibrationN: 20,
  minimumTestTailEvents: 3,
});

const PROTOCOL_CANONICAL = JSON.stringify(VALIDATION_PROTOCOL, Object.keys(VALIDATION_PROTOCOL).sort());
export const HOLDOUT_REGISTRATION = Object.freeze({
  protocol: VALIDATION_PROTOCOL.protocol,
  holdoutFrom: VALIDATION_PROTOCOL.holdoutFrom,
  registeredAt: '2026-07-22T00:00:00Z',
  protocolDigest: sha256Hex(PROTOCOL_CANONICAL),
});

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function dateMs(date: string): number {
  if (!DATE_RE.test(date)) throw new Error(`invalid validation date: ${date}`);
  const value = Date.parse(`${date}T00:00:00Z`);
  if (!Number.isFinite(value) || new Date(value).toISOString().slice(0, 10) !== date) {
    throw new Error(`invalid validation date: ${date}`);
  }
  return value;
}

export function assertChronological(snaps: ValidationSnap[]): void {
  let prior = -Infinity;
  for (const snap of snaps) {
    const current = dateMs(snap.date);
    if (current <= prior) throw new Error('validation dates must be strictly increasing and unique');
    if (!Number.isFinite(snap.score) || !Number.isFinite(snap.spx) || snap.spx <= 0) {
      throw new Error(`invalid validation observation: ${snap.date}`);
    }
    prior = current;
  }
}

export function buildForwardPairs(snaps: ValidationSnap[], horizonWeeks: number = VALIDATION_PROTOCOL.horizonWeeks): ForwardPair[] {
  assertChronological(snaps);
  const horizonDays = horizonWeeks * 7;
  const pairs: ForwardPair[] = [];
  for (let startIdx = 0; startIdx < snaps.length; startIdx++) {
    const target = addDays(snaps[startIdx].date, horizonDays);
    const endIdx = snaps.findIndex((snap, index) => index > startIdx && snap.date >= target);
    if (endIdx < 0) continue;
    const lag = (dateMs(snaps[endIdx].date) - dateMs(target)) / 86_400_000;
    if (lag > 14) continue;
    pairs.push({
      startIdx, endIdx,
      signalDate: snaps[startIdx].date,
      outcomeDate: snaps[endIdx].date,
      score: snaps[startIdx].score,
      fwd: snaps[endIdx].spx / snaps[startIdx].spx - 1,
      verdict: snaps[startIdx].verdict ?? null,
      targetExposure: snaps[startIdx].targetExposure ?? null,
      factors: snaps[startIdx].factors,
    });
  }
  return pairs;
}

export function purgeTrainingPairs(pairs: ForwardPair[], testFrom: string, embargoDays: number = VALIDATION_PROTOCOL.embargoDays) {
  const embargoFrom = addDays(testFrom, -embargoDays);
  const kept: ForwardPair[] = [];
  let purgedOverlapN = 0;
  let embargoedN = 0;
  for (const pair of pairs) {
    if (pair.signalDate >= embargoFrom) { embargoedN++; continue; }
    if (pair.outcomeDate >= testFrom) { purgedOverlapN++; continue; }
    kept.push(pair);
  }
  return { pairs: kept, purgedOverlapN, embargoedN, embargoFrom };
}

export function greedyIndependentPairs(pairs: ForwardPair[]): ForwardPair[] {
  const sorted = [...pairs].sort((a, b) => a.signalDate.localeCompare(b.signalDate) || a.outcomeDate.localeCompare(b.outcomeDate));
  const result: ForwardPair[] = [];
  for (const pair of sorted) {
    if (result.length === 0 || pair.signalDate >= result[result.length - 1].outcomeDate) result.push(pair);
  }
  return result;
}

const FACTOR_KEYS = ['netliqTrend','impulse','credit','funding','rates','dollar','vol','reserveAdequacy','curve'];

export function trainingWeights(pairs: ForwardPair[]): Record<string, number> {
  const raw: Record<string, number> = {};
  let sum = 0;
  const eligible: string[] = [];
  for (const key of FACTOR_KEYS) {
    const usable = pairs.filter(pair => Number.isFinite(pair.factors[key]));
    if (usable.length >= 3) eligible.push(key);
    const weight = usable.length >= 3
      ? Math.max(0, spearman(usable.map(pair => pair.factors[key]), usable.map(pair => pair.fwd)))
      : 0;
    raw[key] = weight;
    sum += weight;
  }
  if (sum > 0) return Object.fromEntries(FACTOR_KEYS.map(key => [key, raw[key] / sum]));
  const equal = eligible.length > 0 ? 1 / eligible.length : 0;
  return Object.fromEntries(FACTOR_KEYS.map(key => [key, eligible.includes(key) ? equal : 0]));
}

export interface PurgedFold {
  testFrom: string;
  testTo: string;
  testLabelThrough: string;
  trainLabelThrough: string | null;
  trainN: number;
  purgedOverlapN: number;
  embargoedN: number;
  overlappingN: number;
  independentN: number;
  weights: Record<string, number>;
  q10: number | null;
  metrics: ValidationMetrics;
  trainPairs: ForwardPair[];
  testPairs: ForwardPair[];
}

export function buildPurgedFolds(
  snaps: ValidationSnap[],
  opts: { initialTrain?: number; testN?: number; horizonWeeks?: number; embargoDays?: number } = {},
): PurgedFold[] {
  assertChronological(snaps);
  const initialTrain = opts.initialTrain ?? 200;
  const testN = opts.testN ?? 52;
  const horizonWeeks = opts.horizonWeeks ?? VALIDATION_PROTOCOL.horizonWeeks;
  const embargoDays = opts.embargoDays ?? VALIDATION_PROTOCOL.embargoDays;
  const allPairs = buildForwardPairs(snaps, horizonWeeks);
  const folds: PurgedFold[] = [];
  for (let testStartIdx = initialTrain; testStartIdx < snaps.length; testStartIdx += testN) {
    const testEndIdx = Math.min(snaps.length - 1, testStartIdx + testN - 1);
    const testFrom = snaps[testStartIdx].date;
    const testTo = snaps[testEndIdx].date;
    const candidates = allPairs.filter(pair => pair.startIdx < testStartIdx);
    const purged = purgeTrainingPairs(candidates, testFrom, embargoDays);
    const testPairs = allPairs.filter(pair => pair.startIdx >= testStartIdx && pair.startIdx <= testEndIdx);
    if (testPairs.length === 0) continue;
    const q10 = quantile(purged.pairs.map(pair => pair.fwd), .1);
    folds.push({
      testFrom, testTo,
      testLabelThrough: testPairs.at(-1)!.outcomeDate,
      trainLabelThrough: purged.pairs.at(-1)?.outcomeDate ?? null,
      trainN: purged.pairs.length,
      purgedOverlapN: purged.purgedOverlapN,
      embargoedN: purged.embargoedN,
      overlappingN: testPairs.length,
      independentN: greedyIndependentPairs(testPairs).length,
      weights: trainingWeights(purged.pairs),
      q10,
      metrics: evaluateValidationMetrics(testPairs, q10, purged.pairs.length),
      trainPairs: purged.pairs,
      testPairs,
    });
  }
  return folds;
}

function governedPit(snaps: ValidationSnap[]): boolean {
  return snaps.every(snap => snap.pitStatus === 'PIT' && snap.provenanceStatus === 'GOVERNED');
}

function frozenTraining(snaps: ValidationSnap[]) {
  const pre = snaps.filter(snap => snap.date < HOLDOUT_REGISTRATION.holdoutFrom);
  const pairs = buildForwardPairs(pre).filter(pair => pair.outcomeDate < HOLDOUT_REGISTRATION.holdoutFrom);
  return {
    trainingThrough: pre.at(-1)?.date ?? null,
    trainingN: pairs.length,
    weights: trainingWeights(pairs),
    q10: quantile(pairs.map(pair => pair.fwd), .1),
  };
}

export function runFrozenHoldout(snaps: ValidationSnap[]) {
  assertChronological(snaps);
  const frozen = {
    ...HOLDOUT_REGISTRATION,
    ...frozenTraining(snaps),
  };
  if (!governedPit(snaps)) return { status: 'DATA_INCOMPLETE' as const, frozen, overlappingN: 0, independentN: 0, metrics: null };
  const pairs = buildForwardPairs(snaps).filter(pair => pair.signalDate >= HOLDOUT_REGISTRATION.holdoutFrom);
  if (pairs.length < VALIDATION_PROTOCOL.minimumRateN) {
    return { status: 'PENDING_MATURITY' as const, frozen, overlappingN: pairs.length, independentN: greedyIndependentPairs(pairs).length, metrics: null };
  }
  return {
    status: 'OK' as const, frozen,
    overlappingN: pairs.length,
    independentN: greedyIndependentPairs(pairs).length,
    metrics: evaluateValidationMetrics(pairs, frozen.q10, frozen.trainingN),
  };
}

export function runPurgedValidation(
  snaps: ValidationSnap[],
  opts: { initialTrain?: number; testN?: number } = {},
) {
  assertChronological(snaps);
  const protocol = { ...VALIDATION_PROTOCOL, protocolDigest: HOLDOUT_REGISTRATION.protocolDigest };
  if (!governedPit(snaps)) {
    return { status: 'DATA_INCOMPLETE' as const, protocol, folds: [], aggregateMetrics: null, holdout: runFrozenHoldout(snaps) };
  }
  const folds = buildPurgedFolds(snaps, opts);
  const testPairs = folds.flatMap(fold => fold.testPairs);
  const finalTraining = folds.at(-1)?.trainPairs ?? [];
  return {
    status: folds.length > 0 ? 'OK' as const : 'INSUFFICIENT_SAMPLE' as const,
    protocol,
    folds: folds.map(({ trainPairs: _trainPairs, testPairs: _testPairs, ...fold }) => fold),
    aggregateMetrics: testPairs.length > 0
      ? evaluateValidationMetrics(testPairs, quantile(finalTraining.map(pair => pair.fwd), .1), finalTraining.length)
      : null,
    overlappingN: testPairs.length,
    independentN: greedyIndependentPairs(testPairs).length,
    holdout: runFrozenHoldout(snaps),
  };
}
