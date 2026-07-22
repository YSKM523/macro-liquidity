import { PREREGISTRATION } from './reserve-preregistration.mjs';

const DAY_MS = 86_400_000;

function addDays(date, days) {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

function gapDays(start, end) {
  return (Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / DAY_MS;
}

function validatePrices(rows) {
  if (!Array.isArray(rows)) throw new Error('SPX must be an array');
  let prior = '';
  for (const row of rows) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(row?.date ?? '') || !Number.isFinite(Date.parse(`${row.date}T00:00:00Z`))) throw new Error('SPX date is invalid');
    if (row.date <= prior) throw new Error('SPX must be strictly sorted without duplicates');
    if (!Number.isFinite(row.value) || row.value <= 0) throw new Error('SPX value must be positive and finite');
    prior = row.date;
  }
}

function firstAtOrAfter(rows, date) {
  return rows.find(row => row.date >= date);
}

export function alignReserveForwardReturns(signals, spxRows) {
  validatePrices(spxRows);
  let prior = '';
  const pairs = [];
  for (const signal of signals) {
    if (signal.anchorDate <= prior) throw new Error('signals must be strictly chronological');
    prior = signal.anchorDate;
    if (new Date(`${signal.anchorDate}T00:00:00Z`).getUTCDay() !== 5) throw new Error('signal anchor must be Friday');
    if (!Number.isFinite(signal.score)) continue;
    const nominalEntry = addDays(signal.anchorDate, 3);
    const entry = firstAtOrAfter(spxRows, nominalEntry);
    if (!entry || gapDays(nominalEntry, entry.date) > PREREGISTRATION.target.maximumMatchGapDays) continue;
    const nominalEnd = addDays(entry.date, PREREGISTRATION.target.horizonCalendarDays);
    const end = firstAtOrAfter(spxRows, nominalEnd);
    if (!end || gapDays(nominalEnd, end.date) > PREREGISTRATION.target.maximumMatchGapDays) continue;
    pairs.push({
      anchorDate: signal.anchorDate,
      entryDate: entry.date,
      endDate: end.date,
      score: signal.score,
      state: signal.state,
      forwardReturn: Math.round((end.value / entry.value - 1) * 1e12) / 1e12,
    });
  }
  return pairs;
}

function rank(values) {
  const sorted = values.map((value, index) => ({ value, index })).sort((a, b) => a.value - b.value);
  const ranks = Array(values.length);
  for (let start = 0; start < sorted.length;) {
    let end = start + 1;
    while (end < sorted.length && sorted[end].value === sorted[start].value) end += 1;
    const average = (start + 1 + end) / 2;
    for (let cursor = start; cursor < end; cursor += 1) ranks[sorted[cursor].index] = average;
    start = end;
  }
  return ranks;
}

function spearman(pairs) {
  if (pairs.length < 3) return null;
  const x = rank(pairs.map(row => row.score));
  const y = rank(pairs.map(row => row.forwardReturn));
  const xm = x.reduce((sum, value) => sum + value, 0) / x.length;
  const ym = y.reduce((sum, value) => sum + value, 0) / y.length;
  let numerator = 0;
  let xx = 0;
  let yy = 0;
  for (let index = 0; index < x.length; index += 1) {
    const xd = x[index] - xm;
    const yd = y[index] - ym;
    numerator += xd * yd;
    xx += xd ** 2;
    yy += yd ** 2;
  }
  const denominator = Math.sqrt(xx * yy);
  return denominator === 0 ? null : numerator / denominator;
}

