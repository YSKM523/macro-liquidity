import { addDays, spearman } from './backtest';
import { sha256Hex } from './model-version';
import type { EventBacktestInputs, EventSignal, ScheduledExecution } from './event-backtest';
import { buildFormalEventOutcomes } from './formal-event-outcomes';
import { isoTimestampMs } from './pit';
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
  modelVersion?: string | null;
  configHash?: string | null;
  codeCommitSha?: string | null;
  dataRunId?: string | null;
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
  modelDate?: string;
  decisionAt?: string;
  tradableAt?: string;
  entryDate?: string;
  exitDate?: string;
  modelVersion?: string | null;
  configHash?: string | null;
  codeCommitSha?: string | null;
  dataRunId?: string | null;
}

const REGISTERED_SCORING_FACTOR_KEYS = Object.freeze([
  'netliqTrend', 'impulse', 'credit', 'funding', 'rates', 'dollar', 'reserveAdequacy', 'curve',
] as const);
const FACTOR_KEYS = REGISTERED_SCORING_FACTOR_KEYS;

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
  intervalConvention: 'HALF_OPEN_RETURN_INTERVAL_ENTRY_EXCLUDED_EXIT_INCLUDED',
  entryRule: 'FIRST_ACTUAL_CLOSE_STRICTLY_AFTER_TRADABLE_AT_ELIGIBILITY',
  exitRule: 'FIRST_ACTUAL_CLOSE_ON_OR_AFTER_ENTRY_PLUS_91_CALENDAR_DAYS',
  tailRule: 'TRAIN_ONLY_Q10_LINEAR_TYPE7',
  diagnosticWeightRule: 'MAX_POSITIVE_TRAIN_SPEARMAN_NORMALIZED_ELSE_EQUAL',
  directionRule: 'SCORE_VS_50_ZERO_ABSTAINS',
  formalVerdictRule: 'PERSISTED_VERDICT_NEUTRAL_ABSTAINS',
  icRule: 'SPEARMAN_PERSISTED_SCORE_VS_FORWARD_RETURN',
  riskRule: 'EXISTING_TARGET_EXPOSURE_LTE_0_50',
  diagnosticFactorKeys: FACTOR_KEYS,
  minimumRateN: 5,
  minimumIcN: 3,
  minimumTailCalibrationN: 20,
  minimumTestTailEvents: 3,
});

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value != null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalize(child)]));
  }
  return value;
}

const REGISTERED_IDENTITY = Object.freeze({
  registeredAt: '2026-07-22T19:37:28Z',
  amendedAt: '2026-07-22T20:17:47Z',
  registrationCommit: '31d26408ec6a3e05ef6da9ce7a9277320dcbf8f9',
  originalRegistration: Object.freeze({
    registeredAt: '2026-07-22T19:37:28Z',
    registrationCommit: '75c93d526bf6073440335d3c90a7d5c0b90ea58b',
    status: 'INVALIDATED_BY_REVIEW' as const,
    reason: 'WEEKLY_PRE_DECISION_PRICE_SIGNAL_DATE_EMBARGO_AND_POST_HOC_TAIL_CALIBRATION',
  }),
  holdoutFrom: VALIDATION_PROTOCOL.holdoutFrom,
  modelVersion: 'champion-v1.0.0',
  configHash: '17ad1ca8854b0fbd8e56d6255b7ee2f4fe8a85ae1a95a328ade46ffdff02a0cf',
  scoringFactorKeys: REGISTERED_SCORING_FACTOR_KEYS,
  portfolioMethodology: 'DASHBOARD_EXPOSURE_TIERS_V1' as const,
  riskCallThresholdMaximum: 0.5,
  prospectiveTailStatus: 'UNAVAILABLE_AT_REGISTRATION' as const,
});
const REGISTRATION_CANONICAL = JSON.stringify(canonicalize({ protocol: VALIDATION_PROTOCOL, identity: REGISTERED_IDENTITY }));
const REGISTERED_PROTOCOL_DIGEST = '80092bd0142ae4faf8e62f00ec7ccb3e8b6c0d94bd1a9944110833ec372f8b28';
if (sha256Hex(REGISTRATION_CANONICAL) !== REGISTERED_PROTOCOL_DIGEST) {
  throw new Error('registered validation protocol literal mismatch; create an explicit amendment');
}
export const HOLDOUT_REGISTRATION = Object.freeze({
  protocol: VALIDATION_PROTOCOL.protocol,
  ...REGISTERED_IDENTITY,
  protocolDigest: REGISTERED_PROTOCOL_DIGEST,
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
      modelVersion: snaps[startIdx].modelVersion ?? null,
      configHash: snaps[startIdx].configHash ?? null,
      codeCommitSha: snaps[startIdx].codeCommitSha ?? null,
      dataRunId: snaps[startIdx].dataRunId ?? null,
    });
  }
  return pairs;
}

