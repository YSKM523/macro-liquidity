/** Deterministic OOS diagnostics for the isolated net-liquidity challenger. */

import { PREREGISTRATION } from './netliq-preregistration.mjs';

const DAY_MS = 86_400_000;

function addDays(date, days) {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

function validateRows(rows, name, valueField) {
  if (!Array.isArray(rows)) throw new Error(`${name} must be an array`);
  let prior = '';
  for (const row of rows) {
    if (typeof row?.date !== 'string' || !Number.isFinite(Date.parse(`${row.date}T00:00:00Z`))) {
      throw new Error(`${name} has an invalid date`);
    }
    if (row.date <= prior) throw new Error(`${name} must be strictly sorted without duplicates`);
    if (!Number.isFinite(row[valueField]) || row[valueField] <= 0) {
      throw new Error(`${name} has an invalid ${valueField}`);
    }
    prior = row.date;
  }
}

function firstAtOrAfter(rows, date) {
  return rows.find(row => row.date >= date);
}

function calendarGapDays(start, end) {
  return (Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / DAY_MS;
}

export function alignForwardReturns(signals, spxRows, horizonWeeks = PREREGISTRATION.target.horizonWeeks) {
  validateRows(spxRows, 'SPX', 'value');
  let prior = '';
  const pairs = [];
  for (const signal of signals) {
    if (signal.availableDate <= prior) throw new Error('signals must be strictly chronological');
    prior = signal.availableDate;
    if (!Number.isFinite(signal.score)) continue;
    const start = firstAtOrAfter(spxRows, signal.availableDate);
    if (!start || calendarGapDays(signal.availableDate, start.date) > 7) continue;
    const targetEnd = addDays(start.date, horizonWeeks * 7);
    const end = firstAtOrAfter(spxRows, targetEnd);
    if (!end || calendarGapDays(targetEnd, end.date) > 7) continue;
    pairs.push({
      observationDate: signal.observationDate,
      availableDate: signal.availableDate,
      startDate: start.date,
      endDate: end.date,
      score: signal.score,
      forwardReturn: end.value / start.value - 1,
    });
  }
  return pairs;
}

function rank(values) {
  const indexed = values.map((value, index) => ({ value, index })).sort((a, b) => a.value - b.value);
  const ranks = Array(values.length);
  for (let start = 0; start < indexed.length;) {
    let end = start + 1;
    while (end < indexed.length && indexed[end].value === indexed[start].value) end += 1;
    const averageRank = (start + 1 + end) / 2;
    for (let cursor = start; cursor < end; cursor += 1) ranks[indexed[cursor].index] = averageRank;
    start = end;
  }
  return ranks;
}

function spearman(pairs) {
  if (pairs.length < 3) return null;
  const x = rank(pairs.map(item => item.score));
  const y = rank(pairs.map(item => item.forwardReturn));
  const xMean = x.reduce((sum, value) => sum + value, 0) / x.length;
  const yMean = y.reduce((sum, value) => sum + value, 0) / y.length;
  let numerator = 0;
  let xSquare = 0;
  let ySquare = 0;
  for (let index = 0; index < x.length; index += 1) {
    const xDiff = x[index] - xMean;
    const yDiff = y[index] - yMean;
    numerator += xDiff * yDiff;
    xSquare += xDiff ** 2;
    ySquare += yDiff ** 2;
  }
  const denominator = Math.sqrt(xSquare * ySquare);
  return denominator === 0 ? null : numerator / denominator;
}

export function nonOverlappingPairs(pairs) {
  const selected = [];
  let priorEnd = '';
  for (const item of pairs) {
    if (item.startDate >= priorEnd) {
      selected.push(item);
      priorEnd = item.endDate;
    }
  }
  return selected;
}

function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(1_664_525, state) + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function quantile(sorted, probability) {
  if (sorted.length === 0) return null;
  const position = (sorted.length - 1) * probability;
  const low = Math.floor(position);
  const high = Math.ceil(position);
  if (low === high) return sorted[low];
  return sorted[low] + (sorted[high] - sorted[low]) * (position - low);
}

export function movingBlockBootstrapIc(pairs, options = {}) {
  const seed = options.seed ?? PREREGISTRATION.bootstrap.seed;
  const blockLength = options.blockLength ?? PREREGISTRATION.bootstrap.blockLength;
  const iterations = options.iterations ?? PREREGISTRATION.bootstrap.iterations;
  if (pairs.length < 3 || iterations <= 0) {
    return { ciLow: null, ciHigh: null, pValue: null, iterations, seed, blockLength };
  }
  const random = seededRandom(seed);
  const estimates = [];
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const sample = [];
    while (sample.length < pairs.length) {
      const start = Math.floor(random() * pairs.length);
      for (let offset = 0; offset < blockLength && sample.length < pairs.length; offset += 1) {
        sample.push(pairs[(start + offset) % pairs.length]);
      }
    }
    const ic = spearman(sample);
    if (ic != null) estimates.push(ic);
  }
  estimates.sort((a, b) => a - b);
  return {
    ciLow: quantile(estimates, 0.025),
    ciHigh: quantile(estimates, 0.975),
    pValue: estimates.length === 0 ? null : estimates.filter(value => value <= 0).length / estimates.length,
    iterations,
    seed,
    blockLength,
  };
}

function summarizeQuintile(rows, quintile) {
  const returns = rows.map(row => row.forwardReturn).sort((a, b) => a - b);
  return {
    quintile,
    count: returns.length,
    mean: returns.length === 0 ? null : returns.reduce((sum, value) => sum + value, 0) / returns.length,
    median: quantile(returns, 0.5),
    negativeProbability: returns.length === 0 ? null : returns.filter(value => value < 0).length / returns.length,
    tail10: quantile(returns, 0.1),
  };
}

function scoreQuintiles(pairs) {
  const sorted = [...pairs].sort((a, b) => a.score - b.score || a.availableDate.localeCompare(b.availableDate));
  return Array.from({ length: 5 }, (_, index) => {
    const start = Math.floor(index * sorted.length / 5);
    const end = Math.floor((index + 1) * sorted.length / 5);
    return summarizeQuintile(sorted.slice(start, end), index + 1);
  });
}

const PREREGISTERED_FOLDS = PREREGISTRATION.folds.ranges;

function expandingFolds(pairs) {
  return PREREGISTERED_FOLDS.map(([rangeStart, rangeEnd], index) => {
    const evaluation = pairs.filter(pair => pair.availableDate >= rangeStart && pair.availableDate < rangeEnd);
    return {
      fold: index + 1,
      trainN: pairs.filter(pair => pair.availableDate < rangeStart).length,
      evaluationN: evaluation.length,
      evaluationStart: rangeStart,
      evaluationEndExclusive: rangeEnd,
      ic: spearman(evaluation),
    };
  });
}

export function evaluateScorePairs(pairs, options = {}) {
  const nonOverlapping = nonOverlappingPairs(pairs);
  const folds = expandingFolds(pairs);
  const finiteFoldIcs = folds.map(fold => fold.ic).filter(Number.isFinite);
  const positiveFoldCount = finiteFoldIcs.filter(value => value > 0).length;
  const negativeFoldCount = finiteFoldIcs.filter(value => value < 0).length;
  return {
    overlapping: { ic: spearman(pairs), n: pairs.length },
    nonOverlapping: { ic: spearman(nonOverlapping), n: nonOverlapping.length },
    bootstrap: movingBlockBootstrapIc(pairs, {
      seed: PREREGISTRATION.bootstrap.seed,
      blockLength: PREREGISTRATION.bootstrap.blockLength,
      iterations: options.bootstrapIterations ?? PREREGISTRATION.bootstrap.iterations,
    }),
    folds,
    positiveFoldCount,
    signStability: finiteFoldIcs.length === 0
      ? null
      : Math.max(positiveFoldCount, negativeFoldCount) / finiteFoldIcs.length,
    quintiles: scoreQuintiles(pairs),
  };
}

export function decideNetLiquidityResearch(report, evidenceClass) {
  if (evidenceClass !== PREREGISTRATION.evidenceClass) {
    throw new Error('PR-11 only accepts RESEARCH_CURRENT_VINTAGE evidence');
  }
  const improves = report.nonOverlapping.ic > 0 && report.positiveFoldCount >= 4;
  const degrades = report.nonOverlapping.ic < 0 && report.positiveFoldCount <= 2;
  const evidenceConclusion = improves ? 'IMPROVES' : degrades ? 'DEGRADES' : 'INCONCLUSIVE';
  const keep = improves
    && report.nonOverlapping.n >= 10
    && report.bootstrap.pValue != null
    && report.bootstrap.pValue <= 0.10
    && report.agreementRate >= 0.50;
  return {
    evidenceConclusion,
    decision: keep ? 'KEEP_SHADOW' : 'DROP_RESEARCH',
    replacementEligible: false,
  };
}

function signalsFor(challenger, selector, predicate = () => true) {
  return challenger
    .filter(predicate)
    .map(row => ({
      observationDate: row.observationDate,
      availableDate: row.availableDate,
      score: selector(row),
    }));
}

function disagreementSummary(pairs) {
  const returns = pairs.map(pair => pair.forwardReturn).sort((a, b) => a - b);
  return {
    count: returns.length,
    meanForwardReturn: returns.length === 0 ? null : returns.reduce((sum, value) => sum + value, 0) / returns.length,
    medianForwardReturn: quantile(returns, 0.5),
    negativeProbability: returns.length === 0 ? null : returns.filter(value => value < 0).length / returns.length,
  };
}

export function evaluateNetLiquidityOos(challenger, spxRows, options = {}) {
  const rawPairs = alignForwardReturns(signalsFor(challenger, row => row.raw.score), spxRows);
  const smoothPairs = alignForwardReturns(signalsFor(challenger, row => row.smooth.score), spxRows);
  const comparablePairs = alignForwardReturns(signalsFor(
    challenger,
    row => (row.raw.score + row.smooth.score) / 2,
    row => Number.isFinite(row.raw.score) && Number.isFinite(row.smooth.score)
      && ['HIGH', 'LOW'].includes(row.agreement.confidence),
  ), spxRows);
  const confidenceByDate = new Map(challenger.map(row => [row.availableDate, row.agreement.confidence]));
  const agreementPairs = comparablePairs.filter(pair => confidenceByDate.get(pair.availableDate) === 'HIGH');
  const disagreementPairs = comparablePairs.filter(pair => confidenceByDate.get(pair.availableDate) === 'LOW');
  const agreementRate = comparablePairs.length === 0 ? null : agreementPairs.length / comparablePairs.length;

  const raw = evaluateScorePairs(rawPairs, options);
  const smooth = evaluateScorePairs(smoothPairs, options);
  const agreementConfirmed = evaluateScorePairs(agreementPairs, options);
  const decision = decideNetLiquidityResearch({ ...agreementConfirmed, agreementRate }, PREREGISTRATION.evidenceClass);
  return {
    evidenceClass: PREREGISTRATION.evidenceClass,
    methodology: {
      direction: 'POSITIVE',
      horizonWeeks: PREREGISTRATION.target.horizonWeeks,
      normalizationCapWeeks: PREREGISTRATION.normalization.capWeeks,
      minimumPriorWeeks: PREREGISTRATION.normalization.minimumPriorWeeks,
      foldCount: PREREGISTRATION.folds.count,
      bootstrapSeed: PREREGISTRATION.bootstrap.seed,
      bootstrapBlockLength: PREREGISTRATION.bootstrap.blockLength,
      fittedParameters: false,
    },
    raw,
    smooth,
    agreementConfirmed,
    agreement: {
      comparableCount: comparablePairs.length,
      confirmedCount: agreementPairs.length,
      disagreementCount: disagreementPairs.length,
      rate: agreementRate,
    },
    disagreement: disagreementSummary(disagreementPairs),
    decision,
  };
}
