const FACTOR_LABELS = {
  netliqTrend: '净流动性', impulse: '资产负债表', credit: '信用', funding: '资金面',
  rates: '利率冲量', dollar: '美元', vol: '波动',
  reserveAdequacy: '准备金', curve: '收益率曲线',
};
const VERDICT_CN = { BULLISH: '偏多', BEARISH: '偏空', NEUTRAL: '中性' };
const VERDICT_CLASS = { BULLISH: 'bull', BEARISH: 'bear', NEUTRAL: 'neutral' };
const REGIME_CN = { EXPANDING: '扩表', CONTRACTING: '缩表', FLAT: '横住' };
const POLICY_CN = { QE: 'QE(宽松)', QT: 'QT(紧缩)', RESERVE_MGMT: '准备金管理(QT已结束)', NEUTRAL: '中性' };
const fmt = (x, d = 2) => (x == null ? '—' : Number(x).toFixed(d));
const EX_WINDOW_LABEL = { '1w': '上周', '1m': '上月', '3m': '3 个月前' };
const FACTOR_MEANING = {
  netliqTrend: '净流动性 13 周趋势,升=放水偏多',
  impulse: 'Fed 资产负债表脉冲(扩/缩)',
  credit: '高收益债信用利差(低=风险偏好高)',
  funding: 'SOFR−IORB 资金面压力',
  rates: '10 年期利率冲量',
  dollar: '广义美元 DTWEXBGS,走强=逆风',
  reserveAdequacy: '银行准备金充裕度',
  curve: '收益率曲线斜率(10Y−2Y)',
};
let explainData = null;

async function main() {
  setupExplain();
  fetchExplain('1w');
  let snapRes, histRes;
  try {
    [snapRes, histRes] = await Promise.all([
      fetch('/api/snapshot').then(r => r.json()),
      fetch('/api/history?from=' + threeYearsAgo()).then(r => r.json()),
    ]);
  } catch (e) {
    showBanner('⚠️ 加载失败，稍后重试（' + (e && e.message ? e.message : '网络错误') + '）');
    return;
  }
  if (!snapRes || !snapRes.snapshot || snapRes.error === 'no_data') {
    showBanner('暂无数据（数据库为空或正在初始化）');
    renderIngest(snapRes && snapRes.ingest);
    return;
  }
  renderVerdict(snapRes);
  renderGuidance(snapRes.snapshot);
  renderScore(snapRes.snapshot);
  renderFactorTable(snapRes);
  renderChart((histRes && histRes.rows) || []);
  renderIngest(snapRes.ingest);
}

function showBanner(text) {
  const banner = document.getElementById('stress-banner');
  if (banner) { banner.textContent = text; banner.style.display = ''; }
}

// 摄取异常(cron 停了/FRED 失败)才报红；正常周线数据滞后不报。
function renderIngest(ingest) {
  const el = document.getElementById('data-staleness');
  if (!el || !ingest) return;
  const age = ingest.ingest_age_hours;
  if (ingest.ingest_status === 'error' || (age != null && age > 6)) {
    const hrs = age != null ? Math.round(age) : '?';
    el.textContent += `　⚠️ 数据更新异常（上次成功 ${hrs} 小时前）`;
    el.style.color = '#C53030';
  }
}

function threeYearsAgo() {
  const d = new Date(); d.setFullYear(d.getFullYear() - 3);
  return d.toISOString().slice(0, 10);
}

