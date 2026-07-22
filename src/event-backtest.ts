import { isoTimestampMs } from './pit';
import { EVENT_BACKTEST_ASSUMPTIONS } from './config';
import { officialPortfolioFieldIssue } from './portfolio-policy';
import type { PortfolioTier } from './portfolio-policy';

export interface EventSignal {
  signalDate: string;
  decisionAt: string;
  tradableAt: string;
  score: number;
  targetExposure?: number;
  verdict?: unknown;
  netliqDir?: unknown;
  snapshotVixEod?: number | null;
  portfolioTier?: PortfolioTier;
  portfolioMethodology?: 'DASHBOARD_EXPOSURE_TIERS_V1';
  stressMethodology?: 'PIT_SNAPSHOT_VIX_PROXY';
  policyIssue?: string;
  recordedAt?: string;
  dataRunId?: string;
  modelVersion?: string | null;
  configHash?: string | null;
  codeCommitSha?: string | null;
  dataCutoff?: string | null;
  createdAt?: string | null;
}

export interface DailyMarketPrice {
  date: string;
  adjustedClose: number;
  source: string;
  fetchedAt?: string;
  dataRunId?: string;
  activationRunId?: string;
  activatedAt?: string;
  provenanceStatus?: DailyInputProvenanceStatus;
}

export type DailyInputProvenanceStatus = 'PIT_RAW' | 'SYNTHETIC_BACKFILL' | 'LEGACY_NO_PIT';

export interface ScheduledExecution extends EventSignal {
  executionDate: string;
  eligibilityAt: string;
  executionAt: string;
  price: number;
  oldExposure: number;
  newExposure: number;
  source: string;
}

export interface UnexecutedSignal extends EventSignal {
  reason: 'NO_CLOSE_AFTER_TRADABLE_AT';
}

export interface ExecutionSchedule {
  executions: ScheduledExecution[];
  unexecuted: UnexecutedSignal[];
  superseded: Array<EventSignal & { executionDate: string; reason: 'SUPERSEDED_AT_SAME_CLOSE' }>;
}

export interface DailyVix {
  date: string;
  value: number;
  source: string;
  fetchedAt?: string;
  dataRunId?: string;
  activationRunId?: string;
  activatedAt?: string;
  provenanceStatus?: DailyInputProvenanceStatus;
}

export interface DailyCashRate {
  date: string;
  rate: number;
  source: string;
  fetchedAt?: string;
  dataRunId?: string;
  activationRunId?: string;
  activatedAt?: string;
  provenanceStatus?: DailyInputProvenanceStatus;
}

export interface EventBacktestInputs {
  asOfCutoff?: string;
  signals: EventSignal[];
  prices: DailyMarketPrice[];
  vix: DailyVix[];
  cashRates: DailyCashRate[];
}

export interface EventNavRow {
  date: string;
  nav: number;
  exposure: number;
  assetReturn: number;
  cashReturn: number;
  financingReturn: number;
  turnover: number;
  tradeCost: number;
}

export interface PortfolioMetrics {
  totalReturn: number | null;
  averageBeta: number | null;
  annualizedVolatility: number | null;
  sharpe: number | null;
  sortino: number | null;
  maxDrawdown: number | null;
  maxDrawdownDurationSessions: number | null;
}

export interface DailyPortfolioSimulation {
  status: 'OK' | 'DATA_INCOMPLETE';
  reason: string | null;
  nav: EventNavRow[];
  tradingCostRate: number | null;
}

export interface BenchmarkTargets {
  spxBuyHold: number[];
  betaMatchedStatic: number[];
  volatilityTarget: number[];
  movingAverage200: number[];
}

export interface PortfolioComparisonEntry {
  methodology: string;
  sessions: number;
  tradingCostRate: number;
  metrics: PortfolioMetrics;
}

export interface EventPortfolioAnalytics {
  methodology: 'DASHBOARD_EXPOSURE_TIERS_V1';
  stressMethodology: 'PIT_SNAPSHOT_VIX_PROXY';
  timingComparisonMethodology: 'CUMULATIVE_RETURN_DIFFERENCE_VS_BETA_MATCHED_STATIC';
  cumulativeTimingReturnDifference: number | null;
  strategy: PortfolioComparisonEntry;
  benchmarks: {
    spxBuyHold: PortfolioComparisonEntry;
    betaMatchedStatic: PortfolioComparisonEntry;
    volatilityTarget: PortfolioComparisonEntry;
    movingAverage200: PortfolioComparisonEntry;
  };
}

