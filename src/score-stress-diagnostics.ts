import type { EventBacktestInputs } from './event-backtest';
import { buildFormalEventOutcomes } from './formal-event-outcomes';
import type { FormalEventOutcome } from './formal-event-outcomes';

export const SCORE_STRESS_PROTOCOL = Object.freeze({
  protocol: 'SCORE_STRESS_DIAGNOSTICS_V1' as const,
  registeredAt: '2026-07-22T20:36:03Z',
  registrationCommit: 'd7aba3c2b5bd79cfaf7847cdc82770abb499fdcd',
  protocolDigest: '891f77f991ca40521639dee3ab50418999e4c3d9296e7bd675f693ee3801efa2',
  horizonsWeeks: Object.freeze([4, 8, 13] as const),
  outcomeToleranceDays: 14,
  alpha: .05,
  independentRule: 'GREEDY_INTERVAL_NON_OVERLAP' as const,
  quantileRule: 'TYPE7_LINEAR' as const,
  events: Object.freeze([
    { id: '2018_Q4', from: '2018-10-01', to: '2019-01-01' },
    { id: '2019_REPO_STRESS', from: '2019-09-16', to: '2019-11-01' },
    { id: '2020_COVID', from: '2020-02-19', to: '2020-05-01' },
    { id: '2021_TGA_RRP', from: '2021-02-01', to: '2022-01-01' },
    { id: '2022_HIKING_QT', from: '2022-03-16', to: '2023-01-01' },
    { id: '2023_REGIONAL_BANKS', from: '2023-03-08', to: '2023-05-02' },
    { id: '2024_YEN_CARRY', from: '2024-07-01', to: '2024-09-01' },
    { id: '2025_2026_RESERVE_MGMT', from: '2025-01-01', to: '2027-01-01' },
  ]),
});

const BUCKETS = Object.freeze([
  { bucketId: '0_20', from: 0, to: 20, final: false },
  { bucketId: '20_35', from: 20, to: 35, final: false },
  { bucketId: '35_45', from: 35, to: 45, final: false },
  { bucketId: '45_55', from: 45, to: 55, final: false },
  { bucketId: '55_65', from: 55, to: 65, final: false },
  { bucketId: '65_80', from: 65, to: 80, final: false },
  { bucketId: '80_100', from: 80, to: 100, final: true },
]);

export function buildFormalOutcomes(input: EventBacktestInputs): FormalEventOutcome[] {
  return buildFormalEventOutcomes(input).outcomes;
}

function quantile(values: number[], probability: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  const position = (sorted.length - 1) * probability;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

function independentCount(rows: FormalEventOutcome[]): number {
  const sorted = [...rows].sort((left, right) => left.exitDate!.localeCompare(right.exitDate!)
    || left.entryDate!.localeCompare(right.entryDate!));
  let count = 0;
  let priorExit: string | null = null;
  for (const row of sorted) {
    if (priorExit == null || row.entryDate! >= priorExit) {
      count++;
      priorExit = row.exitDate;
    }
  }
  return count;
}

export function buildScoreBuckets(outcomes: FormalEventOutcome[]) {
  for (const outcome of outcomes) {
    if (!Number.isFinite(outcome.score) || outcome.score < 0 || outcome.score > 100) {
      throw new Error('invalid persisted score for diagnostics');
    }
  }
  return SCORE_STRESS_PROTOCOL.horizonsWeeks.flatMap(horizonWeeks => BUCKETS.map(bucket => {
    const rows = outcomes.filter(row => row.status === 'OK' && row.horizonWeeks === horizonWeeks
      && row.score >= bucket.from && (bucket.final ? row.score <= bucket.to : row.score < bucket.to));
    if (rows.length === 0) return {
      bucketId: bucket.bucketId, from: bucket.from, to: bucket.to, horizonWeeks,
      n: 0, independentN: 0, mean: null, median: null, negativeProbability: null, q10: null,
      worstEpisodeDrawdown: null, status: 'NO_OBSERVATIONS' as const,
      probabilityStatus: 'NO_OBSERVATIONS' as const, q10Status: 'NO_OBSERVATIONS' as const,
    };
    const values = rows.map(row => row.totalReturn!);
    const enough = rows.length >= 5;
    return {
      bucketId: bucket.bucketId, from: bucket.from, to: bucket.to, horizonWeeks,
      n: rows.length, independentN: independentCount(rows),
      mean: values.reduce((sum, value) => sum + value, 0) / values.length,
      median: quantile(values, .5),
      negativeProbability: enough ? values.filter(value => value < 0).length / values.length : null,
      q10: enough ? quantile(values, .1) : null,
      worstEpisodeDrawdown: Math.min(...rows.map(row => row.worstDrawdown!)),
      status: 'OK' as const,
      probabilityStatus: enough ? 'OK' as const : 'INSUFFICIENT_SAMPLE' as const,
      q10Status: enough ? 'OK' as const : 'INSUFFICIENT_SAMPLE' as const,
    };
  }));
}

export interface BhInput { hypothesisId: string; family: string; pValue: number | null }

export function benjaminiHochberg(entries: BhInput[]) {
  const ids = new Set<string>();
  for (const entry of entries) {
    if (ids.has(entry.hypothesisId)) throw new Error(`duplicate hypothesis id: ${entry.hypothesisId}`);
    ids.add(entry.hypothesisId);
    if (entry.pValue != null && (!Number.isFinite(entry.pValue) || entry.pValue < 0 || entry.pValue > 1)) {
      throw new Error(`invalid p-value: ${entry.hypothesisId}`);
    }
  }
  const families = [...new Set(entries.map(entry => entry.family))].sort();
  return families.flatMap(family => {
    const sorted = entries.filter(entry => entry.family === family)
      .map(entry => ({ ...entry, effectiveP: entry.pValue ?? 1 }))
      .sort((left, right) => left.effectiveP - right.effectiveP || left.hypothesisId.localeCompare(right.hypothesisId));
    const adjusted = new Array(sorted.length);
    let next = 1;
    for (let index = sorted.length - 1; index >= 0; index--) {
      next = Math.min(next, sorted[index].effectiveP * sorted.length / (index + 1));
      adjusted[index] = Math.min(1, next);
    }
    return sorted.map((entry, index) => ({
      hypothesisId: entry.hypothesisId, family, pValue: entry.pValue,
      effectiveP: entry.effectiveP, rank: index + 1, familySize: sorted.length,
      adjustedP: adjusted[index], rejected: adjusted[index] <= SCORE_STRESS_PROTOCOL.alpha,
    }));
  });
}

function inverseNormal(probability: number): number {
  // Acklam's rational approximation; sufficient for deterministic audit output.
  const a = [-39.6968302866538, 220.946098424521, -275.928510446969, 138.357751867269, -30.6647980661472, 2.50662827745924];
  const b = [-54.4760987982241, 161.585836858041, -155.698979859887, 66.8013118877197, -13.2806815528857];
  const c = [-.00778489400243029, -.322396458041136, -2.40075827716184, -2.54973253934373, 4.37466414146497, 2.93816398269878];
  const d = [.00778469570904146, .32246712907004, 2.445134137143, 3.75440866190742];
  if (!(probability > 0 && probability < 1)) throw new Error('normal probability must be inside (0,1)');
  if (probability < .02425) {
    const q = Math.sqrt(-2 * Math.log(probability));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5])
      / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (probability > 1 - .02425) return -inverseNormal(1 - probability);
  const q = probability - .5;
  const r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q
    / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

function normalCdf(value: number): number {
  const sign = value < 0 ? -1 : 1;
  const x = Math.abs(value) / Math.sqrt(2);
  const t = 1 / (1 + .3275911 * x);
  const erf = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - .284496736) * t + .254829592) * t * Math.exp(-x * x);
  return .5 * (1 + sign * erf);
}

