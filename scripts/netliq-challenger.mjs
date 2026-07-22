/**
 * Pure, deterministic continuous net-liquidity challenger mechanics.
 *
 * Input units follow the primary FRED CSV files: WALCL/WDTGAL/WTREGEN are
 * millions of dollars; RRPONTSYD is billions of dollars. Output is $B.
 * This research module is intentionally isolated from the production model.
 */

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function epochDay(date) {
  if (!ISO_DATE.test(date)) throw new Error(`invalid ISO date: ${date}`);
  const epoch = Date.parse(`${date}T00:00:00Z`);
  if (!Number.isFinite(epoch) || new Date(epoch).toISOString().slice(0, 10) !== date) {
    throw new Error(`invalid ISO date: ${date}`);
  }
  return epoch;
}

function addDays(date, days) {
  return new Date(epochDay(date) + days * 86_400_000).toISOString().slice(0, 10);
}

function validateSeries(name, rows) {
  if (!Array.isArray(rows)) throw new Error(`${name} must be an array`);
  let previous = '';
  for (const item of rows) {
    epochDay(item?.date);
    if (!Number.isFinite(item?.value)) throw new Error(`${name} contains a non-finite value`);
    if (item.date <= previous) throw new Error(`${name} must be strictly sorted without duplicates`);
    previous = item.date;
  }
}

function latestAtOrBefore(rows, date) {
  let latest;
  for (const item of rows) {
    if (item.date > date) break;
    latest = item;
  }
  return latest;
}

function observationsInWeek(rows, date) {
  const firstDate = addDays(date, -6);
  return rows.filter(item => item.date >= firstDate && item.date <= date);
}

function latestNAtOrBefore(rows, date, count) {
  const visible = rows.filter(item => item.date <= date);
  return visible.length < count ? [] : visible.slice(-count);
}

function mean(rows) {
  return rows.reduce((sum, item) => sum + item.value, 0) / rows.length;
}