function renderVerdict(res) {
  const s = res.snapshot || {};
  const card = document.getElementById('verdict-card');
  const macroV = s.verdict || 'NEUTRAL';
  const displayV = s.display_verdict || macroV;
  card.classList.add(VERDICT_CLASS[displayV]);
  document.getElementById('verdict-label').textContent = VERDICT_CN[displayV] || '—';
  document.getElementById('verdict-reason').textContent = s.reason || '';

  // Live stress overlay
  const stress = s.live_stress;
  const banner = document.getElementById('stress-banner');
  const note = document.getElementById('stress-note');
  if (stress && stress.stressed) {
    banner.textContent = '⚠️ 实时风险覆盖:' + stress.reasons.join('、');
    banner.style.display = '';
    if (displayV !== macroV) {
      note.textContent = `(宏观判断 ${VERDICT_CN[macroV]},因实时风险下调一级)`;
      note.style.display = '';
    } else {
      note.style.display = 'none';
    }
  } else {
    banner.style.display = 'none';
    note.style.display = 'none';
  }
  const policy = s.policy_regime ? (POLICY_CN[s.policy_regime] || s.policy_regime) : '—';
  document.getElementById('regime-sub').innerHTML =
    `资产负债表:&nbsp;<b>${REGIME_CN[s.qe_qt_regime] || s.qe_qt_regime || '—'}</b><br>净流动性:&nbsp;<b>${dirCn(s.netliq_dir)}</b><br>政策阶段:&nbsp;<b>${policy}</b>`;
  const live = res.live || {};
  document.getElementById('asof').textContent =
    `SPX ${fmt(live.spx)} · VIX ${fmt(live.vix)} · DXY ${fmt(live.dxy)} · 10Y ${fmt(live.us10y)}%`;

  // Staleness: days since snapshot.date
  const snapshotDate = s.date || '';
  if (snapshotDate) {
    const today = new Date();
    const snap = new Date(snapshotDate + 'T00:00:00Z');
    const diffDays = Math.round((today.getTime() - snap.getTime()) / 86400000);
    const staleEl = document.getElementById('data-staleness');
    if (staleEl) {
      staleEl.textContent = `数据截至 ${snapshotDate}(${diffDays} 天前)`;
      staleEl.style.color = diffDays > 8 ? '#B7791F' : '';
    }
  }

  // Coverage: N/total scoring factors with real data
  const coverage = s.coverage;
  const total = s.coverage_total ?? 8;
  const coverageEl = document.getElementById('data-coverage');
  if (coverageEl && coverage != null) {
    const n = Math.round(coverage * total);
    coverageEl.textContent = `${n}/${total} 因子有真实数据`;
    coverageEl.style.color = n < total ? '#B7791F' : '';
  }
}

function renderGuidance(s) {
  const card = document.getElementById('guidance-card');
  if (!s || !s.guidance) { card.style.display = 'none'; return; }
  card.style.display = '';
  const g = s.guidance;

  // Tier badge + tone color class
  const tierEl = document.getElementById('g-tier');
  tierEl.textContent = g.tierLabel;
  tierEl.className = 'g-badge ' + g.tone;

  document.getElementById('g-exposure').textContent = g.exposure;
  document.getElementById('g-lean').textContent = '偏向:' + g.lean;

  const divergeEl = document.getElementById('g-diverge');
  if (g.divergence) {
    divergeEl.textContent = g.divergence;
    divergeEl.style.display = '';
  } else {
    divergeEl.style.display = 'none';
  }

  const triggersList = document.getElementById('g-triggers');
  triggersList.innerHTML = (g.triggers || []).map(t => {
    const cls = t.armed ? 'armed' : '';
    return `<li class="${cls}"><b>${t.label}</b> · ${t.detail}</li>`;
  }).join('');
}

function dirCn(d) { return { UP: '在升', DOWN: '在收', FLAT: '走平' }[d] || '—'; }

function renderScore(s) {
  if (!s) return;
  const score = Math.round(s.score ?? 0);
  document.getElementById('score-gauge').style.width = score + '%';
  document.getElementById('score-num').textContent = score;
  // sub-factor bars read the persisted factors_json column (set by upsertSnapshot)
  const factors = s.factors_json ? JSON.parse(s.factors_json) : null;
  const host = document.getElementById('factor-bars');
  host.innerHTML = '';
  if (!factors) return;
  for (const [k, label] of Object.entries(FACTOR_LABELS)) {
    const val = Math.round(factors[k] ?? 0);
    const row = document.createElement('div'); row.className = 'fb';
    row.innerHTML = `<span>${label}</span><span class="track"><span class="bar" style="width:${val}%"></span></span><span>${val}</span>`;
    host.appendChild(row);
  }
}