function formalProvenance(signal: EventSignal): 'GOVERNED' | 'LEGACY' | 'INVALID' {
  const legacy = signal.modelVersion === 'LEGACY_UNVERSIONED'
    && signal.configHash === 'LEGACY_UNVERSIONED' && signal.codeCommitSha === 'LEGACY_UNVERSIONED';
  if (legacy) return 'LEGACY';
  if (typeof signal.modelVersion !== 'string' || typeof signal.configHash !== 'string'
    || !/^[a-f0-9]{64}$/.test(signal.configHash)
    || typeof signal.codeCommitSha !== 'string'
    || !(signal.codeCommitSha === 'LOCAL_UNCONFIGURED' || /^[a-f0-9]{40}$/.test(signal.codeCommitSha))
    || typeof signal.dataRunId !== 'string' || signal.dataRunId.length === 0) return 'INVALID';
  return 'GOVERNED';
}

interface FormalExecutionCoverage {
  signalCount: number;
  executionCount: number;
  supersededCount: number;
  unexecutedCount: number;
}

function validateFormalSignal(signal: EventSignal, cutoffMs: number): void {
  const provenance = formalProvenance(signal);
  if (provenance === 'INVALID') throw new Error('formal validation requires complete signal provenance');
  if (provenance === 'GOVERNED' && (signal.modelVersion !== HOLDOUT_REGISTRATION.modelVersion
    || signal.configHash !== HOLDOUT_REGISTRATION.configHash)) throw new Error('formal validation model cohort mismatch');
  if (signal.validationIssue || signal.factors == null) throw new Error('formal validation requires valid persisted scoring factors');
  if (signal.policyIssue || (signal.verdict !== 'BULLISH' && signal.verdict !== 'BEARISH' && signal.verdict !== 'NEUTRAL')
    || signal.targetExposure == null) throw new Error('formal validation requires complete persisted policy fields');
  if (!signal.recordedAt || !signal.dataCutoff || !signal.createdAt) {
    throw new Error('formal validation requires complete signal clocks');
  }
  const decisionMs = isoTimestampMs(signal.decisionAt, 'formal decisionAt');
  const tradableMs = isoTimestampMs(signal.tradableAt, 'formal tradableAt');
  const recordedMs = isoTimestampMs(signal.recordedAt, 'formal recordedAt');
  const dataCutoffMs = isoTimestampMs(signal.dataCutoff, 'formal dataCutoff');
  const createdMs = isoTimestampMs(signal.createdAt, 'formal createdAt');
  if ([decisionMs, tradableMs, recordedMs, dataCutoffMs, createdMs].some(value => value >= cutoffMs)) {
    throw new Error('formal validation signal not visible at cutoff');
  }
  if (dataCutoffMs > decisionMs || decisionMs > tradableMs || recordedMs < decisionMs || createdMs < decisionMs) {
    throw new Error('formal validation signal clock ordering invalid');
  }
}

