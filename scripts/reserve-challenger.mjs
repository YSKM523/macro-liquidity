import { PREREGISTRATION } from './reserve-preregistration.mjs';

const DAY_MS = 86_400_000;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const INPUTS = ['WRESBAL', 'GDP', 'SOFR', 'IORB', 'EFFR', 'TGCRRATE', 'NYFED_SRF_ACCEPTED'];

function epoch(date) {
  if (!ISO_DATE.test(date ?? '')) throw new Error(`invalid ISO date: ${date}`);
  const value = Date.parse(`${date}T00:00:00Z`);
  if (!Number.isFinite(value) || new Date(value).toISOString().slice(0, 10) !== date) throw new Error(`invalid ISO date: ${date}`);
  return value;
}

function ageDays(older, newer) {
  return (epoch(newer) - epoch(older)) / DAY_MS;
}

function addDays(date, days) {
  return new Date(epoch(date) + days * DAY_MS).toISOString().slice(0, 10);
}

function validateSeries(name, rows) {
  if (!Array.isArray(rows)) throw new Error(`${name} must be an array`);
  let prior = '';
  for (const row of rows) {
    epoch(row?.date);
    if (row.date <= prior) throw new Error(`${name} must be strictly sorted without duplicates`);
    if (!Number.isFinite(row.value)) throw new Error(`${name} contains a non-finite value`);
    prior = row.date;
  }
}

function latestAtOrBefore(rows, date) {
  let result;
  for (const row of rows) {
    if (row.date > date) break;
    result = row;
  }
  return result;
}

function inTrailingWeek(rows, anchorDate) {
  const start = addDays(anchorDate, -6);
  return rows.filter(row => row.date >= start && row.date <= anchorDate);
}

function quantile(values, probability) {
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const position = (sorted.length - 1) * probability;
  const low = Math.floor(position);
  const high = Math.ceil(position);
  return low === high ? sorted[low] : sorted[low] + (sorted[high] - sorted[low]) * (position - low);
}

function pairedSpreads(rateRows, iorbRows, anchorDate) {
  const iorb = new Map(inTrailingWeek(iorbRows, anchorDate).map(row => [row.date, row.value]));
  return inTrailingWeek(rateRows, anchorDate)
    .filter(row => iorb.has(row.date))
    .map(row => ({ date: row.date, value: Math.round((row.value - iorb.get(row.date)) * 100 * 1e12) / 1e12 }));
}

function rateStatus(pairs, anchorDate, prefix) {
  if (pairs.length < PREREGISTRATION.freshness.pairedRateMinimum) return `${prefix}INSUFFICIENT_PAIRS`;
  const age = ageDays(pairs.at(-1).date, anchorDate);
  return age > PREREGISTRATION.freshness.pairedRateMaximumAge ? `${prefix}STALE` : 'OK';
}

function buildRelative(input, anchorDate) {
  const reserve = latestAtOrBefore(input.WRESBAL, anchorDate);
  const gdp = latestAtOrBefore(input.GDP, anchorDate);
  const reserveAgeDays = reserve ? ageDays(reserve.date, anchorDate) : null;
  const gdpAgeDays = gdp ? ageDays(gdp.date, anchorDate) : null;
  const status = !reserve || !gdp ? 'MISSING'
    : reserveAgeDays > PREREGISTRATION.freshness.WRESBAL ? 'STALE_WRESBAL'
      : gdpAgeDays > PREREGISTRATION.freshness.GDP ? 'STALE_GDP' : 'OK';
  const reserveB = reserve ? reserve.value / 1_000 : null;
  return {
    status, reserveAsOf: reserve?.date ?? null, reserveAgeDays,
    gdpAsOf: gdp?.date ?? null, gdpAgeDays,
    reserveB, gdpB: gdp?.value ?? null,
    value: status === 'OK' ? reserveB / gdp.value * 100 : null,
  };
}

