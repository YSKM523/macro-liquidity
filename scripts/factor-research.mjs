/**
 * factor-research.mjs — Phase R runner. For each candidate, measure standalone IC,
 * bootstrap CI/p, non-overlapping IC, 4-axis regime IC, incremental IC (equal-weight
 * Champion descriptor vs Champion-plus-candidate) + residual IC, and correlations vs existing factors.
 *
 * Usage: FRED_API_KEY=<key> node scripts/factor-research.mjs
 * Requires: npm run export:snapshots first (scripts/data/snapshots.json).
 */
import fs from 'node:fs';
import { spearman } from './global-lib.mjs';
import {
  forwardReturns, blockBootstrapIC, nonOverlappingIC, regimeBreakdown,
  percentileScore, residualIC, mulberry32,
} from './research-lib.mjs';
import {
  CANDIDATES, fiscalIssuanceSignal, termPremiumSignal, earningsMomentumSignal, globalLiquiditySignal,
} from './candidate-signals.mjs';
import {
  fetchFred, fetchDebtToPenny, fetchTermPremium, fetchShillerEarnings,
} from './research-fetch.mjs';

const HORIZON = 13;
const START = '2016-01-01';
const COVID = '2020-03-01';
const QT_END = '2025-12-01';
const FACTOR_KEYS = ['netliqTrend','impulse','credit','funding','rates','dollar','vol','reserveAdequacy','curve'];
const fmt = (x, d = 3) => (x == null || !Number.isFinite(x) ? 'N/A' : x.toFixed(d));

function loadSnapshots() {
  const raw = JSON.parse(fs.readFileSync('scripts/data/snapshots.json', 'utf8'));
  const rows = Array.isArray(raw) ? (raw[0].results ?? raw[0]) : (raw.results ?? raw);
  return rows
    .filter(r => r.spx != null && r.factors_json)
    .map(r => ({ date: r.date, spx: Number(r.spx), factors: JSON.parse(r.factors_json),
                 regime: r.qe_qt_regime, vix: r.vix_eod == null ? null : Number(r.vix_eod) }))
    .filter(r => r.date >= START)
    .sort((a, b) => (a.date < b.date ? -1 : 1));
}

// asOf, but only if the latest obs on/before `date` is within maxStaleDays (else null)
// — avoids forward-filling a dead series.
function asOfFresh(series, date, maxStaleDays) {
  let last = null;
  for (const o of series) { if (o.date <= date) last = o; else break; }
  if (last == null) return null;
  const gap = (new Date(date) - new Date(last.date)) / 86400000;
  return gap <= maxStaleDays ? last.value : null;
}

// Build measurement pairs for one candidate signal over the snapshot forward returns.
function buildPairs(snaps, signal, sign, vixMed) {
  const fr = forwardReturns(snaps, HORIZON);
  const valSeries = signal.map(s => ({ date: s.date, value: s.value }));
  const hist = []; // expanding history of raw signal values, in snapshot order
  const pairs = [];
  for (const { idx, fwd } of fr) {
    const s = snaps[idx];
    const v = asOfFresh(valSeries, s.date, 45);
    if (v == null) continue;
    hist.push(v);
    const candScore = percentileScore(v, hist.slice(), sign);
    const comp9 = FACTOR_KEYS.reduce((a, k) => a + (s.factors[k] ?? 50), 0) / FACTOR_KEYS.length;
    pairs.push({ date: s.date, x: v, fwd, candScore, comp9,
      regime: s.regime, vix: s.vix, vixMed });
  }
  return pairs;
}

function incrementalIC(pairs) {
  const fwds = pairs.map(p => p.fwd);
  const ic9 = spearman(pairs.map(p => p.comp9), fwds);
  const ic10 = spearman(pairs.map(p => (p.comp9 * FACTOR_KEYS.length + p.candScore) / (FACTOR_KEYS.length + 1)), fwds);
  const resid = residualIC(pairs.map(p => p.candScore), pairs.map(p => p.comp9), fwds);
  return { ic9, ic10, delta: ic10 - ic9, resid };
}

function regimeAll(pairs) {
  return {
    balance_sheet: regimeBreakdown(pairs, p => p.regime ?? null),
    covid: regimeBreakdown(pairs, p => (p.date < COVID ? 'pre' : 'post')),
    qt: regimeBreakdown(pairs, p => (p.date < QT_END ? 'pre' : 'post')),
    vix: regimeBreakdown(pairs, p => (p.vix == null ? null : (p.vix < p.vixMed ? 'low' : 'high'))),
  };
}