function renderFactorTable(res) {
  const s = res.snapshot || {}; const live = res.live || {};
  const tbody = document.querySelector('#factor-table tbody');
  const tag = ok => `<span class="tag ${ok ? 'ok' : 'bad'}">${ok ? '顺风' : '逆风'}</span>`;
  const rows = [
    ['净流动性 (十亿)', fmt(s.netliq, 0), s.netliq_dir === 'UP'],
    ['10Y 收益率', fmt(live.us10y) + '%', null],
    ['SOFR−IORB', fmt(s.sofr_iorb, 3), (s.sofr_iorb ?? 1) <= 0.05],
    ['HY OAS', fmt(s.hy_oas, 2), null],
    ['美元 (ICE DXY,实时仅展示)', fmt(live.dxy), null],
    ['VIX', fmt(live.vix), (live.vix ?? 99) < 25],
  ];
  tbody.innerHTML = rows.map(([k, v, ok]) =>
    `<tr><td>${k}</td><td>${v}</td><td>${ok == null ? '—' : tag(ok)}</td></tr>`).join('');
}

function renderChart(rows) {
  const el = document.getElementById('chart');
  const chart = LightweightCharts.createChart(el, {
    height: 320, layout: { background: { color: '#FFFFFF' }, textColor: '#697386' },
    grid: { vertLines: { color: '#E3E8EE' }, horzLines: { color: '#E3E8EE' } },
    rightPriceScale: { borderColor: '#E3E8EE' }, leftPriceScale: { visible: true, borderColor: '#E3E8EE' },
    timeScale: { borderColor: '#E3E8EE' },
  });
  const spx = chart.addLineSeries({ color: '#1A1F36', priceScaleId: 'right', lineWidth: 2 });
  const nl = chart.addLineSeries({ color: '#635BFF', priceScaleId: 'left', lineWidth: 2 });
  const spxData = rows.filter(r => r.spx != null).map(r => ({ time: r.date, value: r.spx }));
  const nlData = rows.filter(r => r.netliq != null).map(r => ({ time: r.date, value: r.netliq }));
  spx.setData(spxData);
  nl.setData(nlData);
  chart.timeScale().fitContent();
  new ResizeObserver(() => chart.applyOptions({ width: el.clientWidth })).observe(el);

  // Legend values: latest by default, hovered value on crosshair move
  const legNl = document.getElementById('leg-nl');
  const legSpx = document.getElementById('leg-spx');
  const lastNl = nlData.length ? nlData[nlData.length - 1].value : null;
  const lastSpx = spxData.length ? spxData[spxData.length - 1].value : null;
  const setLeg = (nlv, spxv) => {
    if (legNl) legNl.textContent = nlv == null ? '' : ' $' + Math.round(nlv).toLocaleString() + 'B';
    if (legSpx) legSpx.textContent = spxv == null ? '' : ' ' + Math.round(spxv).toLocaleString();
  };
  setLeg(lastNl, lastSpx);
  chart.subscribeCrosshairMove((param) => {
    if (!param || !param.time) { setLeg(lastNl, lastSpx); return; }
    const nlv = param.seriesData.get(nl);
    const spxv = param.seriesData.get(spx);
    setLeg(nlv ? nlv.value : null, spxv ? spxv.value : null);
  });
}

// ── 分数归因卡 ────────────────────────────────────────────────────────────
async function fetchExplain(win) {
  const card = document.getElementById('explain-card');
  const body = document.getElementById('explain-body');
  if (!card || !body) return;
  try {
    const res = await fetch('/api/explain?window=' + win).then(r => r.json());
    explainData = res;
    renderExplain(res);
    card.style.display = '';
  } catch (e) {
    explainData = null;
    body.innerHTML = '<p class="ex-note">归因加载失败,稍后重试</p>';
    card.style.display = '';
  }
}

