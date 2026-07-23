const FACTOR_LABELS = {
  netliqTrend: '净流动性', impulse: '资产负债表', credit: '信用', funding: '资金面',
  rates: '利率冲量', dollar: '美元', vol: '波动',
  reserveAdequacy: '准备金', curve: '收益率曲线',
};
const SCORING_FACTOR_KEYS = ['netliqTrend', 'impulse', 'credit', 'funding', 'rates', 'dollar', 'reserveAdequacy', 'curve'];
const VERDICT_CN = { BULLISH: '偏多', BEARISH: '偏空', NEUTRAL: '中性', UNKNOWN: '风险未知' };
const VERDICT_CLASS = { BULLISH: 'bull', BEARISH: 'bear', NEUTRAL: 'neutral', UNKNOWN: 'unknown' };
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
const REGIME_AXIS_LABEL = { balance_sheet: '资产负债表', covid: 'COVID 前后', qt: 'QT 前后', vix: 'VIX 风险档' };
const REGIME_BUCKET_LABEL = { EXPANDING: '扩表', CONTRACTING: '缩表', FLAT: '横住', pre: '前', post: '后', low: '低波', high: '高波' };

function toneForRegime(regime) {
  return { EXPANDING: 'bull', CONTRACTING: 'bear', FLAT: 'neutral' }[regime] || 'neutral';
}

function toneForDirection(dir) {
  return { UP: 'bull', DOWN: 'bear', FLAT: 'neutral' }[dir] || 'neutral';
}

function toneForPolicy(policy) {
  return { QE: 'bull', QT: 'bear', RESERVE_MGMT: 'neutral', NEUTRAL: 'neutral' }[policy] || 'neutral';
}

// 移动端折叠次要卡片(规整:顶部只留决策区,分析类点击标题展开)
let glChart = null;
function setupAccordions() {
  if (!window.matchMedia || !window.matchMedia('(max-width:760px)').matches) return;
  document.querySelectorAll('.collapsible').forEach((card) => {
    const h2 = card.querySelector('h2');
    if (!h2 || h2.dataset.acc) return;
    h2.dataset.acc = '1';
    card.classList.add('collapsed');
    const chev = document.createElement('span');
    chev.className = 'chev';
    chev.textContent = '▸';
    h2.appendChild(chev);
    h2.addEventListener('click', () => {
      const collapsed = card.classList.toggle('collapsed');
      chev.textContent = collapsed ? '▸' : '▾';
      if (!collapsed && card.id === 'global-card' && glChart) {
        const gel = document.getElementById('global-chart');
        if (gel) {
          glChart.applyOptions({ width: gel.clientWidth, height: Math.max(110, gel.clientHeight || 180) });
          glChart.timeScale().fitContent();
        }
      }
    });
  });
}

async function main() {
  setupExplain();
  fetchExplain('1w');
  fetchRobust();
  fetchScoreStressDiagnostics();
  fetchLiquidityStructureChallenger();
  fetchEventBacktest();
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
  const active = snapRes && selectPrimarySnapshot(snapRes.official, snapRes.nowcast);
  if (!snapRes || !active || snapRes.error === 'no_data') {
    showBanner('暂无数据（数据库为空或正在初始化）');
    renderIngest(snapRes && snapRes.ingest);
    return;
  }
  const snapshotChannel = active === snapRes.nowcast ? 'nowcast' : 'official';
  const activeRes = { ...snapRes, snapshot: active, snapshotChannel };
  renderSnapshotChannels(snapRes, active);
  renderVerdict(activeRes);
  renderGuidance(active);
  renderScore(active);
  renderFactorTable(activeRes);
  renderChart((histRes && histRes.rows) || []);
  renderIngest(snapRes.ingest);
  renderProvenance(activeRes);
  renderGlobal();
  setupAccordions();
}

function selectPrimarySnapshot(official, nowcast) {
  if (!official) return nowcast;
  if (!nowcast) return official;
  return nowcast.date > official.date ? nowcast : official;
}

function channelSummary(snapshot) {
  if (!snapshot) return '暂无';
  const verdict = VERDICT_CN[snapshot.display_verdict || snapshot.verdict] || '—';
  return `${snapshot.date || '—'} · ${verdict}`;
}

