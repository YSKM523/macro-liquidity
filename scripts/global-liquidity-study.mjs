/**
 * global-liquidity-study.mjs
 *
 * Offline research script: does FX-adjusted global liquidity (Fed + ECB + BOJ)
 * lead the S&P 500, by how many weeks, and is it stable across regimes?
 *
 * Usage:
 *   FRED_API_KEY=<key> node scripts/global-liquidity-study.mjs
 *
 * Data sources:
 *   FRED: WALCL, ECBASSETSW, JPNASSETS, DEXUSEU, DEXJPUS
 *   Yahoo Finance: weekly S&P 500 (/^GSPC)
 *
 * Unit conventions (see global-lib.mjs):
 *   WALCL      : millions USD
 *   ECBASSETSW : millions EUR (× DEXUSEU = USD/EUR → millions USD → /1000 → billions USD)
 *   JPNASSETS  : 億円 (100M JPY) × 100 = millions JPY → /DEXJPUS (JPY/USD) → millions USD → /1000 → billions USD
 */

import {
  buildGlobalLiquidity,
  buildGlobalGrowthLC,
  asOf,
  pctChangeWeeks,
  leadLagIC,
  leadLagICSignal,
  spearman,
} from './global-lib.mjs';

// ---------- FRED fetch ----------

/**
 * Fetch a FRED series and return [{date:'YYYY-MM-DD', value:Number}] ascending.
 * Drops observations with value "." (missing).
 */
async function fetchFred(id, start = '2002-01-01') {
  const key = process.env.FRED_API_KEY;
  if (!key) throw new Error('FRED_API_KEY environment variable is not set.');

  const url =
    `https://api.stlouisfed.org/fred/series/observations` +
    `?series_id=${id}` +
    `&api_key=${key}` +
    `&file_type=json` +
    `&observation_start=${start}`;

  const resp = await fetch(url);
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`FRED fetch failed for ${id}: HTTP ${resp.status} — ${text.slice(0, 200)}`);
  }
  const json = await resp.json();
  if (!json.observations) throw new Error(`FRED response missing observations for ${id}`);

  return json.observations
    .filter((o) => o.value !== '.')
    .map((o) => ({ date: o.date, value: Number(o.value) }))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

// ---------- Yahoo Finance weekly SPX ----------

/**
 * Fetch Yahoo Finance weekly S&P 500 history.
 * Returns [{date:'YYYY-MM-DD', value:Number}] ascending (closing prices).
 */
async function fetchYahooWeeklySPX() {
  const url =
    'https://query1.finance.yahoo.com/v8/finance/chart/%5EGSPC?interval=1wk&range=max';

  const resp = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0' },
  });
  if (!resp.ok) {
    throw new Error(`Yahoo Finance fetch failed: HTTP ${resp.status}`);
  }
  const json = await resp.json();

  const timestamps = json?.chart?.result?.[0]?.timestamp;
  const closes = json?.chart?.result?.[0]?.indicators?.quote?.[0]?.close;

  if (!timestamps || !closes) {
    throw new Error('Yahoo Finance response missing timestamp or close data');
  }

  const result = [];
  for (let i = 0; i < timestamps.length; i++) {
    if (closes[i] == null) continue;
    const d = new Date(timestamps[i] * 1000);
    const date = d.toISOString().slice(0, 10);
    result.push({ date, value: closes[i] });
  }
  result.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return result;
}

// ---------- helpers ----------

function fmt(n, decimals = 2) {
  if (n == null || !Number.isFinite(n)) return 'N/A';
  return n.toFixed(decimals);
}

function pct(n) {
  if (n == null || !Number.isFinite(n)) return 'N/A';
  return (n * 100).toFixed(1) + '%';
}

/** Filter a GL series to dates within [startYear, endYear] inclusive. */
function filterGLByYear(gl, startYear, endYear) {
  return gl.filter((p) => {
    const y = parseInt(p.date.slice(0, 4), 10);
    return y >= startYear && y <= endYear;
  });
}

// ---------- main ----------

