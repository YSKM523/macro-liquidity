import { SCORING_FACTOR_KEYS, WEIGHTS } from './config';
import { clamp, scoreNetliqTrend } from './metrics';

export const DUAL_HORIZON_PROTOCOL = Object.freeze({
  protocol: 'DUAL_HORIZON_CONFIDENCE_SHADOW_V1' as const,
  mode: 'SHADOW_ONLY' as const,
  championChanged: false as const,
  strategicWeeks: 13,
  tacticalWeeks: 4,
  tacticalUpper: 60,
  tacticalLower: 40,
  confidenceUpwardMinimum: 60,
  confidenceExposureCapThreshold: 40,
  lowConfidenceExposureCap: 0.75,
  regimeSampleCap: 52,
  confidenceWeight: 0.20,
});

export type DualFactorStatus = 'OK' | 'PARTIAL' | 'STALE' | 'MISSING';
export type RawSmoothAgreement = 'HIGH' | 'LOW' | 'TRANSITION';
export type DualHorizonIncompleteReason =
  | 'AS_OF_CUTOFF_MISMATCH'
  | 'NO_GOVERNED_FORMAL_SNAPSHOT'
  | 'SNAPSHOT_WORK_LIMIT_EXCEEDED'
  | 'FORMAL_SNAPSHOT_INVALID'
  | 'MISSING_FORMAL_FACTOR_COHORT'
  | 'MISSING_TACTICAL_HISTORY'
  | 'MISSING_RAW_SMOOTH_HISTORY'
  | 'CONFIDENCE_INPUT_INCOMPLETE';

function completeFactors(input: Record<string, number | undefined>) {
  const output: Record<string, number> = {};
  for (const key of SCORING_FACTOR_KEYS) {
    const value = input[key];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100) return null;
    output[key] = value;
  }
  return output;
}

export function scoreTacticalCohort(
  formalFactors: Record<string, number | undefined>,
  tacticalNetliqTrend: number,
) {
  const factors = completeFactors({ ...formalFactors, netliqTrend: tacticalNetliqTrend });
  if (!factors) {
    return { status: 'DATA_INCOMPLETE' as const, reason: 'MISSING_FORMAL_FACTOR_COHORT' as const };
  }
  const score = SCORING_FACTOR_KEYS.reduce(
    (sum, key) => sum + factors[key] * WEIGHTS[key as keyof typeof WEIGHTS],
    0,
  );
  return { status: 'OK' as const, score: clamp(score), factors };
}

export function scoreFourWeekTacticalCohort(
  formalFactors: Record<string, number | undefined>,
  rawLevels: number[],
) {
  if (rawLevels.length < 5 || rawLevels.some(value => !Number.isFinite(value))) {
    return { status: 'DATA_INCOMPLETE' as const, reason: 'MISSING_TACTICAL_HISTORY' as const };
  }
  return scoreTacticalCohort(formalFactors, scoreNetliqTrend(rawLevels, 4 as never));
}

const FRESHNESS_SCORE: Record<DualFactorStatus, number> = {
  OK: 100, PARTIAL: 50, STALE: 0, MISSING: 0,
};
const MAJOR_FACTORS = ['netliqTrend', 'dollar', 'reserveAdequacy', 'curve'] as const;

function isDualFactorStatus(value: unknown): value is DualFactorStatus {
  return value === 'OK' || value === 'PARTIAL' || value === 'STALE' || value === 'MISSING';
}

function isRawSmoothAgreement(value: unknown): value is RawSmoothAgreement {
  return value === 'HIGH' || value === 'LOW' || value === 'TRANSITION';
}

export function computeDualHorizonConfidence(input: {
  factorStatuses: Record<string, DualFactorStatus | undefined>;
  tacticalFactors: Record<string, number | undefined>;
  sameRegimeSampleCount: number;
  rawSmooth: RawSmoothAgreement | null;
}) {
  const factors = completeFactors(input.tacticalFactors);
  const statuses = SCORING_FACTOR_KEYS.map(key => input.factorStatuses[key]);
  if (!factors || statuses.some(status => !isDualFactorStatus(status)) || !isRawSmoothAgreement(input.rawSmooth)
    || !Number.isSafeInteger(input.sameRegimeSampleCount) || input.sameRegimeSampleCount < 0) {
    return { status: 'DATA_INCOMPLETE' as const, reason: 'CONFIDENCE_INPUT_INCOMPLETE' as const };
  }
  const completeness = 100;
  const freshness = statuses.reduce((sum, status) => sum + FRESHNESS_SCORE[status!], 0)
    / SCORING_FACTOR_KEYS.length;
  const regimeSample = Math.min(100, input.sameRegimeSampleCount / 52 * 100);
  const directions = MAJOR_FACTORS.map(key => factors[key] > 55 ? 'UP' : factors[key] < 45 ? 'DOWN' : 'NEUTRAL');
  const up = directions.filter(value => value === 'UP').length;
  const down = directions.filter(value => value === 'DOWN').length;
  const neutral = directions.length - up - down;
  const majorFactorAgreement = 100 * Math.max(up + 0.5 * neutral, down + 0.5 * neutral) / 4;
  const rawSmoothAgreement = input.rawSmooth === 'HIGH' ? 100 : input.rawSmooth === 'LOW' ? 0 : 50;
  const components = { completeness, freshness, regimeSample, majorFactorAgreement, rawSmoothAgreement };
  const confidence = Object.values(components).reduce((sum, value) => sum + value, 0) / 5;
  return { status: 'OK' as const, confidence, components };
}

export function mapShadowExposure(baseExposure: number, tacticalScore: number, confidence: number) {
  if (![baseExposure, tacticalScore, confidence].every(Number.isFinite)) {
    throw new Error('invalid dual-horizon exposure input');
  }
  const unguardedAdjustment = tacticalScore >= 60 ? 0.10 : tacticalScore <= 40 ? -0.10 : 0;
  const shadowAdjustment = confidence < 60 && unguardedAdjustment > 0 ? 0 : unguardedAdjustment;
  let shadowTargetExposure = Math.max(0.25, Math.min(1, baseExposure + shadowAdjustment));
  if (confidence < 40) shadowTargetExposure = Math.min(0.75, shadowTargetExposure);
  return { unguardedAdjustment, shadowAdjustment, shadowTargetExposure };
}