export function deflatedSharpeRatio(input: {
  observedSharpe: number;
  trialSharpes: Array<number | null>;
  sampleT: number;
  skewness: number;
  kurtosis: number;
}) {
  const trialCount = input.trialSharpes.length;
  if (trialCount < 2 || input.trialSharpes.some(value => value == null || !Number.isFinite(value))) {
    return { status: 'TRIAL_UNIVERSE_INCOMPLETE' as const, value: null, expectedMaximumSharpe: null, trialCount };
  }
  if (!Number.isInteger(input.sampleT) || input.sampleT < 2 || !Number.isFinite(input.observedSharpe)
    || !Number.isFinite(input.skewness) || !Number.isFinite(input.kurtosis)) throw new Error('invalid DSR inputs');
  const sharpes = input.trialSharpes as number[];
  const mean = sharpes.reduce((sum, value) => sum + value, 0) / trialCount;
  const variance = sharpes.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (trialCount - 1);
  const gamma = .5772156649015329;
  const expectedMaximumSharpe = Math.sqrt(variance) * (
    (1 - gamma) * inverseNormal(1 - 1 / trialCount)
    + gamma * inverseNormal(1 - 1 / (trialCount * Math.E))
  );
  const denominatorSquared = 1 - input.skewness * input.observedSharpe
    + ((input.kurtosis - 1) / 4) * input.observedSharpe ** 2;
  if (!(denominatorSquared > 0)) throw new Error('invalid DSR denominator');
  const statistic = (input.observedSharpe - expectedMaximumSharpe) * Math.sqrt(input.sampleT - 1)
    / Math.sqrt(denominatorSquared);
  return { status: 'OK' as const, value: normalCdf(statistic), expectedMaximumSharpe, trialCount };
}

export function evaluateStressEvents(outcomes: FormalEventOutcome[], asOfDate: string) {
  return SCORE_STRESS_PROTOCOL.events.map(event => {
    const rows = outcomes.filter(row => row.entryDate != null && row.entryDate >= event.from && row.entryDate < event.to);
    const candidateComparison = { status: 'CANDIDATE_NOT_PROVIDED' as const, candidate: null };
    if (asOfDate < event.to) return { ...event, status: 'OPEN_EVENT_WINDOW' as const, outcomeCount: rows.length, candidateComparison };
    if (rows.length === 0) return { ...event, status: 'NO_FORMAL_SIGNAL_COVERAGE' as const, outcomeCount: 0, candidateComparison };
    if (rows.some(row => row.priceProvenance !== 'PIT_RAW')) {
      return { ...event, status: 'NON_PIT_PRICE_COVERAGE' as const, outcomeCount: rows.length, candidateComparison };
    }
    if (rows.some(row => row.status !== 'OK')) {
      return { ...event, status: 'PENDING_OUTCOME' as const, outcomeCount: rows.length, candidateComparison };
    }
    const returns = rows.map(row => row.totalReturn!);
    return {
      ...event, status: 'OK' as const, outcomeCount: rows.length, candidateComparison,
      meanReturn: returns.reduce((sum, value) => sum + value, 0) / returns.length,
      worstReturn: Math.min(...returns),
      worstEpisodeDrawdown: Math.min(...rows.map(row => row.worstDrawdown!)),
    };
  });
}
