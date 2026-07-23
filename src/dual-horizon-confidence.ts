// @ts-ignore -- isolated Node research module
import { buildContinuousChallenger, buildWeeklyNetLiquidity } from '../scripts/netliq-challenger.mjs';
import { SCORING_FACTOR_KEYS, SERIES, WEIGHTS } from './config';
import type { DualHorizonSnapshotInputs, LiquidityStructureSeriesInputs } from './db';
import { clamp, asOfFresh, scoreNetliqTrend } from './metrics';
import {
  isPortfolioDirection,
  isPortfolioVerdict,
  mapPortfolioPolicy,
  snapshotVixStressStatus,
} from './portfolio-policy';

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

export type DualHorizonShadowResult =
  | {
      status: 'OK';
      protocol: 'DUAL_HORIZON_CONFIDENCE_SHADOW_V1';
      asOf: string;
      snapshotDate: string;
      modelVersion: string;
      configHash: string;
      strategicScore: number;
      tacticalScore: number;
      formalFactors: Record<string, number>;
      tacticalFactors: Record<string, number>;
      confidence: number;
      confidenceComponents: {
        completeness: number;
        freshness: number;
        regimeSample: number;
        majorFactorAgreement: number;
        rawSmoothAgreement: number;
      };
      baseExposure: number;
      shadowAdjustment: number;
      shadowTargetExposure: number;
      rawSmooth: {
        agreement: RawSmoothAgreement;
        rawLatent: number;
        smoothLatent: number;
        observationDate: string;
        availableDate: string;
        sampleCount: number;
      };
      reasons: string[];
      championChanged: false;
    }
  | {
      status: 'DATA_INCOMPLETE';
      protocol: 'DUAL_HORIZON_CONFIDENCE_SHADOW_V1';
      asOf: string;
      reasons: DualHorizonIncompleteReason[];
      availableDiagnostics: Record<string, unknown>;
      championChanged: false;
    };

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

