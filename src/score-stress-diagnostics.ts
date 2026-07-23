import type { EventBacktestInputs } from './event-backtest';
import type { DailyMarketPrice } from './event-backtest';
import { assertFormalEventInputs } from './evaluation-protocol';
import { buildFormalEventOutcomes } from './formal-event-outcomes';
import type { FormalEventOutcome } from './formal-event-outcomes';
import { sha256Hex } from './model-version';

const REGISTERED_SCORE_STRESS_ARTIFACT = Object.freeze({
  protocol: 'SCORE_STRESS_DIAGNOSTICS_V1',
  registered_at: '2026-07-22T20:36:03Z',
  registration_commit: 'd7aba3c2b5bd79cfaf7847cdc82770abb499fdcd',
  champion_change: false,
  score_buckets: [[0, 20], [20, 35], [35, 45], [45, 55], [55, 65], [65, 80], [80, 100]],
  bucket_interval_rule: 'LEFT_CLOSED_RIGHT_OPEN_EXCEPT_FINAL_CLOSED',
  horizon_weeks: [4, 8, 13],
  entry_rule: 'FIRST_ACTUAL_PIT_CLOSE_STRICTLY_AFTER_TRADABLE_AT_ELIGIBILITY',
  exit_rule: 'FIRST_ACTUAL_PIT_CLOSE_ON_OR_AFTER_ENTRY_PLUS_HORIZON_CALENDAR_DAYS',
  outcome_tolerance_days: 14,
  return_interval: 'ENTRY_EXCLUDED_EXIT_INCLUDED',
  independent_rule: 'GREEDY_INTERVAL_NON_OVERLAP',
  quantile_rule: 'TYPE7_LINEAR',
  negative_rule: 'RETURN_LT_ZERO',
  minimum_probability_n: 5,
  bh: { alpha: .05, family_rule: 'ISOLATED_BY_FAMILY', ranking_rule: 'STABLE_ASCENDING_P_THEN_HYPOTHESIS_ID', missing_p_value: 1 },
  dsr: {
    method: 'BAILEY_LOPEZ_DE_PRADO_2014',
    expected_maximum_rule: 'EULER_MASCHERONI_INTERPOLATION_FROM_COMPLETE_TRIAL_SHARPE_VARIANCE',
    probability_rule: 'PSR_WITH_SAMPLE_T_SKEWNESS_AND_NON_EXCESS_KURTOSIS',
    incomplete_trial_rule: 'TRIAL_UNIVERSE_INCOMPLETE_NULL',
  },
  events: [
    ['2018_Q4', '2018-10-01', '2019-01-01'],
    ['2019_REPO_STRESS', '2019-09-16', '2019-11-01'],
    ['2020_COVID', '2020-02-19', '2020-05-01'],
    ['2021_TGA_RRP', '2021-02-01', '2022-01-01'],
    ['2022_HIKING_QT', '2022-03-16', '2023-01-01'],
    ['2023_REGIONAL_BANKS', '2023-03-08', '2023-05-02'],
    ['2024_YEN_CARRY', '2024-07-01', '2024-09-01'],
    ['2025_2026_RESERVE_MGMT', '2025-01-01', '2027-01-01'],
  ],
  event_interval_rule: 'ENTRY_DATE_LEFT_CLOSED_RIGHT_OPEN',
  candidate_rule: 'INDEPENDENTLY_VERSIONED_PIT_ARTIFACT_OR_CANDIDATE_NOT_PROVIDED',
  promotion_threshold: null,
});

