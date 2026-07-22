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