function statusesFromPersistedFactorResults(
  factorResults: Record<string, unknown>,
): Record<string, DualFactorStatus | undefined> {
  return Object.fromEntries(SCORING_FACTOR_KEYS.map(key => {
    const result = factorResults[key];
    const status = result != null && typeof result === 'object' && !Array.isArray(result)
      ? (result as Record<string, unknown>).status
      : undefined;
    return [key, isDualFactorStatus(status) ? status : undefined];
  }));
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

function researchRawUnits(
  seriesMap: Record<string, Array<{ date: string; value: number }>>,
) {
  return {
    WALCL: (seriesMap.WALCL ?? []).map(row => ({ ...row, value: row.value * 1_000 })),
    WDTGAL: (seriesMap.WDTGAL ?? []).map(row => ({ ...row, value: row.value * 1_000 })),
    WTREGEN: (seriesMap.WTREGEN ?? []).map(row => ({ ...row, value: row.value * 1_000 })),
    RRPONTSYD: (seriesMap.RRPONTSYD ?? []).map(row => ({ ...row })),
  };
}

export function rawSmoothAtDecision(
  seriesMap: Record<string, Array<{ date: string; value: number }>>,
  decisionDate: string,
) {
  const points = buildWeeklyNetLiquidity(researchRawUnits(seriesMap))
    .filter((point: { availableDate: string }) => point.availableDate <= decisionDate);
  const latest = buildContinuousChallenger(points).at(-1);
  if (!latest || !Number.isFinite(latest.raw.latent) || !Number.isFinite(latest.smooth.latent)) {
    return {
      status: 'DATA_INCOMPLETE' as const,
      reason: 'MISSING_RAW_SMOOTH_HISTORY' as const,
    };
  }
  return {
    status: 'OK' as const,
    agreement: latest.agreement.confidence as RawSmoothAgreement,
    rawLatent: latest.raw.latent as number,
    smoothLatent: latest.smooth.latent as number,
    observationDate: latest.observationDate as string,
    availableDate: latest.availableDate as string,
    sampleCount: points.length,
  };
}

function incomplete(
  asOf: string,
  reason: DualHorizonIncompleteReason,
  availableDiagnostics: Record<string, unknown> = {},
): DualHorizonShadowResult {
  return {
    status: 'DATA_INCOMPLETE',
    protocol: DUAL_HORIZON_PROTOCOL.protocol,
    asOf,
    reasons: [reason],
    availableDiagnostics,
    championChanged: false,
  };
}

function tacticalReason(score: number) {
  return score >= 60 ? 'TACTICAL_UP' : score <= 40 ? 'TACTICAL_DOWN' : 'TACTICAL_NEUTRAL';
}

function dayGap(fromDate: string, toDate: string) {
  return (Date.parse(`${toDate}T00:00:00Z`) - Date.parse(`${fromDate}T00:00:00Z`))
    / 86_400_000;
}

function tacticalRawLevels(
  seriesMap: Record<string, Array<{ date: string; value: number }>>,
  decisionDate: string,
) {
  const anchors = (seriesMap.WALCL ?? []).filter(row => row.date <= decisionDate).slice(-5);
  if (anchors.length !== 5) return null;
  const points = anchors.map(walcl => {
    const tga = asOfFresh(seriesMap.WDTGAL ?? [], walcl.date, SERIES.WDTGAL);
    const rrp = asOfFresh(seriesMap.RRPONTSYD ?? [], walcl.date, SERIES.RRPONTSYD);
    return tga.value != null && rrp.value != null
      ? { date: walcl.date, value: walcl.value - tga.value - rrp.value }
      : null;
  }).filter((row): row is { date: string; value: number } => row != null);
  if (points.length !== anchors.length) return null;
  const invalidCadence = points.slice(1).some((point, index) => {
    const gap = dayGap(points[index].date, point.date);
    return gap < 5 || gap > 10;
  });
  return invalidCadence ? null : points;
}

export function buildDualHorizonShadow(
  snapshotsInput: DualHorizonSnapshotInputs,
  liquidityInput: LiquidityStructureSeriesInputs,
): DualHorizonShadowResult {
  if (snapshotsInput.asOfCutoff !== liquidityInput.asOfCutoff) {
    return incomplete(snapshotsInput.asOfCutoff, 'AS_OF_CUTOFF_MISMATCH');
  }
  if (snapshotsInput.snapshots.length === 0) {
    return incomplete(snapshotsInput.asOfCutoff, 'NO_GOVERNED_FORMAL_SNAPSHOT');
  }
  if (snapshotsInput.snapshots.length > 600) {
    return incomplete(snapshotsInput.asOfCutoff, 'SNAPSHOT_WORK_LIMIT_EXCEEDED');
  }
  const selected = snapshotsInput.snapshots.at(-1)!;
  if (!isPortfolioVerdict(selected.verdict) || !isPortfolioDirection(selected.netliqDir)) {
    return incomplete(snapshotsInput.asOfCutoff, 'FORMAL_SNAPSHOT_INVALID');
  }

  const rawSmooth = rawSmoothAtDecision(liquidityInput.seriesMap, liquidityInput.decisionDate);
  if (rawSmooth.status !== 'OK') {
    return incomplete(snapshotsInput.asOfCutoff, rawSmooth.reason);
  }
  const recent = tacticalRawLevels(liquidityInput.seriesMap, liquidityInput.decisionDate);
  if (!recent) {
    return incomplete(snapshotsInput.asOfCutoff, 'MISSING_TACTICAL_HISTORY');
  }

  const tactical = scoreFourWeekTacticalCohort(
    selected.factors as Record<string, number | undefined>,
    recent.map(point => point.value),
  );
  if (tactical.status !== 'OK') {
    return incomplete(snapshotsInput.asOfCutoff, tactical.reason);
  }
  const factorStatuses = statusesFromPersistedFactorResults(selected.factorResults);
  const sameRegimeSampleCount = snapshotsInput.snapshots.slice(0, -1).filter(row =>
    row.qeQtRegime === selected.qeQtRegime
    && row.modelVersion === selected.modelVersion
    && row.configHash === selected.configHash).length;
  const confidence = computeDualHorizonConfidence({
    factorStatuses,
    tacticalFactors: tactical.factors,
    sameRegimeSampleCount,
    rawSmooth: rawSmooth.agreement,
  });
  if (confidence.status !== 'OK') {
    return incomplete(snapshotsInput.asOfCutoff, confidence.reason);
  }

  const formalPolicy = mapPortfolioPolicy({
    score: selected.score,
    verdict: selected.verdict,
    netliqDir: selected.netliqDir,
    stressStatus: snapshotVixStressStatus(selected.snapshotVixEod),
  });
  const shadow = mapShadowExposure(
    formalPolicy.targetExposure,
    tactical.score,
    confidence.confidence,
  );
  const reasons = [tacticalReason(tactical.score)];
  if (shadow.unguardedAdjustment > 0 && shadow.shadowAdjustment === 0) {
    reasons.push('UPWARD_ADJUSTMENT_BLOCKED_LOW_CONFIDENCE');
  }
  if (confidence.confidence < 40) reasons.push('LOW_CONFIDENCE_EXPOSURE_CAP');
  reasons.push(`RAW_SMOOTH_${rawSmooth.agreement}`);
  return {
    status: 'OK',
    protocol: DUAL_HORIZON_PROTOCOL.protocol,
    asOf: snapshotsInput.asOfCutoff,
    snapshotDate: selected.date,
    modelVersion: selected.modelVersion,
    configHash: selected.configHash,
    strategicScore: selected.score,
    tacticalScore: tactical.score,
    formalFactors: selected.factors as Record<string, number>,
    tacticalFactors: tactical.factors,
    confidence: confidence.confidence,
    confidenceComponents: confidence.components,
    baseExposure: formalPolicy.targetExposure,
    shadowAdjustment: shadow.shadowAdjustment,
    shadowTargetExposure: shadow.shadowTargetExposure,
    rawSmooth,
    reasons,
    championChanged: false,
  };
}