export function canonicalScoreStressProtocol(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

const SCORE_STRESS_PROTOCOL_DIGEST = '3ea92b2fc2f11745ab8f4810d9bab940f4ce4bed7892a50229822524176f38b3';
if (sha256Hex(canonicalScoreStressProtocol(REGISTERED_SCORE_STRESS_ARTIFACT)) !== SCORE_STRESS_PROTOCOL_DIGEST) {
  throw new Error('registered score/stress protocol literal mismatch; create an explicit amendment');
}

const SCORE_STRESS_PROTOCOL_AMENDMENTS = Object.freeze([Object.freeze({
  amendmentId: 'PR16-API-STATUS-001' as const,
  amendedAt: '2026-07-23T00:46:00Z',
  basedOnCommit: '587f00fd5af6b489b688e8edca942b210df112c8',
  canonicalProtocolDigest: SCORE_STRESS_PROTOCOL_DIGEST,
  scope: 'FAIL_CLOSED_FIXED_SHAPE_API_ENUM_EXTENSION' as const,
  addedStressEventStatuses: Object.freeze([
    'INPUT_UNAVAILABLE', 'NO_FORMAL_PRICE_COVERAGE', 'FORMAL_INPUT_INVALID',
  ] as const),
})]);

export const SCORE_STRESS_PROTOCOL = Object.freeze({
  protocol: 'SCORE_STRESS_DIAGNOSTICS_V1' as const,
  registeredAt: '2026-07-22T20:36:03Z',
  registrationCommit: 'd7aba3c2b5bd79cfaf7847cdc82770abb499fdcd',
  canonicalProtocolDigest: SCORE_STRESS_PROTOCOL_DIGEST,
  artifactSha256: '891f77f991ca40521639dee3ab50418999e4c3d9296e7bd675f693ee3801efa2',
  amendments: SCORE_STRESS_PROTOCOL_AMENDMENTS,
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
  assertFormalEventInputs(input);
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

export interface HypothesisLedgerEntry {
  hypothesisId: string;
  family: string;
  lifecycle: string;
  declaredDirectionCount: number;
  declaredWindowCount: number;
  declaredParameterCount: number;
  pValue: number | null;
  formalDailySharpe: number | null;
  reason: string;
}

export interface HypothesisLedger {
  schemaVersion: 'HYPOTHESIS_LEDGER_V1';
  appendOnly: true;
  registeredAt: string;
  registrationCommit: string;
  entries: HypothesisLedgerEntry[];
  candidateIds: string[];
}

interface LedgerInterpretationEntry {
  hypothesisId: string;
  candidateId: string;
  registrationClass: 'PREREGISTERED' | 'RETROSPECTIVE_REVIEW_AMENDMENT';
  resultsVisibleAtRegistration: boolean;
  registeredAt: string;
  registrationCommit: string;
  supersedes?: string;
}

interface LedgerInterpretation {
  schemaVersion: 'HYPOTHESIS_LEDGER_INTERPRETATION_V1';
  amendmentId: string;
  amendedAt: string;
  basedOnCommit: string;
  baseLedgerArtifactSha256: string;
  trialUniverseStatus: 'DECLARED_UPPER_BOUND_NOT_ENUMERATED';
  entries: LedgerInterpretationEntry[];
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value != null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalize(child)]));
  }
  return value;
}

function requiredString(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`invalid hypothesis ledger ${field}`);
}

const FROZEN_LEDGER_SEMANTIC_DIGEST = '573350572d9c73b029b7122465b2bcaf380f3c38e7d39ecee5a833e6a3324e3e';
const FROZEN_LEDGER_ARTIFACT_SHA256 = 'fb3f32d8c783294a7c4f7302fab24f7369bb20bcb9808c189bc23843c9f6ee0d';
const LEDGER_INTERPRETATION_SEMANTIC_DIGEST = '5164ca5c102bdf2b63deb66ade62229703439d65de016bfce2c7d0e47581a407';