function renderSnapshotChannels(snapRes, active) {
  const official = snapRes.official;
  const nowcast = snapRes.nowcast;
  const officialEl = document.getElementById('official-channel-value');
  const nowcastEl = document.getElementById('nowcast-channel-value');
  if (officialEl) officialEl.textContent = channelSummary(official);
  if (nowcastEl) nowcastEl.textContent = channelSummary(nowcast);
  const current = document.getElementById('current-channel');
  if (current) current.textContent = active === nowcast ? '周中预估 · PROVISIONAL' : '正式信号 · OFFICIAL';
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
  const macroIncomplete = s.decision_status === 'DATA_INCOMPLETE';
  const card = document.getElementById('verdict-card');
  const macroV = s.verdict || null;
  const displayV = s.display_verdict || macroV || 'UNKNOWN';
  card.classList.remove('bull', 'bear', 'neutral', 'unknown');
  card.classList.add(VERDICT_CLASS[displayV]);
  document.getElementById('verdict-label').textContent = VERDICT_CN[displayV] || '—';
  const token = document.getElementById('regime-token');
  if (token) token.textContent = displayV;
  document.getElementById('verdict-reason').textContent = s.reason || '';

  // Live stress overlay
  const stress = s.live_stress;
  const banner = document.getElementById('stress-banner');
  const note = document.getElementById('stress-note');
  if (macroIncomplete) {
    banner.textContent = '⚠️ 宏观数据不完整';
    banner.style.display = '';
    note.textContent = '关键宏观输入缺失或过期，暂停方向性判断';
    note.style.display = '';
  } else if (stress && stress.status === 'UNKNOWN') {
    const missing = (stress.unavailable || []).join('、');
    banner.textContent = '⚠️ 实时风险层不可用' + (missing ? '：' + missing : '');
    banner.style.display = '';
    note.textContent = `(宏观判断 ${VERDICT_CN[macroV]} 保留；实时风险未知，暂停加仓)`;
    note.style.display = '';
  } else if (stress && stress.status === 'STRESSED') {
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
  const regime = macroIncomplete ? null : s.qe_qt_regime;
  const direction = macroIncomplete ? null : s.netliq_dir;
  const policy = !macroIncomplete && s.policy_regime ? (POLICY_CN[s.policy_regime] || s.policy_regime) : '—';
  const regimeHost = document.getElementById('regime-sub');
  if (regimeHost) {
    regimeHost.innerHTML = [
      `<div class="state-tile ${toneForRegime(regime)}"><span>资产负债表</span><b>${REGIME_CN[regime] || regime || '—'}</b></div>`,
      `<div class="state-tile ${toneForDirection(direction)}"><span>净流动性</span><b>${dirCn(direction)}</b></div>`,
      `<div class="state-tile state-wide ${toneForPolicy(macroIncomplete ? null : s.policy_regime)}"><span>政策阶段</span><b>${policy}</b></div>`,
    ].join('');
  }
  const live = res.live || {};
  document.getElementById('asof').textContent =
    `SPX ${fmt(live.spx)} · VIX ${fmt(live.vix)} · DXY ${fmt(live.dxy)} · 10Y ${fmt(live.us10y)}%`;
  const quoteTimes = Object.values(live.quotes || {})
    .filter(q => q && q.status === 'OK' && q.sourceTimestamp)
    .map(q => q.sourceTimestamp).sort();
  const marketSourceTime = document.getElementById('market-source-time');
  const marketFetchTime = document.getElementById('market-fetch-time');
  if (marketSourceTime) marketSourceTime.textContent = fmtTs(quoteTimes.at(-1));
  if (marketFetchTime) marketFetchTime.textContent = fmtTs(live.fetchedAt);

  // Staleness: days since snapshot.date
  const snapshotDate = s.date || '';
  if (snapshotDate) {
    const today = new Date();
    const snap = new Date(snapshotDate + 'T00:00:00Z');
    const diffDays = Math.round((today.getTime() - snap.getTime()) / 86400000);
    const staleEl = document.getElementById('data-staleness');
    if (staleEl) {
      if (diffDays > 8) {
        staleEl.textContent = `FRED 宏观 · 截至 ${snapshotDate} · 已 ${diffDays} 天未更新`;
        staleEl.style.color = '#B7791F';
      } else {
        staleEl.textContent = `FRED 宏观 · 截至 ${snapshotDate} · 周更(约周四)`;
        staleEl.style.color = '';
      }
    }
  }

  // Coverage: N/total scoring factors with real data
  const coverage = s.coverage;
  const total = s.coverage_total ?? 8;
  const coverageEl = document.getElementById('data-coverage');
  if (coverageEl && coverage != null) {
    const n = Math.round(coverage * total);
    coverageEl.textContent = `覆盖 ${n}/${total} 因子`;
    coverageEl.style.color = n < total ? '#B7791F' : '';
  }
}

function renderGuidance(s) {
  const card = document.getElementById('guidance-card');
  if (!s || !s.guidance) { card.style.display = 'none'; return; }
  card.style.display = '';
  const g = s.guidance;

  // Tone is styling state only; keep layout classes intact.
  card.dataset.tone = g.tone || 'neutral';

  // Tier badge + tone color class
  const tierEl = document.getElementById('g-tier');
  tierEl.textContent = g.tierLabel;
  tierEl.className = 'g-badge ' + g.tone;

  document.getElementById('g-exposure').textContent = g.exposure;
  document.getElementById('g-lean').textContent = g.lean;

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

  // 实时读数 vs 触发线:让「未触发」可核验(数据来自 live_stress,每次打开页面实时抓)
  const st = s.live_stress;
  if (st && st.signals && st.thresholds) {
    const sig = st.signals, th = st.thresholds;
    const sgn = v => v >= 0 ? '+' : '−';
    const pct = v => v == null ? '—' : sgn(v) + Math.abs(v * 100).toFixed(1) + '%';
    const pp = v => v == null ? '—' : sgn(v) + Math.abs(v).toFixed(2) + 'pp';
    const num = v => v == null ? '—' : v.toFixed(1);
    triggersList.innerHTML += `<li class="stress-readouts">实时读数`
      + ` <span class="sr-item">VIX <b>${num(sig.vix)}</b><i>/线 ${th.vix}</i></span>`
      + ` <span class="sr-item">SPX 5日 <b>${pct(sig.spx5d)}</b><i>/线 ${(th.spxDd * 100).toFixed(0)}%</i></span>`
      + ` <span class="sr-item">10Y 5日 <b>${pp(sig.us10y5d)}</b><i>/线 +${th.y10}pp</i></span>`
      + ` <span class="sr-item">DXY 5日 <b>${pct(sig.dxy5d)}</b><i>/线 +${(th.dxy * 100).toFixed(0)}%</i></span></li>`;
  }
}

function dirCn(d) { return { UP: '在升', DOWN: '在收', FLAT: '走平' }[d] || '—'; }

// ── 数据来源与时效:逐层标注真实来源时间(全部取 API 真值,不估算)──────────
function fmtTs(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false, timeZoneName: 'short' });
}

function provLayer(tag, title, src, asof) {
  const cn = tag === 'live' ? '实时' : tag === 'provisional' ? 'PROVISIONAL' : 'OFFICIAL';
  return `<div class="prov-layer"><div class="prov-head"><span class="prov-tag ${tag}">${cn}</span><b>${title}</b></div>`
    + `<div class="prov-src">${src}</div><div class="prov-asof">${asof}</div></div>`;
}

function quoteQuality(quote) {
  if (!quote) return 'FAILED';
  if (quote.status === 'DIVERGENT') return `DIVERGENT · ${quote.reasonCode || 'SOURCE_DIVERGENCE'}`;
  if (quote.fallbackUsed) return `${quote.status} · FALLBACK`;
  return quote.status || 'FAILED';
}