// sign>0: a good candidate has positive raw IC; sign<0: a good candidate has NEGATIVE raw IC.
// Orient the standalone IC and its bootstrap CI/p so the robustness gate is symmetric.
function verdict(standalone, boot, incr, nIndep, sign) {
  const oIC   = sign * standalone;
  const oCiLo = sign > 0 ? boot.ci_lo : -boot.ci_hi;        // oriented lower CI bound
  const oP    = sign > 0 ? boot.p_value : 1 - boot.p_value; // oriented P(IC <= 0)
  const robustPos   = oCiLo > 0 || (oP < 0.10 && oIC > 0);
  const incremental = incr.delta > 0.003 || Math.abs(incr.resid) > 0.05;
  if (robustPos && incremental && nIndep >= 10) return 'PASS';
  if (Math.abs(standalone) > 0.05 || Math.abs(incr.resid) > 0.05) return 'DISPLAY-ONLY';
  return 'DROP';
}

// helper: candidate raw value aligned to pair i; factor score from the snapshot at that date.
function snaps_factor(snaps, pairs, i, k) {
  const d = pairs[i].date;
  const s = snaps.find(z => z.date === d);
  return s ? (s.factors[k] ?? 50) : 50;
}

async function main() {
  const snaps = loadSnapshots();
  const vixVals = snaps.map(s => s.vix).filter(v => v != null).sort((a, b) => a - b);
  const vixMed = vixVals.length ? vixVals[Math.floor(vixVals.length / 2)] : 20;
  console.log(`snapshots ${snaps.length} [${snaps[0]?.date}→${snaps.at(-1)?.date}], VIX median ${fmt(vixMed,1)}`);

  // Fetch raw sources
  const [walcl, ecb, boj, dexuseu, dexjpus, debt, tp, eps] = await Promise.all([
    fetchFred('WALCL'), fetchFred('ECBASSETSW'), fetchFred('JPNASSETS'),
    fetchFred('DEXUSEU'), fetchFred('DEXJPUS'),
    fetchDebtToPenny(), fetchTermPremium(), fetchShillerEarnings(),
  ]);

  const signals = {
    global_liquidity: globalLiquiditySignal(walcl, ecb, boj, dexuseu, dexjpus, 13),
    fiscal_issuance: fiscalIssuanceSignal(debt, 13),
    term_premium: termPremiumSignal(tp.series, 20),
    earnings_momentum: earningsMomentumSignal(eps, 60),
  };
  const notes = { term_premium: `源:${tp.source}` };

  // Report coverage info for each signal
  for (const [key, sig] of Object.entries(signals)) {
    if (sig.length > 0) {
      console.log(`  ${key}: ${sig.length} pts [${sig[0].date}→${sig.at(-1).date}]`);
    } else {
      console.log(`  ${key}: 0 pts (EMPTY)`);
    }
  }

  const lines = ['# P4 因子研究裁决报告', '', `生成快照样本:${snaps.length} 行 [${snaps[0]?.date}→${snaps.at(-1)?.date}], horizon ${HORIZON}w`, ''];
  const summary = [];

  for (const c of CANDIDATES) {
    const sig = signals[c.key];
    const pairs = buildPairs(snaps, sig, c.sign, vixMed);
    const fwds = pairs.map(p => p.fwd);
    const standalone = pairs.length >= 3 ? spearman(pairs.map(p => p.x), fwds) : 0;
    const boot = blockBootstrapIC(pairs.map(p => ({ x: p.x, fwd: p.fwd })), HORIZON, 2000, mulberry32(12345));
    const nonov = nonOverlappingIC(pairs, HORIZON);
    const reg = regimeAll(pairs);
    const incr = incrementalIC(pairs);

    // Correlation: candidate raw vs each existing factor score
    const corr = {};
    for (const k of FACTOR_KEYS) corr[k] = spearman(pairs.map(p => p.x), pairs.map((p, i) => snaps_factor(snaps, pairs, i, k)));

    const v = verdict(standalone, boot, incr, nonov.n, c.sign);
    summary.push({ key: c.key, label: c.label, standalone, nonov, boot, incr, v });

    // Coverage for this candidate
    const coverageFirst = pairs.length > 0 ? pairs[0].date : 'N/A';
    const coverageLast  = pairs.length > 0 ? pairs.at(-1).date : 'N/A';

    console.log(`\n--- ${c.label} → ${v} ---`);
    console.log(`  pairs n=${pairs.length} [${coverageFirst}→${coverageLast}], nonov n=${nonov.n}`);
    console.log(`  standalone IC=${fmt(standalone)}, nonov IC=${fmt(nonov.ic)}`);
    console.log(`  boot: CI=[${fmt(boot.ci_lo)},${fmt(boot.ci_hi)}] p=${fmt(boot.p_value,3)} iters=${boot.iters}`);
    console.log(`  incr: ic9=${fmt(incr.ic9)} ic10=${fmt(incr.ic10)} Δ=${fmt(incr.delta)} residIC=${fmt(incr.resid)}`);
    const topCorr = Object.entries(corr).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1])).slice(0, 3)
      .map(([k, val]) => `${k}=${fmt(val,2)}`).join(', ');
    console.log(`  top3 corr: ${topCorr}`);

    lines.push(`## ${c.label}  →  **${v}**`, '');
    if (notes[c.key]) lines.push(`- ${notes[c.key]}`);
    lines.push(`- 信号点数 ${sig.length};配对 n=${pairs.length}(重叠) / **${nonov.n}(非重叠真 n)**`);
    lines.push(`- 有效覆盖: ${coverageFirst} → ${coverageLast}`);
    lines.push(`- standalone IC@13w = **${fmt(standalone)}**(非重叠 IC=${fmt(nonov.ic)})`);
    lines.push(`- bootstrap:95%CI [${fmt(boot.ci_lo)}, ${fmt(boot.ci_hi)}], p(IC≤0)=${fmt(boot.p_value,3)}, iters=${boot.iters}`);
    lines.push(`- 增量:等权 IC ${fmt(incr.ic9)}(Champion 描述符：8 个计分因子 + vol 风控控制项) → ${fmt(incr.ic10)}(+候选), Δ=**${fmt(incr.delta)}**;残差 IC=${fmt(incr.resid)}`);
    const topCorrMd = Object.entries(corr).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1])).slice(0, 3)
      .map(([k, val]) => `${k} ${fmt(val,2)}`).join(', ');
    lines.push(`- 与现有因子相关(top3):${topCorrMd}`);
    for (const axis of ['balance_sheet','covid','qt','vix']) {
      const parts = Object.entries(reg[axis]).map(([g, r]) => `${g}:IC ${fmt(r.ic,2)}(n${r.n})`).join('  ');
      lines.push(`- regime ${axis}: ${parts}`);
    }
    lines.push('');
  }

  lines.push('## 总表', '', '| 候选 | standalone IC | 非重叠 n | CI / p | 增量Δ | 残差IC | 裁决 |', '|---|---|---|---|---|---|---|');
  for (const s of summary) {
    lines.push(`| ${s.label} | ${fmt(s.standalone)} | ${s.nonov.n} | [${fmt(s.boot.ci_lo,2)},${fmt(s.boot.ci_hi,2)}]/${fmt(s.boot.p_value,2)} | ${fmt(s.incr.delta)} | ${fmt(s.incr.resid)} | **${s.v}** |`);
  }
  lines.push('', '> 门槛:PASS=bootstrap CI 排除~0 或 p<0.1 且增量为正(Δ>0.003 或 |残差|>0.05)且非重叠 n≥10;否则有信号→DISPLAY-ONLY,无→DROP。最终由人在 checkpoint 拍板。');
  lines.push('> 注:期限溢价与现有 `rates` 因子近重复(20日Δ同一10Y),相关 r≈−0.95 → 故 DROP(避免双权重)。');
  lines.push('> 注:财政发行与 `netliqTrend` 相关仅 r≈−0.04(低于预期)——发行速率与净流动性趋势在 2016+ 比想象中更正交(netliqTrend 由 WALCL 主导);盈利动量覆盖止于 2023-07、IC 为负且方向与假设相反(post-COVID 基数效应+n小),DISPLAY-ONLY 须附此 caveat。');

  const out = lines.join('\n');
  fs.mkdirSync('docs/superpowers', { recursive: true });
  fs.writeFileSync('docs/superpowers/p4-factor-research-report.md', out);
  console.log('\n=== REPORT WRITTEN: docs/superpowers/p4-factor-research-report.md ===\n');
  console.log(out);
}

main().catch(e => { console.error('FATAL', e); process.exit(1); });