export function validateHypothesisLedger(value: unknown, interpretationValue: unknown): HypothesisLedger {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid hypothesis ledger');
  const ledger = value as Record<string, unknown>;
  if (ledger.schema_version !== 'HYPOTHESIS_LEDGER_V1' || ledger.append_only !== true
    || !Array.isArray(ledger.entries)) throw new Error('invalid hypothesis ledger header');
  if (sha256Hex(JSON.stringify(canonicalize(value))) !== FROZEN_LEDGER_SEMANTIC_DIGEST) {
    throw new Error('frozen ledger semantic mutation; append a separate interpretation amendment');
  }
  requiredString(ledger.registered_at, 'registered_at');
  requiredString(ledger.registration_commit, 'registration_commit');
  const ids = new Set<string>();
  const entries = ledger.entries.map((raw, index): HypothesisLedgerEntry => {
    if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`invalid hypothesis entry ${index}`);
    const entry = raw as Record<string, unknown>;
    for (const field of ['hypothesis_id', 'family', 'lifecycle', 'reason']) requiredString(entry[field], field);
    if (ids.has(entry.hypothesis_id as string)) throw new Error(`duplicate hypothesis id: ${entry.hypothesis_id}`);
    ids.add(entry.hypothesis_id as string);
    for (const field of ['direction_count', 'window_count', 'parameter_count']) {
      if (!Number.isInteger(entry[field]) || (entry[field] as number) < 1) throw new Error(`invalid declared ${field}`);
    }
    if (entry.p_value != null || entry.formal_daily_sharpe != null) throw new Error('frozen ledger result fields changed');
    return {
      hypothesisId: entry.hypothesis_id as string, family: entry.family as string,
      lifecycle: entry.lifecycle as string, declaredDirectionCount: entry.direction_count as number,
      declaredWindowCount: entry.window_count as number, declaredParameterCount: entry.parameter_count as number,
      pValue: null, formalDailySharpe: null, reason: entry.reason as string,
    };
  });
  if (interpretationValue == null || typeof interpretationValue !== 'object' || Array.isArray(interpretationValue)) {
    throw new Error('invalid ledger interpretation amendment');
  }
  const interpretation = interpretationValue as unknown as LedgerInterpretation;
  if (sha256Hex(JSON.stringify(canonicalize(interpretationValue))) !== LEDGER_INTERPRETATION_SEMANTIC_DIGEST
    || interpretation.schemaVersion !== 'HYPOTHESIS_LEDGER_INTERPRETATION_V1'
    || interpretation.trialUniverseStatus !== 'DECLARED_UPPER_BOUND_NOT_ENUMERATED'
    || interpretation.baseLedgerArtifactSha256 !== FROZEN_LEDGER_ARTIFACT_SHA256
    || !Array.isArray(interpretation.entries)) throw new Error('ledger interpretation predecessor mismatch');
  requiredString(interpretation.amendmentId, 'amendmentId');
  requiredString(interpretation.amendedAt, 'amendedAt');
  if (!/^[a-f0-9]{40}$/.test(interpretation.basedOnCommit)) throw new Error('invalid interpretation base commit');
  if (interpretation.entries.length !== entries.length) throw new Error('ledger interpretation coverage mismatch');
  const interpretedIds = new Set<string>();
  const candidateIds: string[] = [];
  for (const entry of interpretation.entries) {
    if (!ids.has(entry.hypothesisId) || interpretedIds.has(entry.hypothesisId)) throw new Error('invalid interpreted hypothesis id');
    interpretedIds.add(entry.hypothesisId);
    requiredString(entry.candidateId, 'candidateId');
    requiredString(entry.registeredAt, 'registeredAt');
    requiredString(entry.registrationCommit, 'registrationCommit');
    if ((entry.registrationClass === 'PREREGISTERED') === entry.resultsVisibleAtRegistration) {
      throw new Error('inconsistent interpretation chronology');
    }
    if (entry.supersedes != null && !interpretedIds.has(entry.supersedes)) throw new Error('invalid interpretation supersession');
    candidateIds.push(entry.candidateId);
  }
  return { schemaVersion: 'HYPOTHESIS_LEDGER_V1', appendOnly: true,
    registeredAt: ledger.registered_at, registrationCommit: ledger.registration_commit, entries, candidateIds };
}