async function main() {
  console.log('='.repeat(70));
  console.log('  GLOBAL LIQUIDITY STUDY: Fed + ECB + BOJ vs S&P 500 (~2002–2026)');
  console.log('='.repeat(70));
  console.log();

  // 1. Fetch data
  console.log('Fetching FRED series (WALCL, ECBASSETSW, JPNASSETS, DEXUSEU, DEXJPUS)...');
  let walcl, ecb, dexuseu, boj, dexjpus, spx;
  try {
    // order MUST match the fetch list below: WALCL, ECBASSETSW, JPNASSETS, DEXUSEU, DEXJPUS, SPX
    [walcl, ecb, boj, dexuseu, dexjpus, spx] = await Promise.all([
      fetchFred('WALCL', '2002-01-01'),
      fetchFred('ECBASSETSW', '2002-01-01'),
      fetchFred('JPNASSETS', '2002-01-01'),
      fetchFred('DEXUSEU', '2002-01-01'),
      fetchFred('DEXJPUS', '2002-01-01'),
      fetchYahooWeeklySPX(),
    ]);
  } catch (err) {
    console.error('FATAL: data fetch failed —', err.message);
    process.exit(1);
  }

  console.log(`  WALCL      : ${walcl.length} obs  [${walcl[0]?.date} → ${walcl.at(-1)?.date}]`);
  console.log(`  ECBASSETSW : ${ecb.length} obs  [${ecb[0]?.date} → ${ecb.at(-1)?.date}]`);
  console.log(`  JPNASSETS  : ${boj.length} obs  [${boj[0]?.date} → ${boj.at(-1)?.date}]`);
  console.log(`  DEXUSEU    : ${dexuseu.length} obs  [${dexuseu[0]?.date} → ${dexuseu.at(-1)?.date}]`);
  console.log(`  DEXJPUS    : ${dexjpus.length} obs  [${dexjpus[0]?.date} → ${dexjpus.at(-1)?.date}]`);
  console.log(`  SPX (Yahoo): ${spx.length} obs  [${spx[0]?.date} → ${spx.at(-1)?.date}]`);
  console.log();

  // 2. Build global liquidity series
  const gl = buildGlobalLiquidity(walcl, ecb, dexuseu, boj, dexjpus);

  if (gl.length === 0) {
    console.error('FATAL: buildGlobalLiquidity returned 0 points. Check data overlap.');
    process.exit(1);
  }

  // Latest composition
  const latest = gl.at(-1);
  const latestDate = latest.date;
  const fedBil = asOf(walcl, latestDate) / 1000;
  const ecbEur = asOf(ecb, latestDate);
  const eurusd = asOf(dexuseu, latestDate);
  const ecbBil = (ecbEur * eurusd) / 1000;
  const bojUnits = asOf(boj, latestDate);
  const jpyusd = asOf(dexjpus, latestDate);
  const bojBil = (bojUnits * 100) / jpyusd / 1000;
  const totalBil = latest.gl;

  console.log('── 2. GLOBAL LIQUIDITY SERIES ──────────────────────────────────────');
  console.log(`  Coverage : ${gl[0].date} → ${latestDate}`);
  console.log(`  Points   : ${gl.length} weekly observations`);
  console.log(`  Latest GL: $${fmt(totalBil / 1000, 2)}T (${latestDate})`);
  console.log(`  Breakdown:`);
  console.log(`    Fed (WALCL)  : $${fmt(fedBil / 1000, 2)}T  (${pct(fedBil / totalBil)})`);
  console.log(`    ECB          : $${fmt(ecbBil / 1000, 2)}T  (${pct(ecbBil / totalBil)})`);
  console.log(`    BOJ          : $${fmt(bojBil / 1000, 2)}T  (${pct(bojBil / totalBil)})`);
  console.log();

  console.log('── SPX COVERAGE ─────────────────────────────────────────────────────');
  console.log(`  SPX series : ${spx[0]?.date} → ${spx.at(-1)?.date}`);
  if (spx.length > 0 && parseInt(spx[0].date.slice(0, 4), 10) > 2003) {
    console.log('  WARNING: SPX history starts after 2002. Research window narrowed accordingly.');
  } else {
    console.log('  SPX history covers full study window (2002–2026). No truncation needed.');
  }
  console.log();

  // 3. Lead/lag scan: lead = 0, 2, 4, ..., 26 weeks
  console.log('── 3. LEAD/LAG SCAN (GL 13-week growth vs SPX 13-week forward return) ──');
  console.log('  (Higher IC = global liquidity growth better predicts SPX at that lead)');
  console.log();
  console.log('  lead (wk)  |  Spearman IC  |  n pairs');
  console.log('  -----------|---------------|----------');

  const leads = [0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22, 24, 26];
  const scanResults = [];
  for (const lead of leads) {
    const { ic, n } = leadLagIC(gl, spx, lead);
    scanResults.push({ lead, ic, n });
    const marker = '';
    console.log(`  ${String(lead).padStart(9)}  |  ${fmt(ic, 4).padStart(13)}  |  ${String(n).padStart(8)}  ${marker}`);
  }

  // Find best lead
  const best = scanResults.reduce((a, b) => (b.ic > a.ic ? b : a));
  console.log();
  console.log(`  *** Best lead: ${best.lead} weeks (IC = ${fmt(best.ic, 4)}, n = ${best.n})`);
  console.log();

  // 4. Sub-period (regime) analysis
  console.log('── 4. REGIME ANALYSIS ───────────────────────────────────────────────');
  console.log('  (IC of GL 13-week growth vs synchronous 13-week forward SPX return)');
  console.log();

  const periods = [
    { label: 'GFC era   (2002–2009)', startY: 2002, endY: 2009 },
    { label: 'QE cycle  (2010–2019)', startY: 2010, endY: 2019 },
    { label: 'COVID/QT  (2020–2026)', startY: 2020, endY: 2026 },
  ];

  // Function to compute IC for a filtered GL series (same SPX)
  function regimeIC(glFiltered, lead) {
    return leadLagIC(glFiltered, spx, lead);
  }

  console.log('  Period               |  lead=0 IC  |  n  |  best-lead IC  |  n');
  console.log('  ---------------------|-------------|-----|----------------|-----');
  for (const { label, startY, endY } of periods) {
    const glSlice = filterGLByYear(gl, startY, endY);
    const r0 = regimeIC(glSlice, 0);
    const rBest = regimeIC(glSlice, best.lead);
    console.log(
      `  ${label.padEnd(21)}|  ${fmt(r0.ic, 4).padStart(11)}  |  ${String(r0.n).padStart(3)}  |  ${fmt(rBest.ic, 4).padStart(14)}  |  ${String(rBest.n).padStart(3)}`
    );
  }
  console.log();

  // 5. Comparison: Global (Fed+ECB+BOJ) vs Fed-only
  console.log('── 5. GLOBAL vs FED-ONLY COMPARISON ────────────────────────────────');

  // Build Fed-only series (same dates as GL, just WALCL/1000)
  const fedOnly = gl.map(({ date }) => ({
    date,
    gl: asOf(walcl, date) / 1000,
  }));

  console.log('  (All ICs at best global lead = ' + best.lead + ' weeks)');
  console.log();
  console.log('  Metric         |  Global GL  |  Fed-only');
  console.log('  ---------------|-------------|----------');

  const globalFull = leadLagIC(gl, spx, best.lead);
  const fedFull = leadLagIC(fedOnly, spx, best.lead);
  console.log(`  Full-period IC |  ${fmt(globalFull.ic, 4).padStart(11)}  |  ${fmt(fedFull.ic, 4).padStart(9)}`);
  console.log(`  n pairs        |  ${String(globalFull.n).padStart(11)}  |  ${String(fedFull.n).padStart(9)}`);
  console.log();

  // Per-regime comparison
  console.log('  Per-regime IC at lead=' + best.lead + ' weeks:');
  console.log('  Period               |  Global IC  |  Fed-only IC');
  console.log('  ---------------------|-------------|-------------');
  for (const { label, startY, endY } of periods) {
    const glSlice = filterGLByYear(gl, startY, endY);
    const fedSlice = filterGLByYear(fedOnly, startY, endY);
    const rG = leadLagIC(glSlice, spx, best.lead);
    const rF = leadLagIC(fedSlice, spx, best.lead);
    console.log(
      `  ${label.padEnd(21)}|  ${fmt(rG.ic, 4).padStart(11)}  |  ${fmt(rF.ic, 4).padStart(12)}`
    );
  }
  console.log();

  // 6. Honest summary
  console.log('── 6. HONEST SUMMARY ────────────────────────────────────────────────');
  console.log();

  const icMagnitude =
    Math.abs(globalFull.ic) < 0.10
      ? 'very weak (<0.10)'
      : Math.abs(globalFull.ic) < 0.25
        ? 'weak (0.10–0.25)'
        : Math.abs(globalFull.ic) < 0.40
          ? 'moderate (0.25–0.40)'
          : 'strong (>0.40)';

  console.log(`  Global liquidity (Fed+ECB+BOJ) full-period IC at lead=${best.lead}w: ${fmt(globalFull.ic, 4)} (${icMagnitude})`);
  console.log(`  Fed-only IC at same lead:                              ${fmt(fedFull.ic, 4)}`);
  console.log(`  Global vs Fed-only delta:                              ${fmt(globalFull.ic - fedFull.ic, 4)}`);
  console.log();

  const regimeStability = periods.map(({ label, startY, endY }) => {
    const slice = filterGLByYear(gl, startY, endY);
    return { label, ...leadLagIC(slice, spx, best.lead) };
  });
  const allPositive = regimeStability.every((r) => r.ic > 0);
  const minIC = Math.min(...regimeStability.map((r) => r.ic));
  const maxIC = Math.max(...regimeStability.map((r) => r.ic));

  console.log('  Regime stability:');
  for (const r of regimeStability) {
    console.log(`    ${r.label}: IC=${fmt(r.ic, 4)} (n=${r.n})`);
  }
  console.log();

  if (allPositive) {
    console.log('  The signal is positive across ALL three regimes — some consistency.');
  } else {
    console.log('  WARNING: The signal flips sign across regimes — interpret with caution.');
  }
  console.log(`  IC range across regimes: [${fmt(minIC, 4)}, ${fmt(maxIC, 4)}]`);
  console.log();
  console.log('  CAVEATS:');
  console.log('  • Spearman IC is rank correlation — not alpha or Sharpe; needs calibration.');
  console.log('  • 24-year backtest has only ~4–6 non-overlapping 4-year macro cycles.');
  console.log('  • ECB data (ECBASSETSW) may not begin in 2002 — check coverage above.');
  console.log('  • JPNASSETS unit is 億円 (100M JPY); verify FRED page if results look odd.');
  console.log('  • asOf forward-fill means we use most-recent-available data, not same-date.');
  console.log('  • This is exploratory research, not a live model. DO NOT trade on IC alone.');
  console.log();
  console.log('='.repeat(70));
  console.log('  Study complete.');
  console.log('='.repeat(70));

  // ── 7. LOCAL-CURRENCY VARIANT (FX-neutral) ─────────────────────────────
  console.log();
  console.log('='.repeat(70));
  console.log('  7. LOCAL-CURRENCY VARIANT (FX-neutral global CB growth rate)');
  console.log('='.repeat(70));
  console.log();

  // Build the FX-neutral signal: each CB's growth in its OWN currency,
  // combined by current USD-size weights.
  const glLC = buildGlobalGrowthLC(walcl, ecb, boj, dexuseu, dexjpus, 13);

  if (glLC.length === 0) {
    console.log('  ERROR: buildGlobalGrowthLC returned 0 points. Check data overlap.');
  } else {
    const latestLC = glLC.at(-1);
    console.log(`  Coverage : ${glLC[0].date} → ${latestLC.date}`);
    console.log(`  Points   : ${glLC.length}`);
    console.log(`  Latest global CB expansion rate: ${pct(latestLC.value)} (${latestLC.date})`);
    if (Math.abs(latestLC.value) > 1) {
      console.log('  WARNING: latest rate magnitude >100% — possible unit or data error.');
    }
    console.log();

    // Lead/lag scan: lead = 0, 2, ..., 26 weeks
    console.log('── 7a. LEAD/LAG SCAN (LC growth signal vs SPX 13-week forward return) ──');
    console.log('  lead (wk)  |  Spearman IC  |  n pairs');
    console.log('  -----------|---------------|----------');

    const lcScanResults = [];
    for (const lead of leads) {
      const { ic, n } = leadLagICSignal(glLC, spx, lead, 13);
      lcScanResults.push({ lead, ic, n });
      console.log(`  ${String(lead).padStart(9)}  |  ${fmt(ic, 4).padStart(13)}  |  ${String(n).padStart(8)}`);
    }

    const lcBest = lcScanResults.reduce((a, b) => (b.ic > a.ic ? b : a));
    console.log();
    console.log(`  *** Best lead: ${lcBest.lead} weeks (IC = ${fmt(lcBest.ic, 4)}, n = ${lcBest.n})`);
    console.log();

    // Sub-period analysis
    console.log('── 7b. REGIME ANALYSIS (LC variant) ────────────────────────────────');
    console.log('  Period               |  lead=0 IC  |  n  |  best-lead IC  |  n');
    console.log('  ---------------------|-------------|-----|----------------|-----');

    function filterLCByYear(lcSeries, startYear, endYear) {
      return lcSeries.filter((p) => {
        const y = parseInt(p.date.slice(0, 4), 10);
        return y >= startYear && y <= endYear;
      });
    }

    for (const { label, startY, endY } of periods) {
      const lcSlice = filterLCByYear(glLC, startY, endY);
      const r0    = leadLagICSignal(lcSlice, spx, 0,          13);
      const rBest = leadLagICSignal(lcSlice, spx, lcBest.lead, 13);
      console.log(
        `  ${label.padEnd(21)}|  ${fmt(r0.ic, 4).padStart(11)}  |  ${String(r0.n).padStart(3)}  |  ${fmt(rBest.ic, 4).padStart(14)}  |  ${String(rBest.n).padStart(3)}`
      );
    }
    console.log();

    // Fed-only local-currency comparison
    console.log('── 7c. FED-ONLY LC GROWTH vs GLOBAL LC GROWTH ──────────────────────');

    // Build Fed-only signal: pctChangeWeeks(walcl, t, 13) for each walcl date
    // where the result is non-null.
    const fedLCSignal = [];
    for (const { date } of walcl) {
      const g = pctChangeWeeks(walcl, date, 13);
      if (g !== null) fedLCSignal.push({ date, value: g });
    }

    console.log(`  Fed-only LC signal: ${fedLCSignal.length} points`);
    console.log(`  Global LC signal  : ${glLC.length} points`);
    console.log();
    console.log('  Metric                    |  Global LC  |  Fed-only LC');
    console.log('  --------------------------|-------------|-------------');

    const lcGlobalFull  = leadLagICSignal(glLC,        spx, lcBest.lead, 13);
    const lcFedFull     = leadLagICSignal(fedLCSignal, spx, lcBest.lead, 13);
    const lcGlobalAt0   = leadLagICSignal(glLC,        spx, 0,           13);
    const lcFedAt0      = leadLagICSignal(fedLCSignal, spx, 0,           13);

    console.log(`  Full-period IC (lead=0)   |  ${fmt(lcGlobalAt0.ic, 4).padStart(11)}  |  ${fmt(lcFedAt0.ic, 4).padStart(12)}`);
    console.log(`  Full-period IC (best lead)|  ${fmt(lcGlobalFull.ic, 4).padStart(11)}  |  ${fmt(lcFedFull.ic, 4).padStart(12)}`);
    console.log(`  n pairs (best lead)       |  ${String(lcGlobalFull.n).padStart(11)}  |  ${String(lcFedFull.n).padStart(12)}`);
    console.log();

    // Honest summary
    console.log('── 7d. HONEST SUMMARY (LC variant) ─────────────────────────────────');
    console.log();

    const lcIC = lcGlobalFull.ic;
    const lcFedIC = lcFedFull.ic;
    const lcMagnitude =
      Math.abs(lcIC) < 0.10
        ? 'very weak (<0.10)'
        : Math.abs(lcIC) < 0.25
          ? 'weak (0.10–0.25)'
          : Math.abs(lcIC) < 0.40
            ? 'moderate (0.25–0.40)'
            : 'strong (>0.40)';

    console.log(`  Global LC IC (lead=${lcBest.lead}w) : ${fmt(lcIC, 4)} (${lcMagnitude})`);
    console.log(`  Fed-only LC IC (same lead)   : ${fmt(lcFedIC, 4)}`);
    console.log(`  FX-contaminated version IC   : ${fmt(globalFull.ic, 4)} (from section 5, lead=${best.lead}w)`);
    console.log(`  LC delta vs FX-contaminated  : ${fmt(lcIC - globalFull.ic, 4)}`);
    console.log(`  LC delta vs Fed-only LC      : ${fmt(lcIC - lcFedIC, 4)}`);
    console.log();

    const lcRegimes = periods.map(({ label, startY, endY }) => {
      const slice = filterLCByYear(glLC, startY, endY);
      return { label, ...leadLagICSignal(slice, spx, lcBest.lead, 13) };
    });
    const lcAllPositive = lcRegimes.every((r) => r.ic > 0);
    const lcMinIC = Math.min(...lcRegimes.map((r) => r.ic));
    const lcMaxIC = Math.max(...lcRegimes.map((r) => r.ic));

    if (lcAllPositive) {
      console.log('  LC signal is positive across ALL three regimes.');
    } else {
      console.log('  WARNING: LC signal flips sign across regimes — interpret with caution.');
    }
    console.log(`  IC range across regimes: [${fmt(lcMinIC, 4)}, ${fmt(lcMaxIC, 4)}]`);
    console.log();
    console.log('  CAVEATS:');
    console.log('  • "FX-neutral" means growth rates are in local currency, but USD weights');
    console.log('    are still used for combining — so FX still affects the weighting.');
    console.log('  • A single dominant CB (Fed) with distinct growth can override global signal.');
    console.log('  • Same 24-year backtest / non-overlapping-cycle caveats apply as section 6.');
    console.log('  • This is exploratory research, not a live model. DO NOT trade on IC alone.');
    console.log();
    console.log('='.repeat(70));
    console.log('  LC variant complete.');
    console.log('='.repeat(70));
  }
}

main().catch((err) => {
  console.error('Unhandled error:', err);
  process.exit(1);
});
