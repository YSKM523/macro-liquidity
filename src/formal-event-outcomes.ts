import { addDays } from './backtest';
import { scheduleExecutions } from './event-backtest';
import type { DailyInputProvenanceStatus, EventBacktestInputs, EventSignal, ScheduledExecution } from './event-backtest';
import { isoTimestampMs } from './pit';

const DAY_MS = 86_400_000;

export type FormalOutcomeStatus = 'OK' | 'PENDING_OUTCOME' | 'UNEXECUTED';

export interface FormalEventOutcome {
  horizonWeeks: 4 | 8 | 13;
  status: FormalOutcomeStatus;
  reason: 'NO_CLOSE_AFTER_TRADABLE_AT' | 'NO_EXIT_WITHIN_TOLERANCE' | null;
  modelDate: string;
  decisionAt: string;
  tradableAt: string;
  entryDate: string | null;
  targetDate: string | null;
  exitDate: string | null;
  score: number;
  totalReturn: number | null;
  worstDrawdown: number | null;
  verdict: 'BULLISH' | 'BEARISH' | 'NEUTRAL' | null;
  targetExposure: number | null;
  priceProvenance: DailyInputProvenanceStatus | null;
  modelVersion: string | null;
  configHash: string | null;
  codeCommitSha: string | null;
  dataRunId: string | null;
}

export interface FormalOutcomeBuild {
  outcomes: FormalEventOutcome[];
  executions: ScheduledExecution[];
  executionCoverage: {
    signalCount: number;
    executionCount: number;
    supersededCount: number;
    unexecutedCount: number;
  };
}