export function summarizeHypothesisLedger(ledger: HypothesisLedger) {
  const dimensions = ledger.entries.map(entry => ({
    entry,
    trials: entry.declaredDirectionCount * entry.declaredWindowCount * entry.declaredParameterCount,
  }));
  const families = [...new Set(ledger.entries.map(entry => entry.family))].sort().map(family => {
    const rows = dimensions.filter(row => row.entry.family === family);
    const trialCount = rows.reduce((sum, row) => sum + row.trials, 0);
    return { family, exactTrialCount: null, declaredUpperBoundTrialCount: trialCount,
      rejectedCount: null, effectiveMissingPValue: null, minimumAdjustedP: null };
  });
  return {
    status: 'RETROSPECTIVE_MULTIPLICITY_AUDIT' as const,
    trialUniverseStatus: 'DECLARED_UPPER_BOUND_NOT_ENUMERATED' as const,
    prospectiveGateApplied: false,
    candidateCount: new Set(ledger.candidateIds).size,
    exactTrialCount: null,
    declaredUpperBoundCounts: {
      directionSpecifications: ledger.entries.reduce((sum, entry) => sum + entry.declaredDirectionCount, 0),
      windows: ledger.entries.reduce((sum, entry) => sum + entry.declaredWindowCount, 0),
      parameterSpecifications: ledger.entries.reduce((sum, entry) => sum + entry.declaredParameterCount, 0),
      trials: dimensions.reduce((sum, row) => sum + row.trials, 0),
    },
    families,
    dsr: {
      status: 'NOT_APPLICABLE_CURRENT_VINTAGE_RESEARCH' as const,
      value: null,
      reason: 'NO_FORMAL_EVENT_TIME_DAILY_NAV_FOR_REGISTERED_PR11_PR12_TRIALS',
    },
  };
}

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
  const unavailable = (status: string) => ({
    status, value: null, expectedMaximumSharpe: null, trialCount,
  });
  if (!Number.isFinite(input.observedSharpe) || !Number.isFinite(input.skewness)
    || !Number.isFinite(input.kurtosis) || input.trialSharpes.some(value => value != null && !Number.isFinite(value))) {
    return unavailable('INVALID_INPUT');
  }
  if (!Number.isInteger(input.sampleT) || input.sampleT < 2) return unavailable('INSUFFICIENT_SAMPLE');
  if (trialCount < 2) return unavailable('INSUFFICIENT_TRIALS');
  if (input.trialSharpes.some(value => value == null)) {
    return { status: 'TRIAL_UNIVERSE_INCOMPLETE' as const, value: null, expectedMaximumSharpe: null, trialCount };
  }
  const sharpes = input.trialSharpes as number[];
  const mean = sharpes.reduce((sum, value) => sum + value, 0) / trialCount;
  const variance = sharpes.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (trialCount - 1);
  if (!(variance > Number.EPSILON)) return unavailable('ZERO_TRIAL_VARIANCE');
  const gamma = .5772156649015329;
  const expectedMaximumSharpe = Math.sqrt(variance) * (
    (1 - gamma) * inverseNormal(1 - 1 / trialCount)
    + gamma * inverseNormal(1 - 1 / (trialCount * Math.E))
  );
  const denominatorSquared = 1 - input.skewness * input.observedSharpe
    + ((input.kurtosis - 1) / 4) * input.observedSharpe ** 2;
  if (!(denominatorSquared > 0) || !Number.isFinite(denominatorSquared)) return unavailable('INVALID_INPUT');
  const statistic = (input.observedSharpe - expectedMaximumSharpe) * Math.sqrt(input.sampleT - 1)
    / Math.sqrt(denominatorSquared);
  return { status: 'OK' as const, value: normalCdf(statistic), expectedMaximumSharpe, trialCount };
}

function eventDrawdown(prices: DailyMarketPrice[], from: string, to: string): number | null {
  const values = prices.filter(row => row.date >= from && row.date < to)
    .sort((left, right) => left.date.localeCompare(right.date))
    .map(row => row.adjustedClose);
  if (values.length === 0) return null;
  if (values.some(value => !Number.isFinite(value) || value <= 0)) throw new Error('invalid stress-event price');
  let peak = values[0];
  let drawdown = 0;
  for (const value of values) {
    peak = Math.max(peak, value);
    drawdown = Math.min(drawdown, value / peak - 1);
  }
  return drawdown;
}