export interface EventBacktestResult {
  status: 'OK' | 'DATA_INCOMPLETE';
  reason: string | null;
  nav: EventNavRow[];
  executions: ScheduledExecution[];
  unexecuted: UnexecutedSignal[];
  superseded: ExecutionSchedule['superseded'];
  totals: { totalReturn: number | null; tradingCostRate: number | null; sessions: number | null };
  assumptions: typeof EVENT_BACKTEST_ASSUMPTIONS;
  provenance: InputProvenance;
  portfolio: EventPortfolioAnalytics | null;
}

export interface InputProvenance {
  revisionPolicy: 'APPEND_ONLY_AS_OF';
  responseReproducible: boolean;
  asOfCutoff: string | null;
  maxFetchedAt: string | null;
  sourceLabels: string[];
  dataRunCount: number;
  revisionRunCount: number;
  containsSynthetic: boolean;
}

function requireDate(value: string, field: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error(`invalid ${field}`);
  const parsed = new Date(`${value}T00:00:00Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new Error(`invalid ${field}`);
  }
}

export function scheduleExecutions(
  signals: EventSignal[],
  marketPrices: DailyMarketPrice[],
): ExecutionSchedule {
  const prices = marketPrices.map(row => {
    requireDate(row.date, 'market date');
    if (!Number.isFinite(row.adjustedClose) || row.adjustedClose <= 0) throw new Error('invalid market price');
    if (!row.source) throw new Error('missing market source');
    const eligibilityAt = `${row.date}T${EVENT_BACKTEST_ASSUMPTIONS.earliestUsCloseEligibilityUtc}`;
    const executionAt = `${row.date}T${EVENT_BACKTEST_ASSUMPTIONS.accountingCloseUtc}`;
    return {
      ...row, eligibilityAt, executionAt,
      eligibilityMs: isoTimestampMs(eligibilityAt, 'eligibilityAt'),
      executionMs: isoTimestampMs(executionAt, 'executionAt'),
    };
  }).sort((a, b) => a.executionMs - b.executionMs);
  for (let index = 1; index < prices.length; index++) {
    if (prices[index - 1].date === prices[index].date) throw new Error('duplicate market session');
  }

  const validated = signals.map((signal, index) => {
    requireDate(signal.signalDate, 'signal date');
    const decisionMs = isoTimestampMs(signal.decisionAt, 'decisionAt');
    const tradableMs = isoTimestampMs(signal.tradableAt, 'tradableAt');
    if (decisionMs > tradableMs) throw new Error('decisionAt after tradableAt');
    if (!Number.isFinite(signal.score)) throw new Error('invalid signal score');
    if (signal.targetExposure != null && (!Number.isFinite(signal.targetExposure) || signal.targetExposure < 0)) {
      throw new Error('invalid target exposure');
    }
    return { signal, index, decisionMs, tradableMs };
  });

  const selected = new Map<string, typeof validated[number]>();
  const unexecuted: UnexecutedSignal[] = [];
  const superseded: ExecutionSchedule['superseded'] = [];
  for (const candidate of validated) {
    const price = prices.find(row => row.eligibilityMs > candidate.tradableMs);
    if (!price) {
      unexecuted.push({ ...candidate.signal, reason: 'NO_CLOSE_AFTER_TRADABLE_AT' });
      continue;
    }
    const current = selected.get(price.date);
    if (!current || candidate.decisionMs > current.decisionMs ||
      (candidate.decisionMs === current.decisionMs && candidate.index > current.index)) {
      if (current) superseded.push({ ...current.signal, executionDate: price.date, reason: 'SUPERSEDED_AT_SAME_CLOSE' });
      selected.set(price.date, candidate);
    } else {
      superseded.push({ ...candidate.signal, executionDate: price.date, reason: 'SUPERSEDED_AT_SAME_CLOSE' });
    }
  }

  let exposure = 0;
  const executions: ScheduledExecution[] = [];
  for (const price of prices) {
    const candidate = selected.get(price.date);
    if (!candidate) continue;
    const newExposure = candidate.signal.targetExposure ?? (
      candidate.signal.score > EVENT_BACKTEST_ASSUMPTIONS.legacyCompatibilityBullishScoreExclusive ? 1 : 0
    );
    executions.push({
      ...candidate.signal,
      executionDate: price.date,
      eligibilityAt: price.eligibilityAt,
      executionAt: price.executionAt,
      price: price.adjustedClose,
      oldExposure: exposure,
      newExposure,
      source: price.source,
    });
    exposure = newExposure;
  }
  return { executions, unexecuted, superseded };
}

const DAY_MS = 86_400_000;

function calendarDays(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);
}

function validateDatedSeries<T extends { date: string; source: string }>(
  rows: T[],
  value: (row: T) => number,
  label: string,
): T[] {
  const sorted = rows.map(row => {
    requireDate(row.date, `${label} date`);
    if (!row.source) throw new Error(`missing ${label} source`);
    if (!Number.isFinite(value(row))) throw new Error(`invalid ${label} value`);
    return row;
  }).sort((a, b) => a.date.localeCompare(b.date));
  for (let index = 1; index < sorted.length; index++) {
    if (sorted[index - 1].date === sorted[index].date) throw new Error(`duplicate ${label} date`);
  }
  return sorted;
}

function latestOnOrBefore<T extends { date: string }>(rows: T[], date: string): T | undefined {
  let match: T | undefined;
  for (const row of rows) {
    if (row.date > date) break;
    match = row;
  }
  return match;
}

function latestBefore<T extends { date: string }>(rows: T[], date: string): T | undefined {
  let match: T | undefined;
  for (const row of rows) {
    if (row.date >= date) break;
    match = row;
  }
  return match;
}

function populationStd(values: number[]): number | null {
  if (values.length < 2) return null;
  const average = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + (value - average) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

export function buildBenchmarkTargets(
  prices: DailyMarketPrice[],
  strategyExposures: number[],
  evaluationStartIndex = 0,
): BenchmarkTargets {
  if (!Number.isInteger(evaluationStartIndex) || evaluationStartIndex < 0 || evaluationStartIndex > prices.length) {
    throw new Error('invalid benchmark evaluation start');
  }
  const evaluationPrices = prices.slice(evaluationStartIndex);
  if (evaluationPrices.length !== strategyExposures.length) throw new Error('benchmark exposure length mismatch');
  if (strategyExposures.some(value => !Number.isFinite(value) || value < 0 || value > 1)) {
    throw new Error('invalid strategy exposure for benchmark');
  }
  const returnBearingExposures = strategyExposures.slice(0, -1);
  const averageBeta = returnBearingExposures.length === 0
    ? 0
    : returnBearingExposures.reduce((sum, value) => sum + value, 0) / returnBearingExposures.length;
  const volatilityTarget = evaluationPrices.map((_row, localIndex) => {
    const index = evaluationStartIndex + localIndex;
    const lookback = EVENT_BACKTEST_ASSUMPTIONS.volatilityTargetLookbackSessions;
    if (index < lookback + 1) return 0;
    const priorReturns: number[] = [];
    for (let cursor = index - lookback; cursor < index; cursor++) {
      priorReturns.push(prices[cursor].adjustedClose / prices[cursor - 1].adjustedClose - 1);
    }
    const dailyVolatility = populationStd(priorReturns);
    if (dailyVolatility == null) return 0;
    if (dailyVolatility === 0) return EVENT_BACKTEST_ASSUMPTIONS.volatilityTargetMaximumExposure;
    return Math.min(
      EVENT_BACKTEST_ASSUMPTIONS.volatilityTargetMaximumExposure,
      EVENT_BACKTEST_ASSUMPTIONS.volatilityTargetAnnual /
        (dailyVolatility * Math.sqrt(EVENT_BACKTEST_ASSUMPTIONS.annualizationSessions)),
    );
  });
  const movingAverage200 = evaluationPrices.map((_row, localIndex) => {
    const index = evaluationStartIndex + localIndex;
    const lookback = EVENT_BACKTEST_ASSUMPTIONS.movingAverageLookbackSessions;
    if (index < lookback) return 0;
    const priorCloses = prices.slice(index - lookback, index).map(row => row.adjustedClose);
    const average = priorCloses.reduce((sum, value) => sum + value, 0) / priorCloses.length;
    return priorCloses[priorCloses.length - 1] > average ? 1 : 0;
  });
  return {
    spxBuyHold: evaluationPrices.map(() => 1),
    betaMatchedStatic: evaluationPrices.map(() => averageBeta),
    volatilityTarget,
    movingAverage200,
  };
}

export function simulateDailyPortfolio(input: {
  prices: DailyMarketPrice[];
  targetExposures: number[];
  vix: DailyVix[];
  cashRates: DailyCashRate[];
}): DailyPortfolioSimulation {
  const prices = validateDatedSeries(input.prices, row => row.adjustedClose, 'market');
  if (prices.some(row => row.adjustedClose <= 0)) throw new Error('invalid market price');
  if (prices.length !== input.targetExposures.length) throw new Error('target exposure length mismatch');
  if (input.targetExposures.some(value => !Number.isFinite(value) || value < 0)) {
    throw new Error('invalid target exposure');
  }
  const vix = validateDatedSeries(input.vix, row => row.value, 'VIX');
  if (vix.some(row => row.value < 0)) throw new Error('invalid VIX value');
  const cashRates = validateDatedSeries(input.cashRates, row => row.rate, 'SOFR');
  if (prices.length < 2) {
    return { status: 'DATA_INCOMPLETE', reason: 'insufficient market sessions', nav: [], tradingCostRate: null };
  }

  let navValue = 1;
  let exposure = 0;
  let tradingCost = 0;
  const nav: EventNavRow[] = [];
  for (let index = 0; index < prices.length; index++) {
    const current = prices[index];
    let assetReturn = 0;
    let cashReturn = 0;
    let financingReturn = 0;
    if (index > 0) {
      const previous = prices[index - 1];
      const days = calendarDays(previous.date, current.date);
      const fixing = latestBefore(cashRates, previous.date);
      if (!fixing) return { status: 'DATA_INCOMPLETE', reason: `SOFR missing at ${previous.date}`, nav: [], tradingCostRate: null };
      if (calendarDays(fixing.date, previous.date) > EVENT_BACKTEST_ASSUMPTIONS.cashRateMaxStaleCalendarDays) {
        return { status: 'DATA_INCOMPLETE', reason: `SOFR stale at ${previous.date}`, nav: [], tradingCostRate: null };
      }
      assetReturn = exposure * (current.adjustedClose / previous.adjustedClose - 1);
      const annualCashRate = fixing.rate / EVENT_BACKTEST_ASSUMPTIONS.cashRatePercentDenominator;
      if (exposure <= 1) cashReturn = (1 - exposure) * annualCashRate * days /
        EVENT_BACKTEST_ASSUMPTIONS.cashDayCountDenominator;
      else financingReturn = (1 - exposure) *
        (annualCashRate + EVENT_BACKTEST_ASSUMPTIONS.financingSpreadBps /
          EVENT_BACKTEST_ASSUMPTIONS.basisPointsDenominator) * days /
          EVENT_BACKTEST_ASSUMPTIONS.cashDayCountDenominator;
      navValue *= 1 + assetReturn + cashReturn + financingReturn;
    }

    const newExposure = input.targetExposures[index];
    const turnover = Math.abs(newExposure - exposure);
    let tradeCost = 0;
    if (turnover > 0) {
      const vixFixing = latestOnOrBefore(vix, current.date);
      const conservativeExtra = !vixFixing ||
        calendarDays(vixFixing.date, current.date) > EVENT_BACKTEST_ASSUMPTIONS.vixMaxStaleCalendarDays ||
        vixFixing.value >= EVENT_BACKTEST_ASSUMPTIONS.vixStressLevel;
      const costBps = EVENT_BACKTEST_ASSUMPTIONS.commissionBps +
        EVENT_BACKTEST_ASSUMPTIONS.baseSlippageBps +
        (conservativeExtra ? EVENT_BACKTEST_ASSUMPTIONS.highVolExtraSlippageBps : 0);
      tradeCost = turnover * costBps / EVENT_BACKTEST_ASSUMPTIONS.basisPointsDenominator;
      navValue *= 1 - tradeCost;
      tradingCost += tradeCost;
    }
    exposure = newExposure;
    if (![navValue, exposure, assetReturn, cashReturn, financingReturn, turnover, tradeCost].every(Number.isFinite)) {
      throw new Error('non-finite portfolio NAV output');
    }
    nav.push({ date: current.date, nav: navValue, exposure, assetReturn, cashReturn, financingReturn, turnover, tradeCost });
  }
  return { status: 'OK', reason: null, nav, tradingCostRate: tradingCost };
}

export function computePortfolioMetrics(rows: Array<Pick<EventNavRow, 'date' | 'nav' | 'exposure'>>): PortfolioMetrics {
  const empty: PortfolioMetrics = {
    totalReturn: null, averageBeta: null, annualizedVolatility: null,
    sharpe: null, sortino: null, maxDrawdown: null, maxDrawdownDurationSessions: null,
  };
  if (rows.length < 2) return empty;
  if (rows.some(row => !Number.isFinite(row.nav) || row.nav <= 0 || !Number.isFinite(row.exposure))) {
    throw new Error('invalid portfolio metric input');
  }
  const returns = rows.map((row, index) => row.nav / (index === 0 ? 1 : rows[index - 1].nav) - 1);
  const averageReturn = returns.reduce((sum, value) => sum + value, 0) / returns.length;
  const volatility = populationStd(returns);
  const hasDownside = returns.some(value => value < 0);
  const downsideDeviation = !hasDownside
    ? null
    : Math.sqrt(returns.reduce((sum, value) => sum + Math.min(value, 0) ** 2, 0) / returns.length);
  let peak = 1;
  let maxDrawdown = 0;
  let currentDuration = 0;
  let maxDuration = 0;
  for (const row of rows) {
    if (row.nav >= peak) {
      peak = row.nav;
      currentDuration = 0;
    } else {
      currentDuration += 1;
      maxDuration = Math.max(maxDuration, currentDuration);
      maxDrawdown = Math.min(maxDrawdown, row.nav / peak - 1);
    }
  }
  return {
    totalReturn: rows[rows.length - 1].nav - 1,
    averageBeta: rows.slice(0, -1).reduce((sum, row) => sum + row.exposure, 0) / (rows.length - 1),
    annualizedVolatility: volatility == null ? null : volatility *
      Math.sqrt(EVENT_BACKTEST_ASSUMPTIONS.annualizationSessions),
    sharpe: volatility == null || volatility === 0 ? null : averageReturn / volatility *
      Math.sqrt(EVENT_BACKTEST_ASSUMPTIONS.annualizationSessions),
    sortino: downsideDeviation == null || downsideDeviation === 0 ? null : averageReturn / downsideDeviation *
      Math.sqrt(EVENT_BACKTEST_ASSUMPTIONS.annualizationSessions),
    maxDrawdown,
    maxDrawdownDurationSessions: maxDuration,
  };
}

function incomplete(
  reason: string,
  schedule: ExecutionSchedule,
  provenance: InputProvenance,
): EventBacktestResult {
  return {
    status: 'DATA_INCOMPLETE', reason, nav: [],
    executions: schedule.executions, unexecuted: schedule.unexecuted, superseded: schedule.superseded,
    totals: { totalReturn: null, tradingCostRate: null, sessions: null },
    assumptions: EVENT_BACKTEST_ASSUMPTIONS,
    provenance,
    portfolio: null,
  };
}

function portfolioAnalytics(
  strategy: DailyPortfolioSimulation,
  cutoffVisiblePrices: DailyMarketPrice[],
  evaluationStartIndex: number,
  vix: DailyVix[],
  cashRates: DailyCashRate[],
): EventPortfolioAnalytics {
  if (strategy.status !== 'OK' || strategy.tradingCostRate == null) throw new Error('strategy simulation incomplete');
  const prices = cutoffVisiblePrices.slice(evaluationStartIndex);
  const targets = buildBenchmarkTargets(
    cutoffVisiblePrices, strategy.nav.map(row => row.exposure), evaluationStartIndex,
  );
  const run = (methodology: string, targetExposures: number[]): PortfolioComparisonEntry => {
    const simulation = simulateDailyPortfolio({ prices, targetExposures, vix, cashRates });
    if (simulation.status !== 'OK' || simulation.tradingCostRate == null) {
      throw new Error(`benchmark simulation incomplete: ${simulation.reason ?? methodology}`);
    }
    return {
      methodology, sessions: simulation.nav.length, tradingCostRate: simulation.tradingCostRate,
      metrics: computePortfolioMetrics(simulation.nav),
    };
  };
  const strategyEntry: PortfolioComparisonEntry = {
    methodology: EVENT_BACKTEST_ASSUMPTIONS.strategyMethodology, sessions: strategy.nav.length,
    tradingCostRate: strategy.tradingCostRate, metrics: computePortfolioMetrics(strategy.nav),
  };
  const betaMatchedStatic = run(EVENT_BACKTEST_ASSUMPTIONS.betaMatchedBenchmarkMethodology, targets.betaMatchedStatic);
  const strategyReturn = strategyEntry.metrics.totalReturn;
  const betaReturn = betaMatchedStatic.metrics.totalReturn;
  return {
    methodology: EVENT_BACKTEST_ASSUMPTIONS.strategyMethodology,
    stressMethodology: EVENT_BACKTEST_ASSUMPTIONS.snapshotStressMethodology,
    timingComparisonMethodology: EVENT_BACKTEST_ASSUMPTIONS.timingComparisonMethodology,
    cumulativeTimingReturnDifference: strategyReturn == null || betaReturn == null
      ? null
      : strategyReturn - betaReturn,
    strategy: strategyEntry,
    benchmarks: {
      spxBuyHold: run(EVENT_BACKTEST_ASSUMPTIONS.buyHoldBenchmarkMethodology, targets.spxBuyHold),
      betaMatchedStatic,
      volatilityTarget: run(
        EVENT_BACKTEST_ASSUMPTIONS.volatilityTargetBenchmarkMethodology,
        targets.volatilityTarget,
      ),
      movingAverage200: run(
        EVENT_BACKTEST_ASSUMPTIONS.movingAverageBenchmarkMethodology,
        targets.movingAverage200,
      ),
    },
  };
}

function inputProvenance(inputs: EventBacktestInputs): InputProvenance {
  const rows = [...inputs.prices, ...inputs.vix, ...inputs.cashRates];
  let maxFetchedAt: string | null = null;
  let maxMs = -Infinity;
  for (const row of rows) {
    if (!row.fetchedAt) continue;
    const ms = isoTimestampMs(row.fetchedAt, 'backtest input fetchedAt');
    if (ms > maxMs) { maxMs = ms; maxFetchedAt = row.fetchedAt; }
  }
  const runIds = new Set([
    ...rows.map(row => row.dataRunId), ...inputs.signals.map(signal => signal.dataRunId),
  ].filter((value): value is string => Boolean(value)));
  const revisionRunIds = new Set(rows.map(row => row.activationRunId)
    .filter((value): value is string => Boolean(value)));
  let asOfCutoff = inputs.asOfCutoff ?? null;
  if (asOfCutoff) isoTimestampMs(asOfCutoff, 'backtest asOfCutoff');
  return {
    revisionPolicy: 'APPEND_ONLY_AS_OF', responseReproducible: false, asOfCutoff, maxFetchedAt,
    sourceLabels: [...new Set(rows.map(row => row.source))].sort(),
    dataRunCount: runIds.size,
    revisionRunCount: revisionRunIds.size,
    containsSynthetic: rows.some(row => row.provenanceStatus === 'SYNTHETIC_BACKFILL'),
  };
}

function formalProvenanceIssue(inputs: EventBacktestInputs, provenance: InputProvenance): string | null {
  if (!provenance.asOfCutoff) return 'missing as-of cutoff provenance';
  const cutoffMs = isoTimestampMs(provenance.asOfCutoff, 'backtest asOfCutoff');
  for (const signal of inputs.signals) {
    if (!signal.recordedAt || !signal.dataRunId) return 'missing official signal provenance';
    if (signal.targetExposure == null || !signal.portfolioTier ||
      signal.portfolioMethodology !== EVENT_BACKTEST_ASSUMPTIONS.strategyMethodology ||
      signal.stressMethodology !== EVENT_BACKTEST_ASSUMPTIONS.snapshotStressMethodology) {
      return 'missing explicit formal portfolio target';
    }
    if (isoTimestampMs(signal.recordedAt, 'signal recordedAt') >= cutoffMs) {
      return 'signal not visible strictly before as-of cutoff';
    }
  }
  for (const row of [...inputs.prices, ...inputs.vix, ...inputs.cashRates]) {
    if (!row.fetchedAt || !row.dataRunId || !row.activationRunId) return 'missing daily input provenance';
    if (!row.activatedAt) return 'missing daily input activation time';
    if (isoTimestampMs(row.activatedAt, 'daily input activatedAt') >= cutoffMs) {
      return 'daily input not visible strictly before as-of cutoff';
    }
    if (row.provenanceStatus === 'SYNTHETIC_BACKFILL') return 'synthetic backfill is not formal input';
    if (row.provenanceStatus === 'LEGACY_NO_PIT') return 'legacy input without PIT provenance';
    if (row.provenanceStatus !== 'PIT_RAW') return 'missing daily input provenance status';
  }
  return null;
}

export function runEventTimeBacktest(inputs: EventBacktestInputs): EventBacktestResult {
  const prices = [...inputs.prices].sort((a, b) => a.date.localeCompare(b.date));
  const provenance = inputProvenance(inputs);
  const invalidOfficialField = inputs.signals.some(signal => signal.policyIssue != null ||
    officialPortfolioFieldIssue({
      score: signal.score, verdict: signal.verdict, netliqDir: signal.netliqDir,
      snapshotVixEod: signal.snapshotVixEod,
    }) != null);
  if (invalidOfficialField) {
    return incomplete('invalid official portfolio field', { executions: [], unexecuted: [], superseded: [] }, provenance);
  }
  const schedule = scheduleExecutions(inputs.signals, prices);
  const vix = validateDatedSeries(inputs.vix, row => row.value, 'VIX');
  if (vix.some(row => row.value < 0)) throw new Error('invalid VIX value');
  const cashRates = validateDatedSeries(inputs.cashRates, row => row.rate, 'SOFR');
  const provenanceIssue = formalProvenanceIssue(inputs, provenance);
  if (provenanceIssue) return incomplete(provenanceIssue, schedule, provenance);
  provenance.responseReproducible = true;
  if (schedule.executions.length === 0) return incomplete('no executable PIT signal', schedule, provenance);

  const executionByDate = new Map(schedule.executions.map(execution => [execution.executionDate, execution]));
  const firstDate = schedule.executions[0].executionDate;
  const firstIndex = prices.findIndex(row => row.date === firstDate);
  if (firstIndex < 0 || firstIndex >= prices.length - 1) {
    return incomplete('insufficient executable market sessions', schedule, provenance);
  }
  const evaluationPrices = prices.slice(firstIndex);
  let exposure = 0;
  const targetExposures = evaluationPrices.map(price => {
    const execution = executionByDate.get(price.date);
    if (execution) exposure = execution.newExposure;
    return exposure;
  });
  const simulation = simulateDailyPortfolio({ prices: evaluationPrices, targetExposures, vix, cashRates });
  if (simulation.status !== 'OK' || simulation.tradingCostRate == null) {
    return incomplete(simulation.reason ?? 'portfolio simulation incomplete', schedule, provenance);
  }
  const portfolio = portfolioAnalytics(simulation, prices, firstIndex, vix, cashRates);

  return {
    status: 'OK', reason: null, nav: simulation.nav,
    executions: schedule.executions, unexecuted: schedule.unexecuted, superseded: schedule.superseded,
    totals: {
      totalReturn: simulation.nav[simulation.nav.length - 1].nav - 1,
      tradingCostRate: simulation.tradingCostRate,
      sessions: simulation.nav.length,
    },
    assumptions: EVENT_BACKTEST_ASSUMPTIONS,
    provenance,
    portfolio,
  };
}
