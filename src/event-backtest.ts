import { isoTimestampMs } from './pit';
import { EVENT_BACKTEST_ASSUMPTIONS } from './config';

export interface EventSignal {
  signalDate: string;
  decisionAt: string;
  tradableAt: string;
  score: number;
  targetExposure?: number;
}

export interface DailyMarketPrice {
  date: string;
  adjustedClose: number;
  source: string;
}

export interface ScheduledExecution extends EventSignal {
  executionDate: string;
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
}

export interface DailyVix {
  date: string;
  value: number;
  source: string;
}

export interface DailyCashRate {
  date: string;
  rate: number;
  source: string;
}

export interface EventBacktestInputs {
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

export interface EventBacktestResult {
  status: 'OK' | 'DATA_INCOMPLETE';
  reason: string | null;
  nav: EventNavRow[];
  executions: ScheduledExecution[];
  unexecuted: UnexecutedSignal[];
  totals: { totalReturn: number | null; tradingCostRate: number; sessions: number };
  assumptions: typeof EVENT_BACKTEST_ASSUMPTIONS;
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
    const executionAt = `${row.date}T23:59:59Z`;
    return { ...row, executionAt, executionMs: isoTimestampMs(executionAt, 'executionAt') };
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
  for (const candidate of validated) {
    const price = prices.find(row => row.executionMs > candidate.tradableMs);
    if (!price) {
      unexecuted.push({ ...candidate.signal, reason: 'NO_CLOSE_AFTER_TRADABLE_AT' });
      continue;
    }
    const current = selected.get(price.date);
    if (!current || candidate.decisionMs > current.decisionMs ||
      (candidate.decisionMs === current.decisionMs && candidate.index > current.index)) {
      selected.set(price.date, candidate);
    }
  }

  let exposure = 0;
  const executions: ScheduledExecution[] = [];
  for (const price of prices) {
    const candidate = selected.get(price.date);
    if (!candidate) continue;
    const newExposure = candidate.signal.targetExposure ?? (candidate.signal.score > 55 ? 1 : 0);
    executions.push({
      ...candidate.signal,
      executionDate: price.date,
      executionAt: price.executionAt,
      price: price.adjustedClose,
      oldExposure: exposure,
      newExposure,
      source: price.source,
    });
    exposure = newExposure;
  }
  return { executions, unexecuted };
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

function incomplete(
  reason: string,
  nav: EventNavRow[],
  schedule: ExecutionSchedule,
  tradingCost: number,
): EventBacktestResult {
  return {
    status: 'DATA_INCOMPLETE', reason, nav,
    executions: schedule.executions, unexecuted: schedule.unexecuted,
    totals: { totalReturn: null, tradingCostRate: tradingCost, sessions: nav.length },
    assumptions: EVENT_BACKTEST_ASSUMPTIONS,
  };
}

export function runEventTimeBacktest(inputs: EventBacktestInputs): EventBacktestResult {
  const prices = [...inputs.prices].sort((a, b) => a.date.localeCompare(b.date));
  const schedule = scheduleExecutions(inputs.signals, prices);
  const vix = validateDatedSeries(inputs.vix, row => row.value, 'VIX');
  if (vix.some(row => row.value < 0)) throw new Error('invalid VIX value');
  const cashRates = validateDatedSeries(inputs.cashRates, row => row.rate, 'SOFR');
  if (schedule.executions.length === 0) return incomplete('no executable PIT signal', [], schedule, 0);

  const executionByDate = new Map(schedule.executions.map(execution => [execution.executionDate, execution]));
  const firstDate = schedule.executions[0].executionDate;
  const firstIndex = prices.findIndex(row => row.date === firstDate);
  if (firstIndex < 0 || firstIndex >= prices.length - 1) {
    return incomplete('insufficient executable market sessions', [], schedule, 0);
  }
  let navValue = 1;
  let exposure = 0;
  let tradingCost = 0;
  const nav: EventNavRow[] = [];

  for (let index = firstIndex; index < prices.length; index++) {
    const current = prices[index];
    let assetReturn = 0;
    let cashReturn = 0;
    let financingReturn = 0;
    if (index > firstIndex) {
      const previous = prices[index - 1];
      const days = calendarDays(previous.date, current.date);
      const fixing = latestOnOrBefore(cashRates, previous.date);
      if (!fixing) return incomplete(`SOFR missing at ${previous.date}`, nav, schedule, tradingCost);
      if (calendarDays(fixing.date, previous.date) > EVENT_BACKTEST_ASSUMPTIONS.cashRateMaxStaleCalendarDays) {
        return incomplete(`SOFR stale at ${previous.date}`, nav, schedule, tradingCost);
      }
      assetReturn = exposure * (current.adjustedClose / previous.adjustedClose - 1);
      const annualCashRate = fixing.rate / 100;
      if (exposure <= 1) cashReturn = (1 - exposure) * annualCashRate * days / 360;
      else financingReturn = (1 - exposure) *
        (annualCashRate + EVENT_BACKTEST_ASSUMPTIONS.financingSpreadBps / 10_000) * days / 360;
      navValue *= 1 + assetReturn + cashReturn + financingReturn;
    }

    const execution = executionByDate.get(current.date);
    const turnover = execution ? Math.abs(execution.newExposure - exposure) : 0;
    let tradeCost = 0;
    if (execution && turnover > 0) {
      const vixFixing = latestOnOrBefore(vix, current.date);
      const conservativeExtra = !vixFixing ||
        calendarDays(vixFixing.date, current.date) > EVENT_BACKTEST_ASSUMPTIONS.vixMaxStaleCalendarDays ||
        vixFixing.value >= EVENT_BACKTEST_ASSUMPTIONS.vixStressLevel;
      const costBps = EVENT_BACKTEST_ASSUMPTIONS.commissionBps +
        EVENT_BACKTEST_ASSUMPTIONS.baseSlippageBps +
        (conservativeExtra ? EVENT_BACKTEST_ASSUMPTIONS.highVolExtraSlippageBps : 0);
      tradeCost = turnover * costBps / 10_000;
      navValue *= 1 - tradeCost;
      tradingCost += tradeCost;
      exposure = execution.newExposure;
    } else if (execution) {
      exposure = execution.newExposure;
    }
    if (![navValue, exposure, assetReturn, cashReturn, financingReturn, turnover, tradeCost].every(Number.isFinite)) {
      throw new Error('non-finite event-time NAV output');
    }
    nav.push({
      date: current.date, nav: navValue, exposure,
      assetReturn, cashReturn, financingReturn, turnover, tradeCost,
    });
  }

  return {
    status: 'OK', reason: null, nav,
    executions: schedule.executions, unexecuted: schedule.unexecuted,
    totals: { totalReturn: navValue - 1, tradingCostRate: tradingCost, sessions: nav.length },
    assumptions: EVENT_BACKTEST_ASSUMPTIONS,
  };
}
