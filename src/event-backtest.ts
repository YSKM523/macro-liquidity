import { isoTimestampMs } from './pit';

export interface EventSignal {
  signalDate: string;
  decisionAt: string;
  tradableAt: string;
  score: number;
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
    const newExposure = candidate.signal.score > 55 ? 1 : 0;
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