function escapeHtml(value) {
  return String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

function quoteStatusClass(status) {
  return ['OK', 'STALE', 'DIVERGENT', 'FAILED'].includes(status) ? status.toLowerCase() : 'failed';
}

function quoteRows(live) {
  const labels = { spx: 'SPX', vix: 'VIX', dxy: 'DXY', us10y: '10Y' };
  return Object.entries(labels).map(([key, label]) => {
    const quote = (live.quotes || {})[key] || {};
    const instrument = quote.sourceLabel || quote.sourceSymbol || '—';
    const symbol = quote.sourceSymbol ? ` (${quote.sourceSymbol})` : '';
    return `<div class="quote-prov"><b>${escapeHtml(label)}</b>`
      + `<span>行情时间 ${escapeHtml(fmtTs(quote.sourceTimestamp))}</span>`
      + `<span>抓取时间 ${escapeHtml(fmtTs(quote.fetchedAt || live.fetchedAt))}</span>`
      + `<span>数据源 ${escapeHtml(quote.sourceName || '—')} · ${escapeHtml(instrument)}${escapeHtml(symbol)}${quote.fallbackUsed ? '（备用源）' : ''}</span>`
      + `<span>市场状态 ${escapeHtml(quote.marketState || 'UNKNOWN')}${quote.isDelayed ? ' · 延迟' : ''}</span>`
      + `<span class="quote-quality ${quoteStatusClass(quote.status)}">${escapeHtml(quoteQuality(quote))}</span></div>`;
  }).join('');
}

function renderProvenance(res) {
  const card = document.getElementById('provenance-card');
  const body = document.getElementById('provenance-body');
  if (!card || !body) return;
  const s = res.snapshot || {}, live = res.live || {}, ingest = res.ingest || {};
  const macroDate = s.date || '—';
  const ingestAt = fmtTs(ingest.ingest_at);
  const liveAt = fmtTs(live.fetchedAt);
  const provisional = res.snapshotChannel === 'nowcast';
  const macroTag = provisional ? 'provisional' : 'weekly';
  const macroTitle = provisional ? '宏观模型 · 周中预估' : '宏观模型 · 正式信号';
  const macroCadence = provisional
    ? '周中预估每日重算;底层 WALCL 周频(以周三为准,H.4.1 周四发布)'
    : '正式信号周更;WALCL 以周三为准,H.4.1 周四发布';
  body.innerHTML =
    provLayer(macroTag, `${macroTitle} · 打分 / 判定 / 净流动性`,
      '来源:FRED · 美联储 H.4.1 资产负债表(WALCL)、财政部 TGA、逆回购 RRP、SOFR−IORB、HY OAS、10Y(DGS10)、广义美元(DTWEXBGS)',
      `数据截至 <b>${macroDate}</b>　·　最近摄取 <b>${ingestAt}</b>　·　${macroCadence}`)
    + provLayer('live', '实时行情 · 顶部 SPX / VIX / DXY / 10Y',
      quoteRows(live),
      `本次抓取 <b>${liveAt}</b>　·　状态为 FALLBACK / STALE / DIVERGENT 时显式降级`)
    + provLayer('live', '实时风险覆盖 · stress / 判定降级',
      quoteRows({ quotes: (s.live_stress || {}).inputs || {}, fetchedAt: live.fetchedAt }),
      `计算抓取时间 <b>${liveAt}</b>　·　任一必需输入 FAILED / STALE / DIVERGENT 时风险层关闭`);
  card.style.display = '';
}

function renderScore(s) {
  if (!s) return;
  const score = s.score == null ? null : Math.round(s.score);
  document.getElementById('score-gauge').style.width = (score ?? 0) + '%';
  document.getElementById('score-num').textContent = score == null ? '—' : score;
  const factorQuality = s.factor_quality || {};
  const host = document.getElementById('factor-bars');
  host.innerHTML = '';
  for (const k of SCORING_FACTOR_KEYS) {
    const label = FACTOR_LABELS[k];
    const result = factorQuality[k] || { score: null, quality: 0, status: 'MISSING', asOf: null };
    const val = result.score == null ? null : Math.round(result.score);
    const st = val == null ? 'unavailable' : val >= 55 ? 'up' : val <= 45 ? 'down' : 'flat';
    const unavailable = result.status === 'STALE' || result.status === 'MISSING';
    const statusClass = String(result.status || 'MISSING').toLowerCase();
    const statusLabel = { OK: '正常', PARTIAL: '部分', STALE: '过期', MISSING: '缺失' }[result.status] || '缺失';
    const row = document.createElement('div');
    row.className = 'fb' + (unavailable ? ' is-unavailable' : '');
    row.innerHTML = `<span class="factor-name">${label}<small>${result.asOf || '无日期'} · <b class="factor-status ${statusClass}">${statusLabel}</b></small></span>`
      + `<span class="track"><span class="bar ${st}" style="width:${val ?? 0}%"></span></span>`
      + `<span class="fbv ${st}">${result.score == null ? '—' : val}</span>`;
    host.appendChild(row);
  }
}

function renderFactorTable(res) {
  const s = res.snapshot || {}; const live = res.live || {};
  const tbody = document.querySelector('#factor-table tbody');
  const tag = ok => `<span class="tag ${ok ? 'ok' : 'bad'}">${ok ? '顺风' : '逆风'}</span>`;
  const rows = [
    ['净流动性 (十亿)', fmt(s.netliq, 0), s.netliq == null ? null : s.netliq_dir === 'UP'],
    ['10Y 收益率', fmt(live.us10y) + '%', null],
    ['SOFR−IORB', fmt(s.sofr_iorb, 3), s.sofr_iorb == null ? null : s.sofr_iorb <= 0.05],
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
    height: Math.max(260, el.clientHeight || 360), layout: { background: { color: '#0B1220' }, textColor: '#8FA1C7' },
    grid: { vertLines: { color: '#1E2A40' }, horzLines: { color: '#1E2A40' } },
    rightPriceScale: { borderColor: '#35435E' }, leftPriceScale: { visible: true, borderColor: '#35435E' },
    timeScale: { borderColor: '#35435E' },
  });
  const spx = chart.addLineSeries({ color: '#E9EEF8', priceScaleId: 'right', lineWidth: 2 });
  const nl = chart.addLineSeries({ color: '#7C6DFF', priceScaleId: 'left', lineWidth: 2 });
  const spxData = rows.filter(r => r.spx != null).map(r => ({ time: r.date, value: r.spx }));
  const nlData = rows.filter(r => r.netliq != null).map(r => ({ time: r.date, value: r.netliq }));
  spx.setData(spxData);
  nl.setData(nlData);
  chart.timeScale().fitContent();
  new ResizeObserver(() => chart.applyOptions({
    width: el.clientWidth,
    height: Math.max(260, el.clientHeight || 320),
  })).observe(el);

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
  const source = res?.current?.date
    ? `<div class="ex-source">正式信号 · OFFICIAL · 来源日期 <b>${res.current.date}</b></div>`
    : '';
  if (res && res.error === 'data_incomplete') {
    body.innerHTML = source + '<p class="ex-note">宏观数据不完整，暂不生成分数归因。</p>';
    return;
  }
  if (!res || res.error === 'no_data' || !res.current) {
    body.innerHTML = '<p class="ex-note">暂无数据</p>';
    return;
  }
  body.innerHTML = source + renderAttribution(res) + renderContribution(res.contributions) + renderNetliq(res.netliq, res.window);
}

