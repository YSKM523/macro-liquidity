import { SCORING_FACTOR_KEYS, WEIGHTS } from './config';
import type { Impulse, SeriesMap } from './metrics';
import { sha256Hex } from './model-version';
import protocolArtifact from '../docs/research/LIQUIDITY_STRUCTURE_CHALLENGER_PROTOCOL.json';

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value != null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalize(child)]));
  }
  return value;
}

export function canonicalLiquidityStructureProtocol(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

const CANONICAL_DIGEST = 'b9560fe595969a7f6f8420d48cdaf8f2cfd3ad45f616974469d59115ea234c38';
if (sha256Hex(canonicalLiquidityStructureProtocol(protocolArtifact)) !== CANONICAL_DIGEST) {
  throw new Error('liquidity-structure protocol mismatch; create an explicit amendment');
}

export const LIQUIDITY_STRUCTURE_PROTOCOL = Object.freeze({
  protocol: 'LIQUIDITY_STRUCTURE_CHALLENGER_V1' as const,
  registeredAt: '2026-07-23T00:50:00Z',
  baseCommit: '52d1276426987537ad09c4e1ba1fa1c80d86c468',
  mode: 'SHADOW_ONLY' as const,
  championChange: false,
  artifactSha256: '946b95679e2bbacb618251969ebb7967d8a82541d277c72297b6b0a5023cbfa0',
  canonicalDigest: CANONICAL_DIGEST,
  factorKeys: Object.freeze([...SCORING_FACTOR_KEYS]),
});

const DAY_MS = 86_400_000;

function dayNumber(date: string): number {
  const value = Date.parse(`${date}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(value)
    || new Date(value).toISOString().slice(0, 10) !== date) throw new Error(`invalid challenger date: ${date}`);
  return value / DAY_MS;
}

function sortedRows(rows: Array<{ date: string; value: number }>, asOfDate: string) {
  const filtered = rows.filter(row => row.date <= asOfDate)
    .sort((left, right) => left.date.localeCompare(right.date));
  let priorDate: string | null = null;
  for (const row of filtered) {
    dayNumber(row.date);
    if (!Number.isFinite(row.value)) throw new Error('invalid challenger observation value');
    if (row.date === priorDate) throw new Error(`duplicate challenger observation date: ${row.date}`);
    priorDate = row.date;
  }
  return filtered;
}

function type7(values: number[], probability: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  const position = (sorted.length - 1) * probability;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

export type TgaBufferStatus = 'OK' | 'INSUFFICIENT_TGA_HISTORY' | 'INVALID_TGA_CADENCE'
  | 'INSUFFICIENT_RRP_HISTORY' | 'MISSING_RRP_ALIGNMENT';
export type RrpBufferState = 'DEPLETED' | 'LOW' | 'SUFFICIENT';

export interface TgaBufferResult {
  status: TgaBufferStatus;
  tgaShock: number | null;
  priorRrp: number | null;
  q20: number | null;
  q50: number | null;
  bufferState: RrpBufferState | null;
  bufferMultiplier: number | null;
  effectiveTgaShock: number | null;
  thresholdSampleN: number;
}

function unavailableTga(status: Exclude<TgaBufferStatus, 'OK'>, tgaShock: number | null = null): TgaBufferResult {
  return {
    status, tgaShock, priorRrp: null, q20: null, q50: null, bufferState: null,
    bufferMultiplier: null, effectiveTgaShock: null, thresholdSampleN: 0,
  };
}

export function evaluateTgaBuffer(seriesMap: SeriesMap, asOfDate: string): TgaBufferResult {
  dayNumber(asOfDate);
  const tga = sortedRows(seriesMap.WDTGAL ?? [], asOfDate);
  if (tga.length < 2) return unavailableTga('INSUFFICIENT_TGA_HISTORY');
  const latest = tga.at(-1)!;
  const prior = tga.at(-2)!;
  const currentGap = dayNumber(latest.date) - dayNumber(prior.date);
  if (currentGap < 5 || currentGap > 10) return unavailableTga('INVALID_TGA_CADENCE');
  const tgaShock = latest.value - prior.value;
  const priorTga = tga.slice(0, -1).slice(-157);
  for (let index = 1; index < priorTga.length; index++) {
    const gap = dayNumber(priorTga[index].date) - dayNumber(priorTga[index - 1].date);
    if (gap < 5 || gap > 10) return unavailableTga('INVALID_TGA_CADENCE', tgaShock);
  }
  const rrp = sortedRows(seriesMap.RRPONTSYD ?? [], asOfDate);
  if (rrp.length === 0) return unavailableTga('MISSING_RRP_ALIGNMENT', tgaShock);
  let cursor = 0;
  let last: number | null = null;
  const aligned: number[] = [];
  for (const anchor of priorTga) {
    while (cursor < rrp.length && rrp[cursor].date <= anchor.date) {
      last = rrp[cursor].value;
      cursor++;
    }
    if (last == null) return unavailableTga('MISSING_RRP_ALIGNMENT', tgaShock);
    aligned.push(last);
  }
  if (aligned.length < 2) return unavailableTga('INSUFFICIENT_RRP_HISTORY', tgaShock);
  const priorRrp = aligned.at(-1)!;
  const thresholdHistory = aligned.slice(0, -1).slice(-156);
  if (thresholdHistory.length < 52) return unavailableTga('INSUFFICIENT_RRP_HISTORY', tgaShock);
  const q20 = type7(thresholdHistory, .2);
  const q50 = type7(thresholdHistory, .5);
  const bufferState: RrpBufferState = priorRrp <= q20 ? 'DEPLETED' : priorRrp <= q50 ? 'LOW' : 'SUFFICIENT';
  const bufferMultiplier = bufferState === 'DEPLETED' ? 1 : bufferState === 'LOW' ? .6 : .25;
  return {
    status: 'OK', tgaShock, priorRrp, q20, q50, bufferState, bufferMultiplier,
    effectiveTgaShock: tgaShock * bufferMultiplier, thresholdSampleN: thresholdHistory.length,
  };
}

export type PolicyRegime = 'QE' | 'QT' | 'RESERVE_MANAGEMENT' | 'REINVESTMENT_ONLY'
  | 'CRISIS_LIQUIDITY' | 'NEUTRAL' | 'UNKNOWN';

const POLICY_MATRIX: Record<Exclude<PolicyRegime, 'CRISIS_LIQUIDITY' | 'UNKNOWN'>, Record<Impulse, number>> = {
  QE: { EXPANDING: 80, FLAT: 60, CONTRACTING: 40 },
  QT: { EXPANDING: 50, FLAT: 40, CONTRACTING: 30 },
  RESERVE_MANAGEMENT: { EXPANDING: 57.5, FLAT: 52.5, CONTRACTING: 42.5 },
  REINVESTMENT_ONLY: { EXPANDING: 52.5, FLAT: 50, CONTRACTING: 45 },
  NEUTRAL: { EXPANDING: 55, FLAT: 50, CONTRACTING: 45 },
};

export function scorePolicyAwareWalcl(regime: PolicyRegime, impulse: Impulse) {
  if (regime === 'CRISIS_LIQUIDITY') return { status: 'CRISIS_POLICY_SEPARATE' as const, score: null };
  if (regime === 'UNKNOWN') return { status: 'POLICY_UNAVAILABLE' as const, score: null };
  return { status: 'OK' as const, score: POLICY_MATRIX[regime][impulse] };
}

type FactorInput = Partial<Record<string, number | undefined>>;

function completeFactors(input: FactorInput): Record<string, number> | null {
  const output: Record<string, number> = {};
  for (const key of SCORING_FACTOR_KEYS) {
    const value = input[key];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100) return null;
    output[key] = value;
  }
  return output;
}

function weightedScore(factors: Record<string, number>, removed: ReadonlySet<string> = new Set()): number {
  let numerator = 0;
  let denominator = 0;
  for (const key of SCORING_FACTOR_KEYS) {
    if (removed.has(key)) continue;
    const weight = WEIGHTS[key as keyof typeof WEIGHTS];
    numerator += factors[key] * weight;
    denominator += weight;
  }
  return numerator / denominator;
}

export function buildEightFactorBenchmarks(input: FactorInput) {
  const factors = completeFactors(input);
  if (!factors) return {
    status: 'INCOMPLETE_FACTOR_COHORT' as const, factorCount: 8,
    equal8: null, current8: null, blend8: null,
  };
  const equal8 = SCORING_FACTOR_KEYS.reduce((sum, key) => sum + factors[key], 0) / SCORING_FACTOR_KEYS.length;
  const current8 = weightedScore(factors);
  return { status: 'OK' as const, factorCount: 8, equal8, current8, blend8: (equal8 + current8) / 2 };
}

export function buildFundingCreditAblations(input: FactorInput) {
  const factors = completeFactors(input);
  if (!factors) return { status: 'INCOMPLETE_FACTOR_COHORT' as const, arms: null, fragilitySidecar: null };
  const arm = (removed: string[]) => ({ score: weightedScore(factors, new Set(removed)), removedFactors: removed });
  return {
    status: 'OK' as const,
    arms: {
      A_CURRENT_8: arm([]),
      B_WITHOUT_CREDIT: arm(['credit']),
      C_WITHOUT_FUNDING: arm(['funding']),
      D_WITHOUT_CREDIT_FUNDING: arm(['credit', 'funding']),
    },
    fragilitySidecar: { credit: factors.credit, funding: factors.funding },
  };
}