function dateMs(date: string): number {
  const value = Date.parse(`${date}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(value)
    || new Date(value).toISOString().slice(0, 10) !== date) throw new Error(`invalid formal date: ${date}`);
  return value;
}

function validateSignalVisibility(signal: EventSignal, cutoffMs: number): void {
  if (!Number.isFinite(signal.score) || signal.score < 0 || signal.score > 100) throw new Error('invalid formal score');
  if (!signal.recordedAt || !signal.dataCutoff || !signal.createdAt) throw new Error('formal outcome requires complete signal clocks');
  const decisionMs = isoTimestampMs(signal.decisionAt, 'formal decisionAt');
  const tradableMs = isoTimestampMs(signal.tradableAt, 'formal tradableAt');
  const recordedMs = isoTimestampMs(signal.recordedAt, 'formal recordedAt');
  const dataCutoffMs = isoTimestampMs(signal.dataCutoff, 'formal dataCutoff');
  const createdMs = isoTimestampMs(signal.createdAt, 'formal createdAt');
  if ([decisionMs, tradableMs, recordedMs, dataCutoffMs, createdMs].some(value => value >= cutoffMs)) {
    throw new Error('formal outcome signal not visible at cutoff');
  }
  if (dataCutoffMs > decisionMs || decisionMs > tradableMs || recordedMs < decisionMs || createdMs < decisionMs) {
    throw new Error('formal outcome signal clock ordering invalid');
  }
}

function worstDrawdown(values: number[]): number {
  let peak = values[0];
  let worst = 0;
  for (const value of values) {
    peak = Math.max(peak, value);
    worst = Math.min(worst, value / peak - 1);
  }
  return worst;
}

function common(signal: EventSignal, horizonWeeks: 4 | 8 | 13): Pick<FormalEventOutcome,
  'horizonWeeks' | 'modelDate' | 'decisionAt' | 'tradableAt' | 'score' | 'verdict' | 'targetExposure'
  | 'modelVersion' | 'configHash' | 'codeCommitSha' | 'dataRunId'> {
  return {
    horizonWeeks,
    modelDate: signal.signalDate,
    decisionAt: signal.decisionAt,
    tradableAt: signal.tradableAt,
    score: signal.score,
    verdict: signal.verdict === 'BULLISH' || signal.verdict === 'BEARISH' || signal.verdict === 'NEUTRAL'
      ? signal.verdict as FormalEventOutcome['verdict'] : null,
    targetExposure: signal.targetExposure ?? null,
    modelVersion: signal.modelVersion ?? null,
    configHash: signal.configHash ?? null,
    codeCommitSha: signal.codeCommitSha ?? null,
    dataRunId: signal.dataRunId ?? null,
  };
}

export function buildFormalEventOutcomes(
  input: EventBacktestInputs,
  horizons: ReadonlyArray<4 | 8 | 13> = [4, 8, 13],
  outcomeToleranceDays = 14,
): FormalOutcomeBuild {
  if (!input.asOfCutoff) throw new Error('formal outcome requires an explicit as-of cutoff');
  const cutoffMs = isoTimestampMs(input.asOfCutoff, 'formal outcome as-of cutoff');
  if (input.signals.length === 0) throw new Error('formal outcome has no official signal coverage');
  input.signals.forEach(signal => validateSignalVisibility(signal, cutoffMs));
  if (input.prices.length === 0) throw new Error('formal outcome has no execution price coverage');
  for (const price of input.prices) {
    dateMs(price.date);
    if (price.provenanceStatus !== 'PIT_RAW') throw new Error('formal outcome requires PIT_RAW daily prices');
    if (!price.fetchedAt || !price.dataRunId || !price.activationRunId || !price.activatedAt) {
      throw new Error('formal outcome requires complete daily price provenance');
    }
    const fetchedMs = isoTimestampMs(price.fetchedAt, 'formal price fetchedAt');
    const activatedMs = isoTimestampMs(price.activatedAt, 'formal price activatedAt');
    if (fetchedMs > activatedMs) throw new Error('formal outcome price fetched after activation');
    if (activatedMs >= cutoffMs) throw new Error('formal outcome price not visible at cutoff');
  }
  const prices = [...input.prices].sort((left, right) => left.date.localeCompare(right.date));
  const schedule = scheduleExecutions(input.signals, prices);
  const outcomes: FormalEventOutcome[] = [];
  for (const execution of schedule.executions) {
    const entryIndex = prices.findIndex(price => price.date === execution.executionDate);
    for (const horizonWeeks of horizons) {
      const targetDate = addDays(execution.executionDate, horizonWeeks * 7);
      const exit = prices.find(price => price.date >= targetDate);
      const withinTolerance = exit != null && (dateMs(exit.date) - dateMs(targetDate)) / DAY_MS <= outcomeToleranceDays;
      if (!exit || !withinTolerance) {
        outcomes.push({
          ...common(execution, horizonWeeks), status: 'PENDING_OUTCOME', reason: 'NO_EXIT_WITHIN_TOLERANCE',
          entryDate: execution.executionDate, targetDate, exitDate: null, totalReturn: null, worstDrawdown: null,
          priceProvenance: prices[entryIndex]?.provenanceStatus ?? null,
        });
        continue;
      }
      const exitIndex = prices.findIndex(price => price.date === exit.date);
      const path = prices.slice(entryIndex, exitIndex + 1).map(price => price.adjustedClose);
      outcomes.push({
        ...common(execution, horizonWeeks), status: 'OK', reason: null,
        entryDate: execution.executionDate, targetDate, exitDate: exit.date,
        totalReturn: exit.adjustedClose / execution.price - 1,
        worstDrawdown: worstDrawdown(path), priceProvenance: 'PIT_RAW',
      });
    }
  }
  for (const signal of schedule.unexecuted) {
    for (const horizonWeeks of horizons) outcomes.push({
      ...common(signal, horizonWeeks), status: 'UNEXECUTED', reason: 'NO_CLOSE_AFTER_TRADABLE_AT',
      entryDate: null, targetDate: null, exitDate: null, totalReturn: null, worstDrawdown: null, priceProvenance: null,
    });
  }
  outcomes.sort((left, right) => left.modelDate.localeCompare(right.modelDate) || left.horizonWeeks - right.horizonWeeks);
  return {
    outcomes,
    executions: schedule.executions,
    executionCoverage: {
      signalCount: input.signals.length,
      executionCount: schedule.executions.length,
      supersededCount: schedule.superseded.length,
      unexecutedCount: schedule.unexecuted.length,
    },
  };
}