export function buildWeeklyNetLiquidity(input) {
  const names = ['WALCL', 'WDTGAL', 'WTREGEN', 'RRPONTSYD'];
  for (const name of names) validateSeries(name, input?.[name]);

  const points = [];
  for (const walcl of input.WALCL) {
    if (new Date(`${walcl.date}T00:00:00Z`).getUTCDay() !== 3) {
      throw new Error(`WALCL anchor must be Wednesday: ${walcl.date}`);
    }
    const wdtgal = latestAtOrBefore(input.WDTGAL, walcl.date);
    const rawRrp = latestAtOrBefore(input.RRPONTSYD, walcl.date);
    const tgaWeek = observationsInWeek(input.WTREGEN, walcl.date);
    const rrpFive = latestNAtOrBefore(input.RRPONTSYD, walcl.date, 5);
    if (!wdtgal || !rawRrp || tgaWeek.length === 0 || rrpFive.length < 5) continue;

    const walclB = walcl.value / 1_000;
    const tgaB = wdtgal.value / 1_000;
    const rrpB = rawRrp.value;
    const tgaWeekAverageB = mean(tgaWeek) / 1_000;
    const rrpSma5B = mean(rrpFive);
    points.push({
      observationDate: walcl.date,
      availableDate: addDays(walcl.date, 2),
      rawLevel: walclB - tgaB - rrpB,
      smoothLevel: walclB - tgaWeekAverageB - rrpSma5B,
      rawComponents: { walclB, tgaB, rrpB },
      smoothComponents: { walclB, tgaWeekAverageB, rrpSma5B },
    });
  }
  return points;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function priorRollingMad(values, index, cap = 156, minimum = 52) {
  if (!Array.isArray(values) || !Number.isInteger(index) || index < 0) return null;
  const window = values
    .slice(Math.max(0, index - cap), index)
    .filter(value => Number.isFinite(value));
  if (window.length < minimum) return null;
  const center = median(window);
  const mad = median(window.map(value => Math.abs(value - center)));
  return Number.isFinite(mad) && mad > 0 ? mad : null;
}

export function scoreLatent({ gap13, impulse4, impulse13 }) {
  if (![gap13, impulse4, impulse13].every(Number.isFinite)) {
    return { latent: null, score: null };
  }
  const latent = 0.45 * gap13 + 0.35 * impulse4 + 0.20 * impulse13;
  return { latent, score: 100 / (1 + Math.exp(-latent)) };
}

function directionOf(latent) {
  if (!Number.isFinite(latent)) return 'MISSING';
  if (latent > 0) return 'UP';
  if (latent < 0) return 'DOWN';
  return 'FLAT';
}

export function classifyAgreement(rawLatent, smoothLatent) {
  const rawDirection = directionOf(rawLatent);
  const smoothDirection = directionOf(smoothLatent);
  if (rawDirection === 'MISSING' || smoothDirection === 'MISSING'
    || rawDirection === 'FLAT' || smoothDirection === 'FLAT') {
    return { direction: 'TRANSITION', confidence: 'TRANSITION' };
  }
  if (rawDirection === smoothDirection) {
    return { direction: rawDirection, confidence: 'HIGH' };
  }
  return { direction: 'TRANSITION', confidence: 'LOW' };
}

function validateWeeklyPoints(points) {
  if (!Array.isArray(points)) throw new Error('weekly points must be an array');
  let previous = '';
  for (const point of points) {
    epochDay(point?.observationDate);
    epochDay(point?.availableDate);
    if (point.observationDate <= previous) {
      throw new Error('weekly points must be strictly sorted without duplicates');
    }
    if (point.availableDate !== addDays(point.observationDate, 2)) {
      throw new Error(`weekly point must become available Friday: ${point.observationDate}`);
    }
    if (!Number.isFinite(point.rawLevel) || !Number.isFinite(point.smoothLevel)) {
      throw new Error('weekly points contain a non-finite level');
    }
    previous = point.observationDate;
  }
}

function deriveTrack(points, levelField) {
  const levels = points.map(point => point[levelField]);
  const gaps = levels.map((level, index) => {
    if (index < 12) return null;
    const window = levels.slice(index - 12, index + 1);
    return level - window.reduce((sum, value) => sum + value, 0) / 13;
  });
  const impulses4 = levels.map((level, index) => index < 4 ? null : level - levels[index - 4]);
  const impulses13 = levels.map((level, index) => index < 13 ? null : level - levels[index - 13]);

  return levels.map((level, index) => {
    const gapMad = priorRollingMad(gaps, index);
    const impulse4Mad = priorRollingMad(impulses4, index);
    const impulse13Mad = priorRollingMad(impulses13, index);
    const normalized = {
      gap13: gapMad == null || gaps[index] == null ? null : gaps[index] / gapMad,
      impulse4: impulse4Mad == null || impulses4[index] == null ? null : impulses4[index] / impulse4Mad,
      impulse13: impulse13Mad == null || impulses13[index] == null ? null : impulses13[index] / impulse13Mad,
    };
    const scored = scoreLatent(normalized);
    const sma13 = index < 12 ? null : level - gaps[index];
    return {
      level,
      change1w: index < 1 ? null : level - levels[index - 1],
      impulse4: impulses4[index],
      trend13: impulses13[index],
      gapToSma13Pct: sma13 == null || sma13 === 0 ? null : gaps[index] / Math.abs(sma13) * 100,
      acceleration: index < 5 ? null : impulses4[index] - impulses4[index - 1],
      normalized,
      latent: scored.latent,
      score: scored.score,
      direction: directionOf(scored.latent),
    };
  });
}

export function buildContinuousChallenger(points) {
  validateWeeklyPoints(points);
  const raw = deriveTrack(points, 'rawLevel');
  const smooth = deriveTrack(points, 'smoothLevel');
  return points.map((point, index) => ({
    observationDate: point.observationDate,
    availableDate: point.availableDate,
    raw: raw[index],
    smooth: smooth[index],
    agreement: classifyAgreement(raw[index].latent, smooth[index].latent),
  }));
}