function buildChange(input, anchorDate, relative) {
  const priorBound = addDays(anchorDate, -91);
  const prior = latestAtOrBefore(input.WRESBAL, priorBound);
  const status = relative.status !== 'OK' ? 'CURRENT_INCOMPLETE' : !prior ? 'MISSING_PRIOR' : 'OK';
  return {
    status,
    currentAsOf: relative.reserveAsOf,
    priorAsOf: prior?.date ?? null,
    horizonCalendarDays: 91,
    value: status === 'OK' ? relative.reserveB - prior.value / 1_000 : null,
  };
}

function buildSofr(input, anchorDate) {
  const pairs = pairedSpreads(input.SOFR, input.IORB, anchorDate);
  const status = rateStatus(pairs, anchorDate, '');
  return {
    status, pairCount: pairs.length,
    firstPairDate: pairs[0]?.date ?? null, latestPairDate: pairs.at(-1)?.date ?? null,
    ageDays: pairs.length ? ageDays(pairs.at(-1).date, anchorDate) : null,
    medianBps: status === 'OK' ? quantile(pairs.map(row => row.value), 0.5) : null,
    p95Bps: status === 'OK' ? quantile(pairs.map(row => row.value), 0.95) : null,
  };
}

function buildAuxiliary(input, anchorDate) {
  const effr = pairedSpreads(input.EFFR, input.IORB, anchorDate);
  const tgcr = pairedSpreads(input.TGCRRATE, input.IORB, anchorDate);
  const srf = inTrailingWeek(input.NYFED_SRF_ACCEPTED, anchorDate);
  const effrStatus = rateStatus(effr, anchorDate, 'EFFR_');
  const tgcrStatus = rateStatus(tgcr, anchorDate, 'TGCR_');
  const srfAge = srf.length ? ageDays(srf.at(-1).date, anchorDate) : null;
  const srfStatus = srf.length < PREREGISTRATION.freshness.SRFMinimum ? 'MISSING_SRF'
    : srfAge > PREREGISTRATION.freshness.SRFMaximumAge ? 'STALE_SRF' : 'OK';
  const status = effrStatus !== 'OK' ? effrStatus : tgcrStatus !== 'OK' ? tgcrStatus : srfStatus;
  return {
    status,
    effrPairCount: effr.length, tgcrPairCount: tgcr.length, srfCount: srf.length,
    latestEffrPairDate: effr.at(-1)?.date ?? null,
    latestTgcrPairDate: tgcr.at(-1)?.date ?? null,
    latestSrfDate: srf.at(-1)?.date ?? null,
    effrAgeDays: effr.length ? ageDays(effr.at(-1).date, anchorDate) : null,
    tgcrAgeDays: tgcr.length ? ageDays(tgcr.at(-1).date, anchorDate) : null,
    srfAgeDays: srfAge,
    effrMedianBps: effrStatus === 'OK' ? quantile(effr.map(row => row.value), 0.5) : null,
    tgcrMedianBps: tgcrStatus === 'OK' ? quantile(tgcr.map(row => row.value), 0.5) : null,
    srfMaxB: srfStatus === 'OK' ? Math.max(...srf.map(row => row.value)) : null,
  };
}

export function buildWeeklyReserveFeatures(input, anchorDates) {
  for (const name of INPUTS) validateSeries(name, input?.[name]);
  if (!Array.isArray(anchorDates)) throw new Error('anchorDates must be an array');
  let prior = '';
  return anchorDates.map(anchorDate => {
    epoch(anchorDate);
    if (new Date(`${anchorDate}T00:00:00Z`).getUTCDay() !== 5) throw new Error(`anchor must be Friday: ${anchorDate}`);
    if (anchorDate <= prior) throw new Error('anchors must be strictly sorted without duplicates');
    prior = anchorDate;
    const relativeReserves = buildRelative(input, anchorDate);
    const reserveChange13 = buildChange(input, anchorDate, relativeReserves);
    const sofrIorb = buildSofr(input, anchorDate);
    const auxiliaryFunding = buildAuxiliary(input, anchorDate);
    const decisionStatus = [relativeReserves, reserveChange13, sofrIorb, auxiliaryFunding].every(component => component.status === 'OK') ? 'OK' : 'DATA_INCOMPLETE';
    return {
      anchorDate, decisionStatus, relativeReserves, reserveChange13, sofrIorb, auxiliaryFunding,
      provenance: {
        evidenceClass: PREREGISTRATION.evidenceClass,
        source: PREREGISTRATION.source,
        methodologyVersion: PREREGISTRATION.methodologyVersion,
        replacementEligible: false,
      },
    };
  });
}

