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
  pitStatus: string | null;
  provenanceStatus: string | null;
}

export const VALIDATION_PROTOCOL = Object.freeze({
  protocol: 'PURGED_VALIDATION_V1' as const,
  horizonWeeks: 13,
  embargoDays: 91,
  initialTrain: 200,
  testN: 52,
  outcomeToleranceDays: 14,
  holdoutFrom: '2026-07-23',
  purgeRule: 'OUTCOME_ON_OR_AFTER_TEST_FROM',
  independentRule: 'GREEDY_INTERVAL_NON_OVERLAP',
  tailRule: 'TRAIN_ONLY_Q10_LINEAR_TYPE7',
  diagnosticWeightRule: 'MAX_POSITIVE_TRAIN_SPEARMAN_NORMALIZED_ELSE_EQUAL',
  directionRule: 'SCORE_VS_50_ZERO_ABSTAINS',
  formalVerdictRule: 'PERSISTED_VERDICT_NEUTRAL_ABSTAINS',
  riskRule: 'EXISTING_TARGET_EXPOSURE_LTE_0_50',
  minimumRateN: 5,
  minimumIcN: 3,
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
    if (lag > VALIDATION_PROTOCOL.outcomeToleranceDays) continue;
    pairs.push({
      startIdx, endIdx,
      signalDate: snaps[startIdx].date,
      outcomeDate: snaps[endIdx].date,
      score: snaps[startIdx].score,
      fwd: snaps[endIdx].spx / snaps[startIdx].spx - 1,
      verdict: snaps[startIdx].verdict ?? null,
      targetExposure: snaps[startIdx].targetExposure ?? null,
      factors: snaps[startIdx].factors,
      pitStatus: snaps[startIdx].pitStatus ?? null,
      provenanceStatus: snaps[startIdx].provenanceStatus ?? null,
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
    if (pair.outcomeDate >= testFrom) { purgedOverlapN++; continue; }
    if (pair.signalDate >= embargoFrom) { embargoedN++; continue; }
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
  diagnosticFittedWeights: Record<string, number>;
  diagnosticFitted: Pick<ValidationMetrics, 'direction' | 'ic'>;
  q10: number | null;
  tailCalibrationStatus: 'GOVERNED' | 'PARTIAL_LEGACY_CALIBRATION' | 'INSUFFICIENT_SAMPLE';
  metrics: ValidationMetrics;
  trainPairs: ForwardPair[];
  testPairs: ForwardPair[];
}

export function buildPurgedFolds(
  snaps: ValidationSnap[],
  opts: { initialTrain?: number; testN?: number; horizonWeeks?: number; embargoDays?: number } = {},
): PurgedFold[] {
  assertChronological(snaps);
  const initialTrain = opts.initialTrain ?? VALIDATION_PROTOCOL.initialTrain;
  const testN = opts.testN ?? VALIDATION_PROTOCOL.testN;
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
    const legacyCalibration = purged.pairs.some(pair => pair.provenanceStatus === 'LEGACY');
    const q10 = !legacyCalibration && purged.pairs.length >= VALIDATION_PROTOCOL.minimumTailCalibrationN
      ? quantile(purged.pairs.map(pair => pair.fwd), .1) : null;
    const diagnosticFittedWeights = trainingWeights(purged.pairs);
    const fittedPairs = testPairs.flatMap(pair => {
      const available = Object.entries(diagnosticFittedWeights)
        .filter(([key, weight]) => weight > 0 && Number.isFinite(pair.factors[key]));
      const denominator = available.reduce((sum, [, weight]) => sum + weight, 0);
      if (!(denominator > 0)) return [];
      const score = available.reduce((sum, [key, weight]) => sum + pair.factors[key] * weight, 0) / denominator;
      return [{ ...pair, score }];
    });
    const fitted = evaluateValidationMetrics(fittedPairs, null, 0);
    const metrics = evaluateValidationMetrics(testPairs, q10, purged.pairs.length);
    if (legacyCalibration) {
      metrics.tail.recall = { ...metrics.tail.recall, value: null, status: 'PARTIAL_LEGACY_CALIBRATION' };
      metrics.tail.precision = { ...metrics.tail.precision, value: null, status: 'PARTIAL_LEGACY_CALIBRATION' };
    }
    folds.push({
      testFrom, testTo,
      testLabelThrough: testPairs.at(-1)!.outcomeDate,
      trainLabelThrough: purged.pairs.at(-1)?.outcomeDate ?? null,
      trainN: purged.pairs.length,
      purgedOverlapN: purged.purgedOverlapN,
      embargoedN: purged.embargoedN,
      overlappingN: testPairs.length,
      independentN: greedyIndependentPairs(testPairs).length,
      diagnosticFittedWeights,
      diagnosticFitted: { direction: fitted.direction, ic: fitted.ic },
      q10,
      tailCalibrationStatus: legacyCalibration ? 'PARTIAL_LEGACY_CALIBRATION'
        : purged.pairs.length >= VALIDATION_PROTOCOL.minimumTailCalibrationN ? 'GOVERNED' : 'INSUFFICIENT_SAMPLE',
      metrics,
      trainPairs: purged.pairs,
      testPairs,
    });
  }
  return folds;
}

function frozenTraining(snaps: ValidationSnap[]) {
  const pre = snaps.filter(snap => snap.date < HOLDOUT_REGISTRATION.holdoutFrom);
  const trainingOutcomeCutoffExclusive = addDays(HOLDOUT_REGISTRATION.holdoutFrom, -VALIDATION_PROTOCOL.embargoDays);
  const pairs = buildForwardPairs(pre).filter(pair => pair.outcomeDate < trainingOutcomeCutoffExclusive);
  const legacyCalibration = pairs.some(pair => pair.provenanceStatus === 'LEGACY');
  return {
    trainingOutcomeCutoffExclusive,
    trainingThrough: pairs.at(-1)?.signalDate ?? null,
    trainingLabelThrough: pairs.at(-1)?.outcomeDate ?? null,
    trainingN: pairs.length,
    weights: trainingWeights(pairs),
    calibrationStatus: legacyCalibration ? 'PARTIAL_LEGACY_CALIBRATION' as const
      : pairs.length >= VALIDATION_PROTOCOL.minimumTailCalibrationN ? 'GOVERNED' as const : 'INSUFFICIENT_SAMPLE' as const,
    q10: !legacyCalibration && pairs.length >= VALIDATION_PROTOCOL.minimumTailCalibrationN
      ? quantile(pairs.map(pair => pair.fwd), .1) : null,
  };
}

function provenanceSummary(snaps: ValidationSnap[]) {
  const governedCount = snaps.filter(snap => snap.provenanceStatus === 'GOVERNED').length;
  const legacyCount = snaps.filter(snap => snap.provenanceStatus === 'LEGACY').length;
  return {
    totalCount: snaps.length, governedCount, legacyCount,
    completeness: legacyCount === 0 ? 'COMPLETE' as const : 'PARTIAL_LEGACY' as const,
  };
}

function validPitProvenance(snaps: ValidationSnap[]): boolean {
  return snaps.every(snap => snap.pitStatus === 'PIT'
    && (snap.provenanceStatus === 'GOVERNED' || snap.provenanceStatus === 'LEGACY'));
}

export function runFrozenHoldout(snaps: ValidationSnap[]) {
  assertChronological(snaps);
  const frozen = {
    ...HOLDOUT_REGISTRATION,
    ...frozenTraining(snaps),
  };
  const provenance = provenanceSummary(snaps);
  const postRegistration = snaps.filter(snap => snap.date >= HOLDOUT_REGISTRATION.holdoutFrom);
  if (!validPitProvenance(snaps) || postRegistration.some(snap => snap.provenanceStatus !== 'GOVERNED')) {
    return { status: 'DATA_INCOMPLETE' as const, frozen, provenance, overlappingN: 0, independentN: 0, metrics: null };
  }
  const pairs = buildForwardPairs(snaps).filter(pair => pair.signalDate >= HOLDOUT_REGISTRATION.holdoutFrom);
  if (pairs.length < VALIDATION_PROTOCOL.minimumRateN) {
    return { status: 'PENDING_MATURITY' as const, frozen, provenance, overlappingN: pairs.length, independentN: greedyIndependentPairs(pairs).length, metrics: null };
  }
  const metrics = evaluateValidationMetrics(pairs, frozen.q10, frozen.trainingN);
  if (frozen.calibrationStatus === 'PARTIAL_LEGACY_CALIBRATION') {
    metrics.tail.recall = { ...metrics.tail.recall, value: null, status: 'PARTIAL_LEGACY_CALIBRATION' };
    metrics.tail.precision = { ...metrics.tail.precision, value: null, status: 'PARTIAL_LEGACY_CALIBRATION' };
  }
  return {
    status: 'OK' as const, frozen, provenance,
    overlappingN: pairs.length,
    independentN: greedyIndependentPairs(pairs).length,
    metrics,
  };
}

export function runPurgedValidation(
  snaps: ValidationSnap[],
  opts: { initialTrain?: number; testN?: number } = {},
) {
  assertChronological(snaps);
  const protocol = { ...VALIDATION_PROTOCOL, protocolDigest: HOLDOUT_REGISTRATION.protocolDigest };
  const provenance = provenanceSummary(snaps);
  if (!validPitProvenance(snaps)) {
    return { status: 'DATA_INCOMPLETE' as const, protocol, provenance, folds: [], aggregateMetrics: null, holdout: runFrozenHoldout(snaps) };
  }
  const folds = buildPurgedFolds(snaps, opts);
  const testPairs = folds.flatMap(fold => fold.testPairs);
  const aggregateBase = testPairs.length > 0 ? evaluateValidationMetrics(testPairs, null, 0) : null;
  const totalTailEvents = folds.reduce((sum, fold) => sum + fold.metrics.tail.tailEvents, 0);
  const totalCaught = folds.reduce((sum, fold) => sum + fold.metrics.tail.caught, 0);
  const totalRiskCalls = folds.reduce((sum, fold) => sum + fold.metrics.tail.riskCalls, 0);
  const legacyCalibration = folds.some(fold => fold.tailCalibrationStatus === 'PARTIAL_LEGACY_CALIBRATION');
  const missingRiskSignal = folds.some(fold => fold.metrics.tail.recall.status === 'MISSING_FORMAL_SIGNAL');
  const calibrationReady = folds.length > 0 && !legacyCalibration
    && folds.every(fold => fold.metrics.tail.calibrationN >= VALIDATION_PROTOCOL.minimumTailCalibrationN);
  const tailReady = calibrationReady && !missingRiskSignal && totalTailEvents >= VALIDATION_PROTOCOL.minimumTestTailEvents;
  const aggregateTail = aggregateBase == null ? null : {
    recall: {
      value: tailReady ? totalCaught / totalTailEvents : null,
      hits: totalCaught, n: totalTailEvents, abstentions: testPairs.length - totalTailEvents,
      minRequired: VALIDATION_PROTOCOL.minimumTestTailEvents,
      status: missingRiskSignal ? 'MISSING_FORMAL_SIGNAL' as const
        : legacyCalibration ? 'PARTIAL_LEGACY_CALIBRATION' as const : tailReady ? 'OK' as const : 'INSUFFICIENT_SAMPLE' as const,
    },
    precision: {
      value: tailReady && totalRiskCalls > 0 ? totalCaught / totalRiskCalls : null,
      hits: totalCaught, n: totalRiskCalls, abstentions: testPairs.length - totalRiskCalls,
      minRequired: VALIDATION_PROTOCOL.minimumTestTailEvents,
      status: missingRiskSignal ? 'MISSING_FORMAL_SIGNAL' as const
        : legacyCalibration ? 'PARTIAL_LEGACY_CALIBRATION' as const
        : tailReady && totalRiskCalls > 0 ? 'OK' as const : 'INSUFFICIENT_SAMPLE' as const,
    },
    tailEvents: totalTailEvents,
    caught: totalCaught,
    riskCalls: totalRiskCalls,
    calibrationN: null,
    foldCalibrationN: folds.map(fold => fold.metrics.tail.calibrationN),
    threshold: null,
    thresholdSemantics: 'FOLD_SPECIFIC' as const,
    method: 'TRAIN_ONLY_Q10' as const,
  };
  return {
    status: folds.length > 0 ? (provenance.legacyCount > 0 ? 'PARTIAL_LEGACY' as const : 'OK' as const) : 'INSUFFICIENT_SAMPLE' as const,
    protocol, provenance,
    folds: folds.map(({ trainPairs: _trainPairs, testPairs, ...fold }) => ({
      ...fold,
      labels: testPairs.map(pair => ({ signalDate: pair.signalDate, outcomeDate: pair.outcomeDate })),
    })),
    aggregateMetrics: aggregateBase == null || aggregateTail == null ? null : { ...aggregateBase, tail: aggregateTail },
    overlappingN: testPairs.length,
    independentN: greedyIndependentPairs(testPairs).length,
    holdout: runFrozenHoldout(snaps),
  };
}