// 信号变化归因 = Δ分瀑布图(从基准分逐因子累加落到当前分)
function renderAttribution(res) {
  const label = EX_WINDOW_LABEL[res.window] || '基准';
  if (res.attribution_unavailable_reason === 'factor_availability_changed') {
    return `<div class="ex-sub">这次为什么变(较${label})</div>`
      + `<p class="ex-note">因子可用性发生变化，当前与基准无法可靠比较，暂不生成变化归因。</p>`;
  }
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

  const attrSum = res.attribution.reduce((s, a) => s + a.deltaContribution, 0);
  const clampNote = Math.abs(attrSum - d) > 0.5 ? '<p class="ex-note">(含分数封顶调整)</p>' : '';

  return `<div class="ex-sub">这次为什么变(较${label})</div>`
    + `<div class="ex-head-line">基准 ${R.toFixed(1)} → 当前 ${C.toFixed(1)} <span class="${dCls}">(${dSign}${d.toFixed(1)})</span></div>`
    + bars
    + clampNote;
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

// ── 回测稳健性面板 ────────────────────────────────────────────────────────
async function fetchRobust() {
  const card = document.getElementById('robust-card');
  const body = document.getElementById('robust-body');
  if (!card || !body) return;
  try {
    const r = await fetch('/api/robustness').then(x => x.json());
    if (!r || !r.ic) { body.innerHTML = '<p class="rb-note">数据不足</p>'; card.style.display = ''; return; }
    body.innerHTML = renderRobust(r);
    card.style.display = '';
  } catch (e) {
    body.innerHTML = '<p class="rb-note">稳健性加载失败,稍后重试</p>';
    card.style.display = '';
  }
}

function rbFinite(x) { const n = Number(x); return Number.isFinite(n) ? n : null; }
function rbPct(x, d = 1) { const n = rbFinite(x); return n == null ? '—' : (n * 100).toFixed(d) + '%'; }
function rbMaybePct(x, d = 1) { return x == null ? '—' : rbPct(x, d); }
function rbMaybeNum(x, d = 2) { const n = rbFinite(x); return n == null ? '—' : n.toFixed(d); }
function rbCount(x) { const n = rbFinite(x); return n == null ? '—' : String(Math.max(0, Math.trunc(n))); }
function rbValidationRate(metric, d = 1) { return metric?.value == null ? '—' : rbPct(metric.value, d); }
function rbIcCls(x) { const n = rbFinite(x); return n != null && n >= 0 ? 'rb-pos' : 'rb-neg'; }
function rbEsc(s) { return String(s ?? '—').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }

function renderRobust(r) {
  const ic = r.ic, st = r.strategy, b = ic.bootstrap, sh = st.sharpe;
  const icBlock = `<div class="rb-sub">IC 稳健性(${r.horizon_weeks} 周)</div>`
    + `<div class="rb-stat"><span class="k">IC 点估</span><span class="v ${rbIcCls(b.point)}">${b.point.toFixed(3)} <span class="rb-ci">95%CI [${b.ci_lo.toFixed(3)}, ${b.ci_hi.toFixed(3)}] · p(IC≤0)=${b.p_value.toFixed(2)}</span></span></div>`
    + `<div class="rb-stat"><span class="k">重叠样本</span><span class="v">n=${ic.overlapping.n} · IC=${ic.overlapping.ic_spearman.toFixed(3)}</span></div>`
    + `<div class="rb-stat"><span class="k">非重叠样本(独立)</span><span class="v">n=${ic.non_overlapping.n} · IC=${ic.non_overlapping.ic_spearman.toFixed(3)}</span></div>`;

  const stratBlock = `<div class="rb-sub">LEGACY_WEEKLY 策略稳健性(score&gt;55 多/空)</div>`
    + `<div class="rb-stat"><span class="k">年化 vs 买入持有</span><span class="v">${rbPct(st.ann_return)} vs ${rbPct(st.buyhold_ann)}</span></div>`
    + `<div class="rb-stat"><span class="k">Sharpe</span><span class="v ${rbIcCls(sh.point)}">${sh.point.toFixed(2)} <span class="rb-ci">95%CI [${sh.ci_lo.toFixed(2)}, ${sh.ci_hi.toFixed(2)}] · p(≤0)=${sh.p_value.toFixed(2)}</span></span></div>`
    + `<div class="rb-stat"><span class="k">最大回撤</span><span class="v rb-neg">−${rbPct(st.max_drawdown)}</span></div>`
    + `<div class="rb-stat"><span class="k">换手</span><span class="v">${rbPct(st.turnover_per_period)}/期 · ${st.turnover_annual.toFixed(1)}/年</span></div>`;

  const regimeBlock = `<div class="rb-sub">分 regime IC</div>`
    + Object.entries(r.regimes).map(([axis, buckets]) => {
      const rows = Object.entries(buckets).map(([k, v]) =>
        `<tr><td>${REGIME_BUCKET_LABEL[k] || rbEsc(k)}</td><td class="num">${v.n}</td><td class="num ${rbIcCls(v.ic_spearman)}">${v.ic_spearman.toFixed(3)}</td></tr>`).join('');
      return `<table class="rb-table"><thead><tr><th>${REGIME_AXIS_LABEL[axis] || rbEsc(axis)}</th><th class="num">n</th><th class="num">IC</th></tr></thead><tbody>${rows}</tbody></table>`;
    }).join('');

  const validationBlock = renderPurgedValidation(r.validation);
  const concl = `<div class="rb-concl">${robustConclusion(r)}</div>`;
  const notes = (r.caveats || []).map(c => `<p class="rb-note">· ${rbEsc(c)}</p>`).join('');
  return validationBlock + icBlock + stratBlock + regimeBlock + concl + notes;
}

function renderPurgedValidation(validation) {
  if (!validation) return '';
  const protocol = validation.protocol || {};
  const provenance = validation.provenance || {};
  const statusText = rbEsc(validation.status || '—');
  const provenanceText = `${rbEsc(provenance.completeness || '—')} · governed ${rbCount(provenance.governedCount)} / legacy ${rbCount(provenance.legacyCount)} / invalid ${rbCount(provenance.invalidCount)}`;
  if (validation.status === 'DATA_INCOMPLETE') {
    return `<div class="rb-sub">${rbEsc(protocol.protocol || 'PURGED_VALIDATION_V1')}</div>`
      + `<p class="rb-note">状态 ${statusText} · ${provenanceText}</p>`
      + `<p class="rb-note">PIT / provenance 不完整（${rbEsc(validation.reason || '未分类')}），专业验证指标已关闭；旧版诊断仍单独展示。</p>`;
  }
  const metrics = validation.aggregateMetrics;
  const holdout = validation.holdout || {};
  const holdoutText = holdout.status === 'PENDING_MATURITY'
    ? `PENDING_MATURITY（登记自 ${rbEsc(holdout.registration?.holdoutFrom || '—')}，不把历史尾部伪称 unseen）`
    : rbEsc(holdout.status || '—');
  if (!metrics) {
    return `<div class="rb-sub">${rbEsc(protocol.protocol || 'PURGED_VALIDATION_V1')}</div>`
      + `<p class="rb-note">状态 ${statusText} · ${provenanceText}</p>`
      + `<p class="rb-note">回溯样本不足 · 前瞻 holdout ${holdoutText} · 尾部 ${rbEsc(holdout.tailStatus || '—')}</p>`;
  }
  const status = metric => rbEsc(metric?.status || '—');
  const foldTail = (validation.folds || []).map(fold => `${rbEsc(fold.tailCalibrationStatus || '—')}/${status(fold.metrics?.tail?.recall)}`).join(' · ') || '—';
  const holdoutMetrics = holdout.metrics;
  const holdoutMetricText = holdoutMetrics
    ? ` · 方向 ${rbValidationRate(holdoutMetrics.direction)} (${status(holdoutMetrics.direction)}) · IC ${rbMaybeNum(holdoutMetrics.ic?.value, 3)} (${status(holdoutMetrics.ic)})`
    : '';
  return `<div class="rb-sub">${rbEsc(protocol.protocol || 'PURGED_VALIDATION_V1')} · purged walk-forward</div>`
    + `<div class="rb-stat"><span class="k">验证状态 / provenance</span><span class="v">${statusText} · ${provenanceText}</span></div>`
    + `<div class="rb-stat"><span class="k">方向命中</span><span class="v">${rbValidationRate(metrics.direction)} · n=${rbCount(metrics.direction?.n)} · ${status(metrics.direction)}</span></div>`
    + `<div class="rb-stat"><span class="k">正式 verdict 命中</span><span class="v">${rbValidationRate(metrics.formalVerdict)} · n=${rbCount(metrics.formalVerdict?.n)} · ${status(metrics.formalVerdict)}</span></div>`
    + `<div class="rb-stat"><span class="k">风险精确率 / 下行召回</span><span class="v">${rbValidationRate(metrics.risk.precision)} / ${rbValidationRate(metrics.risk.downsideRecall)} · ${status(metrics.risk.precision)}</span></div>`
    + `<div class="rb-stat"><span class="k">IC（Spearman）</span><span class="v">${rbMaybeNum(metrics.ic?.value, 3)} · n=${rbCount(metrics.ic?.n)} · ${status(metrics.ic)}</span></div>`
    + `<div class="rb-stat"><span class="k">尾部风险 q10 召回 / 精确率</span><span class="v">${rbValidationRate(metrics.tail.recall)} (${status(metrics.tail.recall)}) / ${rbValidationRate(metrics.tail.precision)} (${status(metrics.tail.precision)}) · fold-training-only</span></div>`
    + `<p class="rb-note">fold 尾部校准/指标状态：${foldTail}</p>`
    + `<p class="rb-note">重叠 n=${rbCount(validation.overlappingN)} · 区间非重叠 n=${rbCount(validation.independentN)} · 前瞻 holdout ${holdoutText} · 尾部 ${rbEsc(holdout.tailStatus || '—')}${holdoutMetricText}</p>`;
}

function robustConclusion(r) {
  const b = r.ic.bootstrap, no = r.ic.non_overlapping;
  const edge = b.ci_lo > 0 ? 'IC 稳健为正' : (b.point > 0 ? 'IC 为正但 95%CI 跨 0(弱)' : 'IC 不显著');
  const bs = r.regimes.balance_sheet || {};
  const best = Object.entries(bs).sort((a, x) => x[1].ic_spearman - a[1].ic_spearman)[0];
  const bestTxt = best ? `资产负债表 ${REGIME_BUCKET_LABEL[best[0]] || best[0]} 期最强(IC=${best[1].ic_spearman.toFixed(2)})` : '';
  return `${edge};非重叠独立样本仅 n=${no.n}(IC=${no.ic_spearman.toFixed(3)})——重叠版显著性被高估。${bestTxt}。定位:弱信号宏观风控仪表盘,非择时工具。`;
}

function renderScoreStressDiagnostics(result) {
  if (!result) return '<p class="rb-note">诊断数据不可用</p>';
  const nullable = (value, digits = 2) => value == null ? '—' : rbMaybeNum(value, digits);
  const status = rbEsc(result.status || 'DATA_INCOMPLETE');
  const protocol = rbEsc(result.protocol?.protocol || 'SCORE_STRESS_DIAGNOSTICS_V1');
  const provenance = result.provenance || {};
  const header = `<div class="rb-sub">${protocol}</div>`
    + `<p class="rb-note">状态 ${status} · as_of ${rbEsc(result.as_of_cutoff || '—')}`
    + ` · ${rbEsc(provenance.methodology || '—')}</p>`;
  const reason = result.reason
    ? `<p class="rb-note">${rbEsc(result.reason)}${result.detail ? ` · ${rbEsc(result.detail)}` : ''}</p>` : '';

  const buckets = Array.isArray(result.score_buckets) ? result.score_buckets : [];
  const bucketTable = buckets.length === 0 ? '<p class="rb-note">分数桶：—</p>'
    : `<div class="rb-sub">分数桶（重叠 n / 区间非重叠 n）</div><table class="rb-table"><thead><tr>`
      + '<th>分数</th><th>周</th><th class="num">均值</th><th class="num">中位</th><th class="num">负收益概率</th><th class="num">q10</th><th class="num">最差回撤</th><th class="num">n / 独立n</th><th>状态</th></tr></thead><tbody>'
      + buckets.map(row => `<tr><td>${rbEsc(`${row.from ?? '—'}–${row.to ?? '—'}`)}</td>`
        + `<td>${rbEsc(row.horizonWeeks)}</td><td class="num">${rbMaybePct(row.mean)}</td>`
        + `<td class="num">${rbMaybePct(row.median)}</td><td class="num">${rbMaybePct(row.negativeProbability)}</td>`
        + `<td class="num">${rbMaybePct(row.q10)}</td><td class="num">${rbMaybePct(row.worstEpisodeDrawdown)}</td>`
        + `<td class="num">${rbCount(row.n)} / ${rbCount(row.independentN)}</td>`
        + `<td>${rbEsc(row.status || '—')} · ${rbEsc(row.probabilityStatus || '—')}</td></tr>`).join('')
      + '</tbody></table>';

  const multiple = result.multiple_testing || {};
  const dsr = result.formal_dsr || multiple.dsr || {};
  const declaredTrials = multiple.declaredUpperBoundCounts?.trials;
  const trialDisplay = multiple.exactTrialCount == null
    ? `${rbCount(declaredTrials)}（声明上界，未枚举）` : rbCount(multiple.exactTrialCount);
  const multipleBlock = `<div class="rb-sub">多重检验与 DSR</div>`
    + `<div class="rb-stat"><span class="k">审计状态</span><span class="v">${rbEsc(multiple.status || '—')}</span></div>`
    + `<div class="rb-stat"><span class="k">候选 / trial</span><span class="v">${rbCount(multiple.candidateCount)} / ${rbEsc(trialDisplay)}</span></div>`
    + `<div class="rb-stat"><span class="k">Deflated Sharpe</span><span class="v">${rbEsc(dsr.status || '—')} · ${nullable(dsr.value, 3)}</span></div>`
    + `<p class="rb-note">${rbEsc(dsr.reason || '没有完整正式日频 trial universe，不计算数值。')}</p>`;

  const events = Array.isArray(result.stress_events) ? result.stress_events : [];
  const eventTable = events.length === 0 ? '<p class="rb-note">压力事件：—</p>'
    : `<div class="rb-sub">固定压力事件库</div><table class="rb-table"><thead><tr><th>事件</th><th>覆盖</th><th class="num">SPX 回撤</th><th class="num">4/8/13 周 n</th></tr></thead><tbody>`
      + events.map(event => {
        const counts = Array.isArray(event.horizons) ? event.horizons.map(row => rbCount(row.n)).join('/') : '—';
        return `<tr><td>${rbEsc(event.id)}<br><small>${rbEsc(event.from)}–${rbEsc(event.to)}</small></td>`
          + `<td>${rbEsc(event.status || '—')}</td><td class="num">${rbMaybePct(event.spxDrawdown)}</td>`
          + `<td class="num">${rbEsc(counts)}</td></tr>`;
      }).join('') + '</tbody></table>';
  const candidate = result.candidate_comparison || {};
  const candidateNote = `<p class="rb-note">候选对比：${rbEsc(candidate.status || 'CANDIDATE_NOT_PROVIDED')}；未提供独立 versioned PIT artifact 时不伪造比较。</p>`;
  return header + reason + bucketTable + multipleBlock + eventTable + candidateNote;
}

async function fetchScoreStressDiagnostics() {
  const card = document.getElementById('score-stress-card');
  const body = document.getElementById('score-stress-body');
  if (!card || !body) return;
  try {
    const result = await fetch('/api/v1/diagnostics').then(response => response.json());
    body.innerHTML = renderScoreStressDiagnostics(result);
  } catch (error) {
    body.innerHTML = '<p class="rb-note">分数与压力诊断加载失败，稍后重试</p>';
  }
  card.style.display = '';
}

function renderLiquidityStructureChallenger(result) {
  const status = rbEsc(result?.status || 'DATA_INCOMPLETE');
  const reason = result?.reason ? ` · ${rbEsc(result.reason)}` : '';
  const header = `<div class="rb-concl">${status}${reason} · Shadow only · Champion unchanged</div>`;
  const tga = result?.tga_buffer || {};
  const policy = result?.policy_regime || {};
  const walcl = result?.walcl_policy || {};
  const weights = result?.weight_benchmarks || {};
  const structure = `<div class="rb-sub">TGA 冲击 / RRP 缓冲</div>`
    + `<div class="rb-stat"><span class="k">状态 / 缓冲层</span><span class="v">${rbEsc(tga.status || '—')} / ${rbEsc(tga.bufferState || '—')}</span></div>`
    + `<div class="rb-stat"><span class="k">原始 / 有效 TGA 冲击</span><span class="v">${rbMaybeNum(tga.tgaShock)} / ${rbMaybeNum(tga.effectiveTgaShock)}</span></div>`
    + `<div class="rb-sub">政策阶段 WALCL</div>`
    + `<div class="rb-stat"><span class="k">阶段 / 扩表状态</span><span class="v">${rbEsc(policy.regime || policy.status || '—')} / ${rbEsc(walcl.impulse || '—')}</span></div>`
    + `<div class="rb-stat"><span class="k">政策解释分</span><span class="v">${rbMaybeNum(walcl.score)}</span></div>`;
  const benchmark = `<div class="rb-sub">8 因子权重基准（vol 不进入基础分）</div>`
    + `<div class="rb-stat"><span class="k">等权 / 当前 / 50-50</span><span class="v">${rbMaybeNum(weights.equal8)} / ${rbMaybeNum(weights.current8)} / ${rbMaybeNum(weights.blend8)}</span></div>`;
  const evaluation = result?.formal_ablation_evaluation || {};
  const armLabels = {
    A_CURRENT_8: 'A 当前 8 因子', B_WITHOUT_CREDIT: 'B 移除 credit',
    C_WITHOUT_FUNDING: 'C 移除 funding', D_WITHOUT_CREDIT_FUNDING: 'D 移除两者',
  };
  const rows = Object.entries(evaluation.arms || {}).map(([key, arm]) => {
    const h13 = arm?.horizons?.['13'] || {};
    const portfolio = arm?.portfolio || {};
    return `<tr><td>${rbEsc(armLabels[key] || key)}</td>`
      + `<td>${rbEsc(arm?.status || '—')}</td>`
      + `<td class="num">${rbMaybeNum(h13.overlapping?.value)} (${rbCount(h13.overlapping?.n)})</td>`
      + `<td class="num">${rbMaybeNum(h13.independent?.value)} (${rbCount(h13.independent?.n)})</td>`
      + `<td class="num">${rbMaybeNum(portfolio.betaMatchedSharpeDelta)}</td>`
      + `<td class="num">${rbMaybePct(h13.tailLossQ10)}</td>`
      + `<td class="num">${rbMaybePct(portfolio.maxDrawdown)}</td></tr>`;
  }).join('');
  const ablation = `<div class="rb-sub">Credit / Funding 正式 PIT 消融 · 13 周为主，4 / 8 周为辅</div>`
    + `<p class="rb-note">每个 arm 独立按时间顺序执行一次 hysteresis；同一完整 cohort，不按 arm 删除样本。评价状态：${rbEsc(evaluation.status || '—')}${evaluation.reason ? ` · ${rbEsc(evaluation.reason)}` : ''}</p>`
    + '<table class="rb-table"><thead><tr><th>Arm</th><th>状态</th><th class="num">13 周 OOS IC</th><th class="num">非重叠 IC</th><th class="num">Beta 匹配 Sharpe 差</th><th class="num">q10 尾部损失</th><th class="num">最大回撤</th></tr></thead><tbody>'
    + (rows || '<tr><td colspan="7">—</td></tr>') + '</tbody></table>';
  return header + structure + benchmark + ablation;
}

async function fetchLiquidityStructureChallenger() {
  const card = document.getElementById('liquidity-structure-card');
  const body = document.getElementById('liquidity-structure-body');
  if (!card || !body) return;
  try {
    const result = await fetch('/api/v1/challengers/liquidity-structure').then(response => response.json());
    body.innerHTML = renderLiquidityStructureChallenger(result);
  } catch (error) {
    body.innerHTML = '<p class="rb-note">流动性结构 Challenger 加载失败，稍后重试</p>';
  }
  card.style.display = '';
}

async function fetchEventBacktest() {
  const card = document.getElementById('event-backtest-card');
  const body = document.getElementById('event-backtest-body');
  if (!card || !body) return;
  try {
    const result = await fetch('/api/backtest').then(response => response.json());
    body.innerHTML = renderEventBacktest(result);
  } catch (error) {
    body.innerHTML = '<p class="rb-note">事件时间回测加载失败，稍后重试</p>';
  }
  card.style.display = '';
}

function renderEventBacktest(result) {
  const event = result && result.event_time;
  if (!event) return '<p class="rb-note">事件时间数据不足</p>';
  const assumptions = event.assumptions || {};
  const provenance = event.provenance || {};
  const assumption = (value) => value == null ? '—' : value;
  const disclosure = `<div class="rb-sub">正式绩效 · event-time</div>`
    + `<p class="rb-note">日频收盘执行：只有 tradable_at 严格早于当日 17:00:00Z 保守最早美股收盘界线，才使用该日实际 SPX 日线；等于或晚于界线则等待下一条实际日线。23:59:59Z 只是日频记账标记，不是交易所实际收盘时间戳。</p>`
    + `<p class="rb-note">现金：SOFR ACT/360（仅使用区间起点之前日期的已知 fixing）· 手续费 ${assumption(assumptions.commissionBps)}bp · 基础滑点 ${assumption(assumptions.baseSlippageBps)}bp · 高波动额外滑点 ${assumption(assumptions.highVolExtraSlippageBps)}bp（VIX≥${assumption(assumptions.vixStressLevel)}，陈旧/缺失同样保守计入）。</p>`
    + `<p class="rb-note">超过 100% 敞口：SOFR + ${assumption(assumptions.financingSpreadBps)}bp 融资；SPX adjusted_close 为 FRED 指数收盘，不含股息。</p>`
    + `<p class="rb-note">正式仓位：DASHBOARD_EXPOSURE_TIERS_V1（100% / 90% / 75% / 50% / 25%）；历史 stress 只用冻结周快照 VIX 的 PIT_SNAPSHOT_VIX_PROXY，缺失时最多 75%，不读取决策后激活的日线。</p>`
    + `<p class="rb-note">公平基准共享同一净值窗口、SOFR 与交易成本：100% SPX；平均 Beta 匹配静态 SPX/现金；10% 波动目标只用前20个已完成交易日收益且上限100%；200DMA 只比较前一收盘与此前200个收盘均线。估计器可使用同一 cutoff 已可见的窗口前 warm-up，但不读取目标日价格。</p>`;
  const reproducible = provenance.revisionPolicy === 'APPEND_ONLY_AS_OF'
    && provenance.responseReproducible === true;
  const provenanceNote = `<p class="rb-note">输入版本：${rbEsc(provenance.revisionPolicy || '—')}`
    + ` · as_of cutoff ${rbEsc(provenance.asOfCutoff || '—')}`
    + ` · max fetched ${rbEsc(provenance.maxFetchedAt || '—')}`
    + ` · sources ${rbEsc((provenance.sourceLabels || []).join(', ') || '—')}`
    + ` · source runs ${assumption(provenance.dataRunCount)}`
    + ` · activation runs ${assumption(provenance.revisionRunCount)}`
    + ` · ${reproducible ? '响应可按同一 cutoff 重放' : 'provenance 不完整，正式绩效关闭'}。</p>`;
  const legacy = result.strategy_long_flat && result.strategy_long_flat.methodology === 'LEGACY_WEEKLY'
    ? '<p class="rb-note">旧 weekly long/flat 仅保留为 LEGACY_WEEKLY 诊断，不代表正式绩效。</p>'
    : '';
  if (event.status === 'DATA_INCOMPLETE') {
    return disclosure + provenanceNote + legacy
      + `<div class="rb-concl">数据不完整，不展示绩效：${rbEsc(event.reason || '未提供原因')}</div>`;
  }
  const portfolio = event.portfolio;
  if (!portfolio || portfolio.methodology !== 'DASHBOARD_EXPOSURE_TIERS_V1') {
    return disclosure + provenanceNote + legacy
      + '<div class="rb-concl">数据不完整，不展示绩效：正式组合分析缺失</div>';
  }
  const metricRow = (label, entry, cumulativeTimingReturnDifference) => {
    const metrics = entry.metrics || {};
    return `<tr><td>${label}</td>`
      + `<td class="num">${rbMaybePct(metrics.totalReturn)}</td>`
      + `<td class="num">${cumulativeTimingReturnDifference == null ? '—' : rbMaybePct(cumulativeTimingReturnDifference)}</td>`
      + `<td class="num">${rbMaybeNum(metrics.averageBeta)}</td>`
      + `<td class="num">${rbMaybePct(metrics.annualizedVolatility)}</td>`
      + `<td class="num">${rbMaybeNum(metrics.sharpe)}</td>`
      + `<td class="num">${rbMaybeNum(metrics.sortino)}</td>`
      + `<td class="num">${rbMaybePct(metrics.maxDrawdown)}</td>`
      + `<td class="num">${metrics.maxDrawdownDurationSessions == null ? '—' : metrics.maxDrawdownDurationSessions}</td></tr>`;
  };
  const portfolioTable = `<div class="rb-sub">组合与公平基准</div>`
    + '<table class="rb-table"><thead><tr><th>组合</th><th class="num">累计收益</th><th class="num">累计择时收益差</th><th class="num">平均 Beta</th><th class="num">年化波动</th><th class="num">Sharpe</th><th class="num">Sortino</th><th class="num">最大回撤</th><th class="num">最大回撤持续期</th></tr></thead><tbody>'
    + metricRow('Dashboard 分档', portfolio.strategy, portfolio.cumulativeTimingReturnDifference)
    + metricRow('100% SPX', portfolio.benchmarks.spxBuyHold, null)
    + metricRow('平均 Beta 匹配静态 SPX/现金', portfolio.benchmarks.betaMatchedStatic, null)
    + metricRow('前20个已完成交易日 · 10% 波动目标', portfolio.benchmarks.volatilityTarget, null)
    + metricRow('前一收盘 200DMA 风控', portfolio.benchmarks.movingAverage200, null)
    + '</tbody></table>';
  const finalRow = event.nav && event.nav.length ? event.nav[event.nav.length - 1] : null;
  return disclosure + provenanceNote + legacy + portfolioTable
    + `<div class="rb-stat"><span class="k">累计收益</span><span class="v">${rbPct(event.totals.totalReturn)}</span></div>`
    + `<div class="rb-stat"><span class="k">日频净值区间</span><span class="v">${event.totals.sessions} 个交易日</span></div>`
    + `<div class="rb-stat"><span class="k">执行 / 同收盘替换 / 末端未执行</span><span class="v">${event.executions.length} / ${event.superseded.length} / ${event.unexecuted.length}</span></div>`
    + `<div class="rb-stat"><span class="k">期末敞口</span><span class="v">${finalRow ? rbPct(finalRow.exposure, 0) : '—'}</span></div>`;
}

main().catch(e => { showBanner('⚠️ 加载失败，稍后重试（' + (e && e.message ? e.message : '网络错误') + '）'); });

// ── 全球流动性卡(display-only)────────────────────────────────────────────
async function renderGlobal() {
  const card = document.getElementById('global-card');
  const body = document.getElementById('global-body');
  if (!card || !body) return;

  let res;
  try { res = await fetch('/api/global-liquidity').then(r => r.json()); }
  catch { return; } // network failure → leave hidden, never invent numbers

  if (!res || res.error || !res.latest || !res.series || !res.series.length) {
    body.innerHTML = '<p class="muted" style="color:#697386;">数据不足(全球序列尚未摄取)</p>';
    card.style.display = '';
    return;
  }

  const L = res.latest;
  const T = (b) => '$' + (b / 1000).toFixed(2) + 'T';
  const dirCls = L.dir === 'UP' ? '#1A7F4B' : L.dir === 'DOWN' ? '#C0392B' : '#697386';
  const dirTxt = L.dir === 'UP' ? '↑' : L.dir === 'DOWN' ? '↓' : '→';
  const trend = L.trend13wPct == null ? '—' : (L.trend13wPct >= 0 ? '+' : '') + L.trend13wPct.toFixed(1) + '%';

  body.innerHTML =
    '<div style="font-size:1.6rem;font-weight:700;color:var(--panel-ink);">' + T(L.gl) +
      ' <span style="font-size:1rem;font-weight:600;color:' + dirCls + ';">' + dirTxt + ' ' + trend + ' (13周)</span></div>' +
    '<div style="font-size:0.85rem;color:var(--panel-muted);margin-top:0.35rem;">' +
      'Fed ' + T(L.fed) + ' (' + Math.round(L.fedPct * 100) + '%) · ' +
      'ECB ' + T(L.ecb) + ' (' + Math.round(L.ecbPct * 100) + '%) · ' +
      'BOJ ' + T(L.boj) + ' (' + Math.round(L.bojPct * 100) + '%)</div>';
  card.style.display = '';

  const el = document.getElementById('global-chart');
  if (el && window.LightweightCharts) {
    glChart = LightweightCharts.createChart(el, {
      height: Math.max(110, el.clientHeight || 220), layout: { background: { color: '#0B1220' }, textColor: '#8FA1C7' },
      grid: { vertLines: { color: '#1E2A40' }, horzLines: { color: '#1E2A40' } },
      rightPriceScale: { borderColor: '#35435E' }, leftPriceScale: { visible: false },
      timeScale: { borderColor: '#35435E' },
    });
    const gl = glChart.addLineSeries({ color: '#7C6DFF', priceScaleId: 'right', lineWidth: 2 });
    gl.setData(res.series.map(p => ({ time: p.date, value: p.gl })));
    glChart.timeScale().fitContent();
    new ResizeObserver(() => glChart.applyOptions({
      width: el.clientWidth,
      height: Math.max(110, el.clientHeight || 180),
    })).observe(el);
  }
}