function prepareFormal(input: EventBacktestInputs): {
  pairs: ForwardPair[];
  executions: ScheduledExecution[];
  executionCoverage: FormalExecutionCoverage;
} {
  if (typeof input.asOfCutoff !== 'string') {
    throw new Error('formal validation requires an explicit as-of cutoff');
  }
  const cutoffMs = isoTimestampMs(input.asOfCutoff, 'formal as-of cutoff');
  if (input.signals.length === 0) throw new Error('formal validation has no official signal coverage');
  input.signals.forEach(signal => validateFormalSignal(signal, cutoffMs));
  if (input.signals.length > 0 && input.prices.length === 0) throw new Error('formal validation has no execution price coverage');
  for (const price of input.prices) {
    if (price.provenanceStatus !== 'PIT_RAW') throw new Error('formal validation requires PIT_RAW daily prices');
    if (!price.fetchedAt || !price.dataRunId || !price.activationRunId || !price.activatedAt) {
      throw new Error('formal validation requires complete daily price provenance');
    }
    const fetchedMs = isoTimestampMs(price.fetchedAt, 'formal price fetchedAt');
    const activatedMs = isoTimestampMs(price.activatedAt, 'formal price activatedAt');
    if (fetchedMs > activatedMs) throw new Error('formal validation price fetched after activation');
    if (activatedMs >= cutoffMs) throw new Error('formal validation price not visible at cutoff');
  }
  const formal = buildFormalEventOutcomes(input, [13], VALIDATION_PROTOCOL.outcomeToleranceDays);
  if (formal.executionCoverage.unexecutedCount > 0 || formal.executionCoverage.executionCount === 0) {
    throw new Error('formal validation has unexecuted signal coverage');
  }
  const pairs: ForwardPair[] = formal.outcomes.filter(outcome => outcome.status === 'OK').map((outcome, startIdx) => {
    const execution = formal.executions.find(row => row.signalDate === outcome.modelDate
      && row.executionDate === outcome.entryDate && row.decisionAt === outcome.decisionAt)!;
    return {
      startIdx, endIdx: input.prices.findIndex(price => price.date === outcome.exitDate),
      signalDate: outcome.entryDate!, outcomeDate: outcome.exitDate!,
      modelDate: outcome.modelDate, decisionAt: outcome.decisionAt, tradableAt: outcome.tradableAt,
      entryDate: outcome.entryDate!, exitDate: outcome.exitDate!,
      score: outcome.score, fwd: outcome.totalReturn!, verdict: outcome.verdict,
      targetExposure: outcome.targetExposure, factors: execution.factors ?? {}, pitStatus: 'PIT',
      provenanceStatus: formalProvenance(execution), modelVersion: outcome.modelVersion,
      configHash: outcome.configHash, codeCommitSha: outcome.codeCommitSha, dataRunId: outcome.dataRunId,
    };
  });
  return { pairs, executions: formal.executions, executionCoverage: formal.executionCoverage };
}

export function buildFormalForwardPairs(input: EventBacktestInputs): ForwardPair[] {
  return prepareFormal(input).pairs;
}

export function purgeTrainingPairs(pairs: ForwardPair[], testFrom: string, embargoDays: number = VALIDATION_PROTOCOL.embargoDays) {
  const embargoFrom = addDays(testFrom, -embargoDays);
  const kept: ForwardPair[] = [];
  let purgedOverlapN = 0;
  let embargoedN = 0;
  for (const pair of pairs) {
    if (pair.outcomeDate >= testFrom) { purgedOverlapN++; continue; }
    if (pair.outcomeDate >= embargoFrom) { embargoedN++; continue; }
    kept.push(pair);
  }
  return { pairs: kept, purgedOverlapN, embargoedN, embargoFrom };
}

export function greedyIndependentPairs(pairs: ForwardPair[]): ForwardPair[] {
  const sorted = [...pairs].sort((a, b) => a.outcomeDate.localeCompare(b.outcomeDate) || a.signalDate.localeCompare(b.signalDate));
  const result: ForwardPair[] = [];
  for (const pair of sorted) {
    if (result.length === 0 || pair.signalDate >= result[result.length - 1].outcomeDate) result.push(pair);
  }
  return result;
}

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
  const horizonWeeks = opts.horizonWeeks ?? VALIDATION_PROTOCOL.horizonWeeks;
  return buildPurgedFoldsFromPairs(buildForwardPairs(snaps, horizonWeeks), opts);
}