export function evaluateStressEvents(
  outcomes: FormalEventOutcome[],
  asOfDate: string,
  eventPrices: DailyMarketPrice[] = [],
) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(asOfDate)
    || new Date(`${asOfDate}T00:00:00Z`).toISOString().slice(0, 10) !== asOfDate) {
    throw new Error('invalid stress-event as-of date');
  }
  return SCORE_STRESS_PROTOCOL.events.map(event => {
    const rows = outcomes.filter(row => row.entryDate != null && row.entryDate >= event.from && row.entryDate < event.to);
    const candidateComparison = { status: 'CANDIDATE_NOT_PROVIDED' as const, candidate: null };
    if (asOfDate < event.to) return { ...event, status: 'OPEN_EVENT_WINDOW' as const, outcomeCount: rows.length, candidateComparison };
    if (rows.length === 0) return { ...event, status: 'NO_FORMAL_SIGNAL_COVERAGE' as const, outcomeCount: 0, candidateComparison };
    if (rows.some(row => row.priceProvenance !== 'PIT_RAW')) {
      return { ...event, status: 'NON_PIT_PRICE_COVERAGE' as const, outcomeCount: rows.length, candidateComparison };
    }
    const okRows = rows.filter(row => row.status === 'OK');
    if (okRows.length === 0 && rows.some(row => row.status === 'PENDING_OUTCOME')) {
      return { ...event, status: 'PENDING_OUTCOME' as const, outcomeCount: rows.length, candidateComparison };
    }
    const returns = okRows.map(row => row.totalReturn!);
    const horizons = SCORE_STRESS_PROTOCOL.horizonsWeeks.map(horizonWeeks => {
      const horizonRows = okRows.filter(row => row.horizonWeeks === horizonWeeks);
      return {
        horizonWeeks,
        n: horizonRows.length,
        bearishN: horizonRows.filter(row => row.verdict === 'BEARISH').length,
        averageExposure: horizonRows.length === 0 ? null
          : horizonRows.reduce((sum, row) => sum + row.targetExposure!, 0) / horizonRows.length,
        meanReturn: horizonRows.length === 0 ? null
          : horizonRows.reduce((sum, row) => sum + row.totalReturn!, 0) / horizonRows.length,
        worstReturn: horizonRows.length === 0 ? null : Math.min(...horizonRows.map(row => row.totalReturn!)),
      };
    });
    const completeHorizons = horizons.every(row => row.n > 0);
    const partial = !completeHorizons || okRows.length !== rows.length;
    return {
      ...event, status: partial ? 'PARTIAL_COVERAGE' as const : 'OK' as const,
      outcomeCount: rows.length, candidateComparison, horizons,
      spxDrawdown: eventDrawdown(eventPrices, event.from, event.to),
      meanReturn: returns.length === 0 ? null : returns.reduce((sum, value) => sum + value, 0) / returns.length,
      worstReturn: returns.length === 0 ? null : Math.min(...returns),
      worstEpisodeDrawdown: okRows.length === 0 ? null : Math.min(...okRows.map(row => row.worstDrawdown!)),
    };
  });
}

export type StressEventUnavailableStatus = 'INPUT_UNAVAILABLE' | 'NO_FORMAL_SIGNAL_COVERAGE'
  | 'NON_PIT_PRICE_COVERAGE' | 'NO_FORMAL_PRICE_COVERAGE' | 'FORMAL_INPUT_INVALID';

export function buildUnavailableStressEvents(status: StressEventUnavailableStatus) {
  return SCORE_STRESS_PROTOCOL.events.map(event => ({
    ...event,
    status,
    outcomeCount: 0,
    candidateComparison: { status: 'CANDIDATE_NOT_PROVIDED' as const, candidate: null },
  }));
}
