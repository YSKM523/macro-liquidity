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

async function main() {
  const [snapRes, histRes] = await Promise.all([
    fetch('/api/snapshot').then(r => r.json()),
    fetch('/api/history?from=' + threeYearsAgo()).then(r => r.json()),
  ]);
  renderVerdict(snapRes);
  renderGuidance(snapRes.snapshot);
  renderScore(snapRes.snapshot);
  renderFactorTable(snapRes);
  renderChart(histRes.rows || []);
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

  // Coverage: N/7 factors with real data
  const coverage = s.coverage;
  const coverageEl = document.getElementById('data-coverage');
  if (coverageEl && coverage != null) {
    const n = Math.round(coverage * 7);
    coverageEl.textContent = `${n}/7 因子有真实数据`;
    coverageEl.style.color = n < 7 ? '#B7791F' : '';
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

main().catch(e => { document.getElementById('verdict-reason').textContent = '加载失败: ' + e.message; });