function buildPurgedFoldsFromPairs(
  allPairs: ForwardPair[],
  opts: { initialTrain?: number; testN?: number; embargoDays?: number } = {},
): PurgedFold[] {
  const initialTrain = opts.initialTrain ?? VALIDATION_PROTOCOL.initialTrain;
  const testN = opts.testN ?? VALIDATION_PROTOCOL.testN;
  const embargoDays = opts.embargoDays ?? VALIDATION_PROTOCOL.embargoDays;
  const folds: PurgedFold[] = [];
  for (let testStartIdx = initialTrain; testStartIdx < allPairs.length; testStartIdx += testN) {
    const testPairs = allPairs.slice(testStartIdx, testStartIdx + testN);
    if (testPairs.length === 0) continue;
    const testFrom = testPairs[0].signalDate;
    const testTo = testPairs.at(-1)!.signalDate;
    const candidates = allPairs.slice(0, testStartIdx);
    const purged = purgeTrainingPairs(candidates, testFrom, embargoDays);
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
      testLabelThrough: testPairs.reduce((latest, pair) => pair.outcomeDate > latest ? pair.outcomeDate : latest, testPairs[0].outcomeDate),
      trainLabelThrough: purged.pairs.length === 0 ? null
        : purged.pairs.reduce((latest, pair) => pair.outcomeDate > latest ? pair.outcomeDate : latest, purged.pairs[0].outcomeDate),
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

function provenanceSummary(rows: Array<Pick<ForwardPair, 'provenanceStatus'>>) {
  const governedCount = rows.filter(row => row.provenanceStatus === 'GOVERNED').length;
  const legacyCount = rows.filter(row => row.provenanceStatus === 'LEGACY').length;
  const invalidCount = rows.length - governedCount - legacyCount;
  return {
    totalCount: rows.length, governedCount, legacyCount, invalidCount,
    completeness: invalidCount > 0 ? 'INCOMPLETE' as const
      : legacyCount === 0 ? 'COMPLETE' as const : 'PARTIAL_LEGACY' as const,
  };
}

function validPitProvenance(rows: ForwardPair[]): boolean {
  return rows.every(row => row.pitStatus === 'PIT'
    && (row.provenanceStatus === 'GOVERNED' || row.provenanceStatus === 'LEGACY'));
}

function governedIdentityIssue(rows: Array<Pick<ForwardPair,
  'provenanceStatus' | 'modelVersion' | 'configHash' | 'codeCommitSha' | 'dataRunId'>>): string | null {
  const governed = rows.filter(row => row.provenanceStatus === 'GOVERNED');
  if (governed.some(row => row.modelVersion !== HOLDOUT_REGISTRATION.modelVersion
    || row.configHash !== HOLDOUT_REGISTRATION.configHash)) return 'MODEL_COHORT_MISMATCH';
  if (governed.some(row => typeof row.codeCommitSha !== 'string'
    || !(row.codeCommitSha === 'LOCAL_UNCONFIGURED' || /^[a-f0-9]{40}$/.test(row.codeCommitSha))
    || typeof row.dataRunId !== 'string' || row.dataRunId.length === 0)) return 'INCOMPLETE_GOVERNED_PROVENANCE';
  return null;
}

function cohortSummary(rows: ForwardPair[]) {
  const governed = rows.filter(row => row.provenanceStatus === 'GOVERNED');
  const models = [...new Set(governed.map(row => `${row.modelVersion}|${row.configHash}`))];
  const codeCommitShas = [...new Set(governed.map(row => row.codeCommitSha).filter((value): value is string => typeof value === 'string'))];
  const dataRunIds = [...new Set(governed.map(row => row.dataRunId).filter((value): value is string => typeof value === 'string'))];
  return { governedCount: governed.length, modelCohorts: models, codeCommitShas, dataRunCount: dataRunIds.length };
}

function runFrozenHoldoutPairs(pairs: ForwardPair[], prospective: ForwardPair[] = pairs) {
  const provenance = provenanceSummary(prospective);
  const postRegistration = prospective.filter(pair => pair.signalDate >= HOLDOUT_REGISTRATION.holdoutFrom);
  const issue = !validPitProvenance(prospective) ? 'INVALID_PIT_PROVENANCE' : governedIdentityIssue(prospective);
  const registration = HOLDOUT_REGISTRATION;
  const base = {
    registration, provenance, cohort: cohortSummary(prospective),
    tailStatus: 'UNAVAILABLE_AT_REGISTRATION' as const,
  };
  if (issue || postRegistration.some(pair => pair.provenanceStatus !== 'GOVERNED')) {
    return { ...base, status: 'DATA_INCOMPLETE' as const, reason: issue ?? 'POST_REGISTRATION_NOT_GOVERNED', overlappingN: 0, independentN: 0, metrics: null };
  }
  const matured = pairs.filter(pair => pair.signalDate >= HOLDOUT_REGISTRATION.holdoutFrom);
  if (matured.length < VALIDATION_PROTOCOL.minimumRateN) {
    return { ...base, status: 'PENDING_MATURITY' as const, reason: null, overlappingN: matured.length, independentN: greedyIndependentPairs(matured).length, metrics: null };
  }
  const metrics = evaluateValidationMetrics(matured, null, 0);
  metrics.tail.recall = { ...metrics.tail.recall, value: null, status: 'UNAVAILABLE_AT_REGISTRATION' };
  metrics.tail.precision = { ...metrics.tail.precision, value: null, status: 'UNAVAILABLE_AT_REGISTRATION' };
  return {
    ...base, status: 'OK' as const, reason: null,
    overlappingN: matured.length,
    independentN: greedyIndependentPairs(matured).length,
    metrics,
  };
}

export function runFrozenHoldout(snaps: ValidationSnap[]) {
  assertChronological(snaps);
  const pairs = buildForwardPairs(snaps);
  const prospective = snaps.map((snap, index): ForwardPair => ({
    startIdx: index, endIdx: index, signalDate: snap.date, outcomeDate: snap.date,
    score: snap.score, fwd: 0, verdict: snap.verdict ?? null, targetExposure: snap.targetExposure ?? null,
    factors: snap.factors, pitStatus: snap.pitStatus ?? null, provenanceStatus: snap.provenanceStatus ?? null,
    modelVersion: snap.modelVersion, configHash: snap.configHash, codeCommitSha: snap.codeCommitSha, dataRunId: snap.dataRunId,
  }));
  return runFrozenHoldoutPairs(pairs, prospective);
}

function runValidationPairs(pairs: ForwardPair[], prospective: ForwardPair[] = pairs) {
  const protocol = { ...VALIDATION_PROTOCOL, protocolDigest: HOLDOUT_REGISTRATION.protocolDigest };
  const provenance = provenanceSummary(prospective);
  const identityIssue = governedIdentityIssue(prospective);
  if (!validPitProvenance(prospective) || identityIssue) {
    return {
      status: 'DATA_INCOMPLETE' as const, reason: identityIssue ?? 'INVALID_PIT_PROVENANCE',
      protocol, provenance, cohort: cohortSummary(prospective), folds: [], aggregateMetrics: null,
      overlappingN: 0, independentN: 0, holdout: runFrozenHoldoutPairs(pairs, prospective),
    };
  }
  const folds = buildPurgedFoldsFromPairs(pairs);
  const testPairs = folds.flatMap(fold => fold.testPairs);
  const aggregateBase = testPairs.length > 0 ? evaluateValidationMetrics(testPairs, null, 0) : null;
  const totalTailEvents = folds.reduce((sum, fold) => sum + fold.metrics.tail.tailEvents, 0);
  const totalCaught = folds.reduce((sum, fold) => sum + fold.metrics.tail.caught, 0);
  const totalRiskCalls = folds.reduce((sum, fold) => sum + fold.metrics.tail.riskCalls, 0);
  const legacyCalibration = folds.some(fold => fold.tailCalibrationStatus === 'PARTIAL_LEGACY_CALIBRATION');
  const missingRiskSignal = prospective.some(pair => pair.targetExposure == null)
    || folds.some(fold => fold.metrics.tail.recall.status === 'MISSING_FORMAL_SIGNAL');
  const calibrationReady = folds.length > 0 && !legacyCalibration
    && folds.every(fold => fold.metrics.tail.calibrationN >= VALIDATION_PROTOCOL.minimumTailCalibrationN);
  const recallReady = calibrationReady && !missingRiskSignal && totalTailEvents >= VALIDATION_PROTOCOL.minimumTestTailEvents;
  const precisionReady = calibrationReady && !missingRiskSignal && totalRiskCalls >= VALIDATION_PROTOCOL.minimumTestTailEvents;
  const aggregateTail = aggregateBase == null ? null : {
    recall: {
      value: recallReady ? totalCaught / totalTailEvents : null,
      hits: totalCaught, n: totalTailEvents, abstentions: testPairs.length - totalTailEvents,
      minRequired: VALIDATION_PROTOCOL.minimumTestTailEvents,
      status: missingRiskSignal ? 'MISSING_FORMAL_SIGNAL' as const
        : legacyCalibration ? 'PARTIAL_LEGACY_CALIBRATION' as const : recallReady ? 'OK' as const : 'INSUFFICIENT_SAMPLE' as const,
    },
    precision: {
      value: precisionReady ? totalCaught / totalRiskCalls : null,
      hits: totalCaught, n: totalRiskCalls, abstentions: testPairs.length - totalRiskCalls,
      minRequired: VALIDATION_PROTOCOL.minimumTestTailEvents,
      status: missingRiskSignal ? 'MISSING_FORMAL_SIGNAL' as const
        : legacyCalibration ? 'PARTIAL_LEGACY_CALIBRATION' as const
        : precisionReady ? 'OK' as const : 'INSUFFICIENT_SAMPLE' as const,
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
    reason: null, protocol, provenance, cohort: cohortSummary(prospective),
    folds: folds.map(({ trainPairs: _trainPairs, testPairs, ...fold }) => ({
      ...fold,
      labels: testPairs.map(pair => ({
        modelDate: pair.modelDate ?? pair.signalDate, decisionAt: pair.decisionAt ?? null,
        tradableAt: pair.tradableAt ?? null, signalDate: pair.signalDate, entryDate: pair.entryDate ?? pair.signalDate,
        outcomeDate: pair.outcomeDate, exitDate: pair.exitDate ?? pair.outcomeDate,
      })),
    })),
    aggregateMetrics: aggregateBase == null || aggregateTail == null ? null : { ...aggregateBase, tail: aggregateTail },
    overlappingN: testPairs.length,
    independentN: greedyIndependentPairs(testPairs).length,
    holdout: runFrozenHoldoutPairs(pairs, prospective),
  };
}

export function runPurgedValidation(snaps: ValidationSnap[], overrides?: never) {
  if (arguments.length > 1 || overrides !== undefined) throw new Error('formal validation protocol overrides are not allowed');
  assertChronological(snaps);
  const pairs = buildForwardPairs(snaps);
  const prospective = snaps.map((snap, index): ForwardPair => ({
    startIdx: index, endIdx: index, signalDate: snap.date, outcomeDate: snap.date,
    score: snap.score, fwd: 0, verdict: snap.verdict ?? null, targetExposure: snap.targetExposure ?? null,
    factors: snap.factors, pitStatus: snap.pitStatus ?? null, provenanceStatus: snap.provenanceStatus ?? null,
    modelVersion: snap.modelVersion, configHash: snap.configHash, codeCommitSha: snap.codeCommitSha, dataRunId: snap.dataRunId,
  }));
  return runValidationPairs(pairs, prospective);
}

export function runFormalValidation(input: EventBacktestInputs) {
  try {
    const prepared = prepareFormal(input);
    const prospective = prepared.executions.map((execution, index): ForwardPair => ({
      startIdx: index, endIdx: index, signalDate: execution.executionDate, outcomeDate: execution.executionDate,
      modelDate: execution.signalDate, decisionAt: execution.decisionAt, tradableAt: execution.tradableAt,
      entryDate: execution.executionDate, score: execution.score, fwd: 0,
      verdict: execution.verdict === 'BULLISH' || execution.verdict === 'BEARISH' || execution.verdict === 'NEUTRAL'
        ? execution.verdict : null,
      targetExposure: execution.targetExposure ?? null, factors: execution.factors ?? {}, pitStatus: 'PIT',
      provenanceStatus: formalProvenance(execution), modelVersion: execution.modelVersion,
      configHash: execution.configHash, codeCommitSha: execution.codeCommitSha, dataRunId: execution.dataRunId,
    }));
    return { ...runValidationPairs(prepared.pairs, prospective), executionCoverage: prepared.executionCoverage };
  } catch (error) {
    const detail = String((error as Error).message);
    return formalValidationUnavailable(/model cohort mismatch/i.test(detail) ? 'MODEL_COHORT_MISMATCH' : 'INVALID_FORMAL_INPUT', detail);
  }
}

export function formalValidationUnavailable(reason: string, detail?: string) {
  const protocol = { ...VALIDATION_PROTOCOL, protocolDigest: HOLDOUT_REGISTRATION.protocolDigest };
  const provenance = { totalCount: 0, governedCount: 0, legacyCount: 0, invalidCount: 0, completeness: 'INCOMPLETE' as const };
  return {
    status: 'DATA_INCOMPLETE' as const, reason, ...(detail ? { detail } : {}),
    protocol, provenance, cohort: { governedCount: 0, modelCohorts: [] as string[], codeCommitShas: [] as string[], dataRunCount: 0 },
    folds: [], aggregateMetrics: null, overlappingN: 0, independentN: 0,
    holdout: {
      status: 'DATA_INCOMPLETE' as const, reason, registration: HOLDOUT_REGISTRATION,
      provenance, cohort: { governedCount: 0, modelCohorts: [] as string[], codeCommitShas: [] as string[], dataRunCount: 0 },
      tailStatus: 'UNAVAILABLE_AT_REGISTRATION' as const, overlappingN: 0, independentN: 0, metrics: null,
    },
  };
}