function setupExplain() {
  const seg = document.getElementById('explain-window');
  if (seg && !seg.dataset.wired) {
    seg.dataset.wired = '1';
    seg.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-window]');
      if (!btn) return;
      seg.querySelectorAll('button').forEach(b => b.classList.toggle('active', b === btn));
      fetchExplain(btn.dataset.window);
    });
  }
  const body = document.getElementById('explain-body');
  if (body && !body.dataset.wired) {
    body.dataset.wired = '1';
    body.addEventListener('click', (e) => {
      const row = e.target.closest('.ex-row[data-key]');
      if (!row || !explainData) return;
      const sib = row.nextElementSibling;
      if (sib && sib.classList.contains('ex-detail')) { sib.remove(); return; }
      const key = row.dataset.key;
      const c = (explainData.contributions || []).find(x => x.key === key);
      const a = (explainData.attribution || []).find(x => x.key === key);
      const bits = [];
      if (c) bits.push(`当前因子 ${c.factor.toFixed(0)}/100 · 权重 ${Math.round(c.weight * 100)}% · 贡献 ${c.contribution >= 0 ? '+' : ''}${c.contribution.toFixed(2)}`);
      if (a) bits.push(`较基准 Δ ${a.deltaFactor >= 0 ? '+' : ''}${a.deltaFactor.toFixed(0)} → 拉动 ${a.deltaContribution >= 0 ? '+' : ''}${a.deltaContribution.toFixed(2)}`);
      if (FACTOR_MEANING[key]) bits.push(FACTOR_MEANING[key]);
      const det = document.createElement('div');
      det.className = 'ex-detail';
      det.textContent = bits.join('　·　');
      row.after(det);
    });
  }
}

function renderExplain(res) {
  const body = document.getElementById('explain-body');
  if (!body) return;
  if (!res || res.error === 'no_data' || !res.current) {
    body.innerHTML = '<p class="ex-note">暂无数据</p>';
    return;
  }
  body.innerHTML = renderAttribution(res) + renderContribution(res.contributions) + renderNetliq(res.netliq, res.window);
}

// 信号变化归因 = Δ分瀑布图(从基准分逐因子累加落到当前分)
function renderAttribution(res) {
  const label = EX_WINDOW_LABEL[res.window] || '基准';
  if (!res.attribution || res.reference == null || res.deltaScore == null) {
    return `<div class="ex-sub">这次为什么变(较${label})</div>`
      + `<p class="ex-note">基准数据不足(历史不够),换更短的时间档试试。</p>`;
  }
  const R = res.reference.score, C = res.current.score, d = res.deltaScore;
  const dCls = d >= 0 ? 'ex-up' : 'ex-down';
  const dSign = d >= 0 ? '+' : '';

  const steps = res.attribution
    .filter(a => Math.abs(a.deltaContribution) >= 0.2)
    .map(a => ({ label: FACTOR_LABELS[a.key] || a.key, v: a.deltaContribution, key: a.key }));
  const otherSum = res.attribution
    .filter(a => Math.abs(a.deltaContribution) < 0.2)
    .reduce((s, a) => s + a.deltaContribution, 0);
  if (Math.abs(otherSum) >= 0.005) steps.push({ label: '其它', v: otherSum, key: null });

  // 轴范围:覆盖 R、C 及所有累加中间点
  let run = R; const pts = [R];
  for (const s of steps) { run += s.v; pts.push(run); }
  const lo = Math.min.apply(null, pts.concat([R, C]));
  const hi = Math.max.apply(null, pts.concat([R, C]));
  const span = Math.max(0.5, hi - lo);
  const x = (v) => (v - lo) / span * 100;

  let cum = R;
  const bars = steps.map(s => {
    const a = cum, b = cum + s.v; cum = b;
    const left = Math.min(x(a), x(b));
    const width = Math.max(0.8, Math.abs(x(b) - x(a)));
    const dataKey = s.key ? ` data-key="${s.key}"` : '';
    const cls = s.v >= 0 ? 'ex-up' : 'ex-down';
    const sign = s.v >= 0 ? '+' : '';
    return `<div class="ex-row"${dataKey}><span class="lbl">${s.label}</span>`
      + `<span class="ex-track"><span class="wf ${s.v >= 0 ? 'up' : 'down'}" style="left:${left}%;width:${width}%"></span></span>`
      + `<span class="ex-val ${cls}">${sign}${s.v.toFixed(2)}</span></div>`;
  }).join('');

  return `<div class="ex-sub">这次为什么变(较${label})</div>`
    + `<div class="ex-head-line">基准 ${R.toFixed(1)} → 当前 ${C.toFixed(1)} <span class="${dCls}">(${dSign}${d.toFixed(1)})</span></div>`
    + bars;
}

