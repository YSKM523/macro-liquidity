/**
 * global-lib.mjs — pure functions for the global liquidity research study.
 *
 * No Date.now(), no Math.random(), no side effects.
 * All exports are testable pure functions.
 *
 * Unit conventions (see buildGlobalLiquidity):
 *   WALCL       : millions USD  → /1000 → billions USD
 *   ECBASSETSW  : millions EUR  × DEXUSEU (USD/EUR) → millions USD → /1000 → billions USD
 *   JPNASSETS   : 億円 (100M JPY units) × 100 → millions JPY → /DEXJPUS (JPY/USD) → millions USD → /1000 → billions USD
 */

// ---------- primitives ----------

/** Mean of numeric array. Returns 0 for empty. */
function mean(xs) {
  if (xs.length === 0) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

/** Clamp to finite, return 0 if NaN/Inf. */
function fin(x) {
  return Number.isFinite(x) ? x : 0;
}

// ---------- rank ----------

/**
 * Average-rank ranking (1-based). Ties get the average of their ranks.
 * @param {number[]} xs
 * @returns {number[]}
 */
export function rank(xs) {
  if (xs.length === 0) return [];
  // Create [(value, original-index)] pairs, sort by value
  const indexed = xs.map((v, i) => ({ v, i }));
  indexed.sort((a, b) => a.v - b.v);

  const ranks = new Array(xs.length);
  let j = 0;
  while (j < indexed.length) {
    // Find the run of equal values
    let k = j;
    while (k < indexed.length && indexed[k].v === indexed[j].v) k++;
    // Average rank for positions j+1 .. k (1-based): (j+1 + k) / 2
    const avgRank = (j + 1 + k) / 2;
    for (let m = j; m < k; m++) {
      ranks[indexed[m].i] = avgRank;
    }
    j = k;
  }
  return ranks;
}

// ---------- pearson ----------

/**
 * Pearson correlation. Returns 0 for n < 3, unequal lengths, or zero std.
 * @param {number[]} xs
 * @param {number[]} ys
 * @returns {number}
 */
export function pearson(xs, ys) {
  if (xs.length !== ys.length || xs.length < 3) return 0;
  const mx = mean(xs), my = mean(ys);
  let num = 0, dx2 = 0, dy2 = 0;
  for (let i = 0; i < xs.length; i++) {
    const dx = xs[i] - mx, dy = ys[i] - my;
    num += dx * dy;
    dx2 += dx * dx;
    dy2 += dy * dy;
  }
  const denom = Math.sqrt(dx2 * dy2);
  if (denom === 0) return 0;
  return fin(num / denom);
}

// ---------- spearman ----------

/**
 * Spearman rank correlation — pearson on the ranked inputs.
 * Inherits all guards from pearson (n<3, unequal length, constant series).
 * @param {number[]} xs
 * @param {number[]} ys
 * @returns {number}
 */
export function spearman(xs, ys) {
  return pearson(rank(xs), rank(ys));
}

// ---------- asOf ----------

/**
 * Forward-fill lookup: series must be sorted ascending by date (ISO strings).
 * Returns the value of the last observation with date <= query date.
 * Returns null if no such observation exists.
 * @param {Array<{date:string, value:number}>} series
 * @param {string} date  ISO date string 'YYYY-MM-DD'
 * @returns {number|null}
 */
export function asOf(series, date) {
  if (series.length === 0) return null;
  // Binary search for the rightmost entry with .date <= date
  let lo = 0, hi = series.length - 1, result = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    if (series[mid].date <= date) {
      result = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return result >= 0 ? series[result].value : null;
}

// ---------- buildGlobalLiquidity ----------

/**
 * Build a weekly global liquidity series (billions USD) aligned to WALCL weekly dates.
 *
 * For each WALCL date t:
 *   fed_B  = WALCL(t) / 1000                                  (million USD → billion USD)
 *   ecb_B  = asOf(ecb, t) × asOf(dexuseu, t) / 1000          (million EUR × USD/EUR → billion USD)
 *   boj_B  = asOf(boj, t) × 100 / asOf(dexjpus, t) / 1000   (億円 × 100 = million JPY → million USD → billion USD)
 *   GL(t)  = fed_B + ecb_B + boj_B
 *
 * Any date where any component is null is skipped.
 *
 * @param {Array<{date:string,value:number}>} walcl   weekly, million USD
 * @param {Array<{date:string,value:number}>} ecb     million EUR
 * @param {Array<{date:string,value:number}>} dexuseu USD per EUR
 * @param {Array<{date:string,value:number}>} boj     億円 (100M JPY units)
 * @param {Array<{date:string,value:number}>} dexjpus JPY per USD
 * @returns {Array<{date:string, gl:number}>}  ascending
 */
export function buildGlobalLiquidity(walcl, ecb, dexuseu, boj, dexjpus) {
  const result = [];
  for (const { date, value: walclVal } of walcl) {
    const ecbVal = asOf(ecb, date);
    const eurusd = asOf(dexuseu, date);
    const bojVal = asOf(boj, date);
    const jpyusd = asOf(dexjpus, date);

    if (
      ecbVal === null || eurusd === null ||
      bojVal === null || jpyusd === null ||
      jpyusd === 0
    ) {
      continue;
    }

    const fed_B = walclVal / 1000;
    const ecb_B = (ecbVal * eurusd) / 1000;
    const boj_B = (bojVal * 100) / jpyusd / 1000;
    result.push({ date, gl: fed_B + ecb_B + boj_B });
  }
  return result;
}

// ---------- pctChangeWeeks ----------

/**
 * Percentage change at a given date vs `weeks` weeks prior.
 * Uses asOf with a lookback of weeks*7 days (calendar days).
 * Returns null if the prior value cannot be found or is zero.
 *
 * @param {Array<{date:string,value:number}>} series  ascending
 * @param {string} date
 * @param {number} weeks
 * @returns {number|null}
 */
export function pctChangeWeeks(series, date, weeks) {
  const curr = asOf(series, date);
  if (curr === null) return null;

  // Compute the prior date: weeks*7 calendar days before
  const priorMs = new Date(date).getTime() - weeks * 7 * 86400000;
  const priorDate = new Date(priorMs).toISOString().slice(0, 10);
  const prior = asOf(series, priorDate);
  if (prior === null || prior === 0) return null;

  return (curr - prior) / prior;
}

// ---------- leadLagIC ----------

/**
 * Lead/lag IC scan.
 *
 * For each GL date t:
 *   x  = GL 13-week growth rate (pctChangeWeeks on gl series by date, growthWeeks back)
 *   y  = SPX return from (t + leadWeeks) to (t + leadWeeks + fwdWeeks)
 *        found via asOf with ±10-day tolerance (we search up to 10 days forward)
 *
 * Returns Spearman IC and sample count n for this lead.
 *
 * @param {Array<{date:string,gl:number}>} gl  ascending
 * @param {Array<{date:string,value:number}>} spxSeries  ascending
 * @param {number} leadWeeks
 * @param {number} [growthWeeks=13]
 * @param {number} [fwdWeeks=13]
 * @returns {{ic:number, n:number}}
 */
export function leadLagIC(gl, spxSeries, leadWeeks, growthWeeks = 13, fwdWeeks = 13) {
  // Build a value series from gl for pctChangeWeeks lookups
  const glValueSeries = gl.map(({ date, gl: v }) => ({ date, value: v }));

  const xs = []; // GL growth rates
  const ys = []; // SPX forward returns

  for (const { date } of gl) {
    // GL growth rate over growthWeeks back
    const glGrowth = pctChangeWeeks(glValueSeries, date, growthWeeks);
    if (glGrowth === null) continue;

    // Target SPX start date: t + leadWeeks*7 days
    const startMs = new Date(date).getTime() + leadWeeks * 7 * 86400000;
    const startDate = new Date(startMs).toISOString().slice(0, 10);

    // Target SPX end date: t + (leadWeeks + fwdWeeks)*7 days
    const endMs = startMs + fwdWeeks * 7 * 86400000;
    const endDate = new Date(endMs).toISOString().slice(0, 10);

    // asOf finds the last SPX value on/before startDate and endDate
    // We also check within ±10 days of the target by searching slightly ahead
    // asOf already forward-fills, so we use the tolerance in the "not too far ahead" sense:
    // We accept the asOf value if its date is within 10 days of target
    const spxStart = asOfWithTolerance(spxSeries, startDate, 10);
    const spxEnd = asOfWithTolerance(spxSeries, endDate, 10);

    if (spxStart === null || spxEnd === null || spxStart === 0) continue;

    xs.push(glGrowth);
    ys.push((spxEnd - spxStart) / spxStart);
  }

  if (xs.length < 3) return { ic: 0, n: xs.length };
  return { ic: spearman(xs, ys), n: xs.length };
}

/**
 * asOf but also checks slightly ahead (up to toleranceDays forward) to handle
 * weekends/holidays near target dates. Returns null if no observation within window.
 *
 * @param {Array<{date:string,value:number}>} series
 * @param {string} targetDate
 * @param {number} toleranceDays
 * @returns {number|null}
 */
function asOfWithTolerance(series, targetDate, toleranceDays) {
  // First try standard asOf (last value on/before targetDate)
  const val = asOf(series, targetDate);
  if (val !== null) {
    // Verify the match is within toleranceDays before targetDate
    // asOf gives us the last entry <= targetDate, which is always ≤ target.
    // We just need to verify it isn't too stale (too far before targetDate).
    const lastIdx = findAsOfIndex(series, targetDate);
    if (lastIdx >= 0) {
      const daysDiff = (new Date(targetDate) - new Date(series[lastIdx].date)) / 86400000;
      if (daysDiff <= toleranceDays) return val;
    }
  }
  // Check slightly ahead: look for a value in [targetDate, targetDate + toleranceDays]
  const aheadMs = new Date(targetDate).getTime() + toleranceDays * 86400000;
  const aheadDate = new Date(aheadMs).toISOString().slice(0, 10);
  const aheadVal = asOf(series, aheadDate);
  if (aheadVal !== null) {
    const aheadIdx = findAsOfIndex(series, aheadDate);
    if (aheadIdx >= 0 && series[aheadIdx].date >= targetDate) {
      return aheadVal;
    }
  }
  return null;
}

/**
 * Find the index returned by asOf (rightmost entry with date <= target).
 * @param {Array<{date:string,value:number}>} series
 * @param {string} date
 * @returns {number} index, or -1 if none
 */
function findAsOfIndex(series, date) {
  let lo = 0, hi = series.length - 1, result = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    if (series[mid].date <= date) {
      result = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return result;
}