export function nonOverlappingPairs(pairs) {
  const selected = [];
  let priorEnd = '';
  for (const pair of pairs) {
    if (pair.entryDate >= priorEnd) {
      selected.push(pair);
      priorEnd = pair.endDate;
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
  return low === high ? sorted[low] : sorted[low] + (sorted[high] - sorted[low]) * (position - low);
}

export function movingBlockBootstrapIc(pairs, options = {}) {
  const seed = options.seed ?? PREREGISTRATION.bootstrap.seed;
  const blockLength = options.blockLength ?? PREREGISTRATION.bootstrap.blockLength;
  const iterations = options.iterations ?? PREREGISTRATION.bootstrap.iterations;
  if (pairs.length < 3 || iterations <= 0) return { ciLow: null, ciHigh: null, pValue: null, seed, blockLength, iterations };
  const random = seededRandom(seed);
  const estimates = [];
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const sample = [];
    while (sample.length < pairs.length) {
      const start = Math.floor(random() * pairs.length);
      for (let offset = 0; offset < blockLength && sample.length < pairs.length; offset += 1) sample.push(pairs[(start + offset) % pairs.length]);
    }
    const ic = spearman(sample);
    if (ic != null) estimates.push(ic);
  }
  estimates.sort((a, b) => a - b);
  return {
    ciLow: quantile(estimates, 0.025), ciHigh: quantile(estimates, 0.975),
    pValue: estimates.length ? estimates.filter(value => value <= 0).length / estimates.length : null,
    seed, blockLength, iterations,
  };
}

function summarize(rows, quintile) {
  const values = rows.map(row => row.forwardReturn).sort((a, b) => a - b);
  return {
    quintile, count: values.length,
    mean: values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null,
    median: quantile(values, 0.5),
    negativeProbability: values.length ? values.filter(value => value < 0).length / values.length : null,
    tail10: quantile(values, 0.1),
  };
}

function quintiles(pairs) {
  const sorted = [...pairs].sort((a, b) => a.score - b.score || a.entryDate.localeCompare(b.entryDate));
  return Array.from({ length: 5 }, (_, index) => summarize(
    sorted.slice(Math.floor(index * sorted.length / 5), Math.floor((index + 1) * sorted.length / 5)), index + 1,
  ));
}

function folds(pairs) {
  const boundaries = PREREGISTRATION.folds.boundaries;
  return boundaries.slice(0, -1).map((start, index) => {
    const end = boundaries[index + 1];
    const evaluation = pairs.filter(pair => pair.anchorDate >= start && pair.anchorDate < end);
    return {
      fold: index + 1, evaluationStart: start, evaluationEndExclusive: end,
      trainN: pairs.filter(pair => pair.endDate <= start).length,
      evaluationN: evaluation.length, ic: spearman(evaluation),
    };
  });
}

export function decideReserveResearch(report, evidenceClass) {
  if (evidenceClass !== PREREGISTRATION.evidenceClass) throw new Error('PR-12 only accepts RESEARCH_CURRENT_VINTAGE evidence');
  const keep = report.nonOverlapping.ic > 0
    && report.nonOverlapping.n >= 10
    && report.positiveFoldCount >= 4
    && report.bootstrap.pValue != null && report.bootstrap.pValue <= 0.10
    && report.monotonicity.topNoWorseMean && report.monotonicity.topNoWorseTail10;
  return { decision: keep ? 'KEEP_SHADOW' : 'DROP_RESEARCH', replacementEligible: false };
}

export function evaluateReserveOos(signals, spxRows, options = {}) {
  const pairs = alignReserveForwardReturns(signals, spxRows);
  const nonOverlapping = nonOverlappingPairs(pairs);
  const foldRows = folds(pairs);
  const buckets = quintiles(pairs);
  const first = buckets[0];
  const top = buckets[4];
  const monotonicity = {
    adjacentMeanNonDecreasing: buckets.every((bucket, index) => index === 0 || bucket.mean == null || buckets[index - 1].mean == null || bucket.mean >= buckets[index - 1].mean),
    adjacentMeanViolations: buckets.slice(1).filter((bucket, index) => bucket.mean != null && buckets[index].mean != null && bucket.mean < buckets[index].mean).length,
    topNoWorseMean: top.mean != null && first.mean != null && top.mean >= first.mean,
    topNoWorseTail10: top.tail10 != null && first.tail10 != null && top.tail10 >= first.tail10,
  };
  const report = {
    evidenceClass: PREREGISTRATION.evidenceClass,
    overlapping: { ic: spearman(pairs), n: pairs.length },
    nonOverlapping: { ic: spearman(nonOverlapping), n: nonOverlapping.length },
    bootstrap: movingBlockBootstrapIc(pairs, { iterations: options.bootstrapIterations ?? PREREGISTRATION.bootstrap.iterations }),
    folds: foldRows,
    positiveFoldCount: foldRows.filter(fold => fold.ic != null && fold.ic > 0).length,
    scoreCounts: { total: signals.length, scored: signals.filter(signal => Number.isFinite(signal.score)).length, aligned: pairs.length },
    stateCounts: signals.reduce((counts, signal) => ({ ...counts, [signal.state]: (counts[signal.state] ?? 0) + 1 }), {}),
    quintiles: buckets,
    monotonicity,
  };
  return { ...report, decision: decideReserveResearch(report, PREREGISTRATION.evidenceClass) };
}