// 因子贡献 = 离中性发散条
function renderContribution(contribs) {
  if (!contribs || !contribs.length) return '';
  const max = Math.max.apply(null, contribs.map(c => Math.abs(c.contribution)).concat([0.01]));
  const rows = contribs.map(c => divergingRow(FACTOR_LABELS[c.key] || c.key, c.contribution, max, c.key)).join('');
  return `<div class="ex-sub">谁在拉扯(离中性 50 的贡献分,合计 = 分数 − 50)</div>${rows}`;
}

function divergingRow(label, value, max, key) {
  const pct = Math.min(50, Math.abs(value) / max * 50);
  const bar = value >= 0
    ? `<span class="pos" style="width:${pct}%"></span>`
    : `<span class="neg" style="width:${pct}%"></span>`;
  const cls = value >= 0 ? 'ex-up' : 'ex-down';
  const sign = value >= 0 ? '+' : '';
  return `<div class="ex-row" data-key="${key}"><span class="lbl">${label}</span>`
    + `<span class="ex-track"><span class="mid"></span>${bar}</span>`
    + `<span class="ex-val ${cls}">${sign}${value.toFixed(2)}</span></div>`;
}

// 净流动性拆解 = 桥接图 WALCL − TGA − RRP = netliq
function renderNetliq(nl, win) {
  if (!nl || !nl.current) return '';
  const c = {
    walcl: nl.current.walcl ?? 0,
    tga: nl.current.tga ?? 0,
    rrp: nl.current.rrp ?? 0,
    netliq: nl.current.netliq ?? 0,
  };
  const r = (x) => Math.round(x).toLocaleString();
  const maxv = Math.max(Math.abs(c.walcl), 1);
  const w = (x) => Math.max(1, Math.min(100, Math.abs(x) / maxv * 100));
  const bridge = `<div class="ex-bridge">`
    + `<div class="br"><span class="lbl">Fed 资产负债表</span><span class="barwrap"><span class="bar" style="width:${w(c.walcl)}%"></span></span><span class="amt">${r(c.walcl)}</span></div>`
    + `<div class="br"><span class="lbl">− 财政部 TGA</span><span class="barwrap"><span class="bar sub" style="width:${w(c.tga)}%"></span></span><span class="amt">−${r(c.tga)}</span></div>`
    + `<div class="br"><span class="lbl">− 逆回购 RRP</span><span class="barwrap"><span class="bar sub" style="width:${w(c.rrp)}%"></span></span><span class="amt">−${r(c.rrp)}</span></div>`
    + `<div class="br"><span class="lbl">= 净流动性</span><span class="barwrap"><span class="bar tot" style="width:${w(c.netliq)}%"></span></span><span class="amt">${r(c.netliq)}</span></div>`
    + `</div>`;
  let note = '';
  if (nl.delta) {
    const d = nl.delta;
    const tag = (v, invert) => {
      const up = v >= 0;
      const good = invert ? !up : up;
      return `<span class="${good ? 'ex-up' : 'ex-down'}">${up ? '+' : ''}${Math.round(v)}</span>`;
    };
    note = `<p class="ex-note">较${EX_WINDOW_LABEL[win] || '基准'} 净流动性 ${tag(d.netliq, false)}B`
      + `(WALCL ${tag(d.walcl, false)} · TGA ${tag(d.tga, true)} · RRP ${tag(d.rrp, true)};TGA/RRP 升=抽水)</p>`;
  }
  return `<div class="ex-sub">净流动性拆解(十亿$)</div>${bridge}${note}`;
}

main().catch(e => { showBanner('⚠️ 加载失败，稍后重试（' + (e && e.message ? e.message : '网络错误') + '）'); });