export function strictlyPriorPercentile(history, current) {
  if (!Array.isArray(history) || history.length === 0 || !Number.isFinite(current) || !history.every(Number.isFinite)) return null;
  const below = history.filter(value => value < current).length;
  const equal = history.filter(value => value === current).length;
  return (below + equal * 0.5) / history.length * 100;
}

export function classifyReserveState(score) {
  if (!Number.isFinite(score)) return 'UNKNOWN';
  if (score >= PREREGISTRATION.states.abundant) return 'ABUNDANT';
  if (score >= PREREGISTRATION.states.ample) return 'AMPLE';
  if (score >= PREREGISTRATION.states.transition) return 'TRANSITION';
  if (score >= PREREGISTRATION.states.scarce) return 'SCARCE';
  return 'STRESSED';
}

function rawValues(feature) {
  return {
    relativeReserves: feature.relativeReserves.value,
    reserveChange13: feature.reserveChange13.value,
    sofrMedian: feature.sofrIorb.medianBps,
    sofrP95: feature.sofrIorb.p95Bps,
    effrMedian: feature.auxiliaryFunding.effrMedianBps,
    tgcrMedian: feature.auxiliaryFunding.tgcrMedianBps,
    srfMax: feature.auxiliaryFunding.srfMaxB,
  };
}

function complete(feature) {
  return feature.decisionStatus === 'OK' && Object.values(rawValues(feature)).every(Number.isFinite);
}

export function scoreReserveFeatures(features) {
  if (!Array.isArray(features)) throw new Error('features must be an array');
  const history = [];
  let priorDate = '';
  return features.map(feature => {
    epoch(feature?.anchorDate);
    if (feature.anchorDate <= priorDate) throw new Error('features must be strictly chronological');
    priorDate = feature.anchorDate;
    const priorCompleteWeeks = history.length;
    let components = null;
    let score = null;
    if (complete(feature) && history.length >= PREREGISTRATION.minimumPriorWeeks) {
      const current = rawValues(feature);
      const prior = key => history.map(row => row[key]);
      components = {
        relativeReserves: strictlyPriorPercentile(prior('relativeReserves'), current.relativeReserves),
        reserveChange13: strictlyPriorPercentile(prior('reserveChange13'), current.reserveChange13),
        sofrIorb: 100 - (strictlyPriorPercentile(prior('sofrMedian'), current.sofrMedian) + strictlyPriorPercentile(prior('sofrP95'), current.sofrP95)) / 2,
        auxiliaryFunding: 100 - (strictlyPriorPercentile(prior('effrMedian'), current.effrMedian) + strictlyPriorPercentile(prior('tgcrMedian'), current.tgcrMedian) + strictlyPriorPercentile(prior('srfMax'), current.srfMax)) / 3,
      };
      const weights = PREREGISTRATION.weights;
      score = weights.relativeReserves * components.relativeReserves
        + weights.reserveChange13 * components.reserveChange13
        + weights.sofrIorb * components.sofrIorb
        + weights.auxiliaryFunding * components.auxiliaryFunding;
    }
    const result = { ...feature, priorCompleteWeeks, components, score, state: classifyReserveState(score) };
    if (complete(feature)) history.push(rawValues(feature));
    return result;
  });
}
