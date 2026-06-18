const FACTOR_LABELS = {
  netliqTrend: '净流动性', qeqt: 'QE/QT', credit: '信用', funding: '资金面',
  rates: '利率冲量', dollar: '美元', vol: '波动',
};
const VERDICT_CN = { BULLISH: '偏多', BEARISH: '偏空', NEUTRAL: '中性' };
const VERDICT_CLASS = { BULLISH: 'bull', BEARISH: 'bear', NEUTRAL: 'neutral' };
const REGIME_CN = { QE: '扩表 (QE)', QT: '缩表 (QT)', NEUTRAL: '横住' };
const fmt = (x, d = 2) => (x == null ? '—' : Number(x).toFixed(d));

async function main() {
  const [snapRes, histRes] = await Promise.all([
    fetch('/api/snapshot').then(r => r.json()),
    fetch('/api/history?from=' + threeYearsAgo()).then(r => r.json()),
  ]);
  renderVerdict(snapRes);
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
  const v = s.verdict || 'NEUTRAL';
  card.classList.add(VERDICT_CLASS[v]);
  document.getElementById('verdict-label').textContent = VERDICT_CN[v] || '—';
  document.getElementById('verdict-reason').textContent = s.reason || '';
  document.getElementById('regime-sub').innerHTML =
    `QE/QT:&nbsp;<b>${REGIME_CN[s.qe_qt_regime] || s.qe_qt_regime || '—'}</b><br>净流动性:&nbsp;<b>${dirCn(s.netliq_dir)}</b>`;
  const live = res.live || {};
  document.getElementById('asof').textContent =
    `SPX ${fmt(live.spx)} · VIX ${fmt(live.vix)} · DXY ${fmt(live.dxy)} · 10Y ${fmt(live.us10y)}%`;
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
    ['美元 (DXY live)', fmt(live.dxy), null],
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
  spx.setData(rows.filter(r => r.spx != null).map(r => ({ time: r.date, value: r.spx })));
  nl.setData(rows.filter(r => r.netliq != null).map(r => ({ time: r.date, value: r.netliq })));
  chart.timeScale().fitContent();
  new ResizeObserver(() => chart.applyOptions({ width: el.clientWidth })).observe(el);
}

main().catch(e => { document.getElementById('verdict-reason').textContent = '加载失败: ' + e.message; });
