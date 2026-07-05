# Command Center Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert the existing macro liquidity dashboard into a full-screen One-Screen Command Center.

**Architecture:** Keep the current Cloudflare Worker, static assets, API routes, and Lightweight Charts library. Restructure only `public/index.html`, `public/styles.css`, and the browser bindings in `public/app.js`, with static Vitest checks in `test/ui-assets.test.ts`.

**Tech Stack:** Cloudflare Worker, Workers Static Assets, D1, native HTML/CSS/JS, Lightweight Charts, Vitest, TypeScript.

## Global Constraints

- Do not change scoring logic, factor weights, API response shape, D1 schema, cron ingestion, or algorithm documentation content.
- Do not add new charting libraries, WebGL, smooth-scroll libraries, or external font/CDN dependencies.
- Keep `/algorithm` compatible with shared styles.
- Keep favicon and mobile no-horizontal-scroll fixes.
- First viewport uses a dark full-screen command center stage.
- Motion is restrained and respects `prefers-reduced-motion`.

---

### Task 1: Static Regression Coverage

**Files:**
- Modify: `test/ui-assets.test.ts`

**Interfaces:**
- Consumes: `public/index.html`, `public/styles.css`
- Produces: Static checks that fail until command-center structure and CSS are present.

- [ ] **Step 1: Add failing tests**

Extend `test/ui-assets.test.ts` with checks for:

```ts
it('declares the command-center first viewport structure', () => {
  const html = read('public/index.html');

  expect(html).toContain('class="command-shell"');
  expect(html).toContain('class="command-center"');
  expect(html).toContain('class="decision-panel');
  expect(html).toContain('class="chart-panel');
  expect(html).toContain('class="factor-panel');
  expect(html).toContain('id="score-card"');
  expect(html).toContain('id="guidance-card"');
});

it('styles the command center as a full-screen responsive stage', () => {
  const css = read('public/styles.css');

  expect(css).toMatch(/\.command-shell[^}]*min-height\s*:\s*100svh/s);
  expect(css).toMatch(/\.command-center[^}]*grid-template-columns\s*:[^;]*minmax\(280px,\s*0\.7fr\)[^;]*minmax\(420px,\s*1\.55fr\)[^;]*minmax\(260px,\s*0\.65fr\)/s);
  expect(css).toMatch(/\.chart-panel[^}]*min-height\s*:\s*0/s);
  expect(css).toMatch(/\.factor-panel[^}]*min-width\s*:\s*0/s);
  expect(css).toMatch(/@media\(prefers-reduced-motion:reduce\)/s);
  expect(css).toMatch(/@media\(max-width:980px\)[\s\S]*\.command-center[^}]*grid-template-columns\s*:\s*1fr/s);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
env -u NODE_OPTIONS npm test -- test/ui-assets.test.ts
```

Expected: FAIL because `command-shell` / `command-center` and full-screen CSS are not implemented yet.

- [ ] **Step 3: Commit is deferred**

Do not commit after this task because the repository already contains related in-progress UI changes from the favicon/mobile fix and this task is only the red phase.

### Task 2: Command-Center Markup And Styling

**Files:**
- Modify: `public/index.html`
- Modify: `public/styles.css`

**Interfaces:**
- Consumes: Existing element IDs used by `public/app.js`: `verdict-card`, `verdict-label`, `verdict-reason`, `stress-banner`, `stress-note`, `regime-sub`, `guidance-card`, `g-tier`, `g-exposure`, `g-lean`, `g-diverge`, `g-triggers`, `score-gauge`, `score-num`, `factor-bars`, `chart`, `leg-nl`, `leg-spx`.
- Produces: A full-screen `.command-shell` and `.command-center` DOM that keeps those IDs.

- [ ] **Step 1: Restructure `public/index.html`**

Replace the top-level first viewport with this structure, keeping the existing secondary sections below:

```html
<main class="container command-shell">
  <header class="topbar">
    <div class="tb-top">
      <div>
        <p class="eyebrow">Macro Liquidity Command</p>
        <h1>美股流动性看板</h1>
      </div>
      <a class="nav-link" href="/algorithm">算法说明 →</a>
    </div>
    <div class="tb-status">
      <div class="tb-market"><span class="tb-live">实时</span><span id="asof">—</span></div>
      <div class="tb-meta" title="顶部行情为实时(每次打开抓取);下方为 FRED 宏观数据 —— 核心的美联储资产负债表(WALCL)按周更新,通常周四出 H.4.1">
        <span id="data-staleness">—</span>
        <span id="data-coverage">—</span>
      </div>
    </div>
  </header>

  <section class="command-center" aria-label="宏观流动性指挥舱">
    <section class="panel decision-panel card verdict" id="verdict-card">
      <div id="stress-banner" class="stress-banner" style="display:none"></div>
      <div class="panel-kicker">Current Regime</div>
      <div class="verdict-main">
        <div class="verdict-label" id="verdict-label">—</div>
        <div class="verdict-reason" id="verdict-reason">加载中…</div>
        <div id="stress-note" class="stress-note" style="display:none"></div>
      </div>
      <div class="score-block" id="score-card">
        <div class="score-topline">
          <span>顺风指数</span>
          <strong id="score-num">—</strong>
        </div>
        <div class="gauge"><div class="gauge-fill" id="score-gauge"></div></div>
      </div>
      <div class="verdict-sub" id="regime-sub"></div>
      <section class="guidance" id="guidance-card" style="display:none">
        <h2>操作建议 · 仓位旋钮</h2>
        <div class="g-tier"><span class="g-badge" id="g-tier">—</span><span class="g-exposure" id="g-exposure"></span></div>
        <div class="g-lean" id="g-lean"></div>
        <div class="g-diverge" id="g-diverge" style="display:none"></div>
        <ul class="g-triggers" id="g-triggers"></ul>
        <p class="g-note">弱信号风险旋钮,非择时工具;偏空=减仓不是做空;结合你自己的止损与选股。</p>
      </section>
    </section>

    <section class="panel chart-panel card chart-card">
      <div class="chart-head">
        <div>
          <div class="panel-kicker">Primary Screen</div>
          <h2>净流动性 vs 标普500</h2>
        </div>
        <div class="chart-legend">
          <span class="leg"><i class="sw" style="background:#7C6DFF"></i>净流动性<span class="leg-axis">左轴·十亿$</span><b id="leg-nl"></b></span>
          <span class="leg"><i class="sw" style="background:#E9EEF8"></i>标普500<span class="leg-axis">右轴</span><b id="leg-spx"></b></span>
        </div>
      </div>
      <div id="chart"></div>
    </section>

    <section class="panel factor-panel card">
      <div class="panel-kicker">Factor Wall</div>
      <h2>9 因子状态</h2>
      <div class="factor-bars" id="factor-bars"></div>
    </section>
  </section>

  <section class="analysis-grid" aria-label="分析明细">
    <!-- Existing analysis cards remain here -->
  </section>
</main>
```

- [ ] **Step 2: Add full-screen CSS**

Rewrite the dashboard-specific portions of `public/styles.css` so these selectors exist:

```css
.container.command-shell{width:100%;max-width:none;min-height:100svh;padding:18px;background:radial-gradient(circle at 18% 0%,rgba(124,109,255,.24),transparent 32%),linear-gradient(135deg,#090B12 0%,#111827 48%,#0A0F1C 100%);color:#E9EEF8;overflow-x:hidden}
.command-shell::before{content:"";position:fixed;inset:0;pointer-events:none;background-image:linear-gradient(rgba(255,255,255,.04) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,.035) 1px,transparent 1px);background-size:42px 42px;mask-image:linear-gradient(to bottom,rgba(0,0,0,.7),transparent 78%)}
.topbar{position:relative;z-index:1;display:grid;grid-template-columns:1fr auto;gap:14px;align-items:end;margin-bottom:14px}
.eyebrow{margin:0 0 4px;color:#8FA1C7;text-transform:uppercase;letter-spacing:.14em;font-size:11px;font-weight:700}
.tb-status{display:flex;align-items:center;justify-content:flex-end;gap:18px;flex-wrap:wrap;text-align:right}
.command-center{position:relative;z-index:1;display:grid;grid-template-columns:minmax(280px,.7fr) minmax(420px,1.55fr) minmax(260px,.65fr);gap:14px;min-height:calc(100svh - 98px)}
.panel,.card{background:rgba(12,18,32,.76);border:1px solid rgba(148,163,184,.22);box-shadow:0 24px 80px rgba(0,0,0,.34);backdrop-filter:blur(18px);border-radius:8px;color:#E9EEF8}
.panel{min-width:0;overflow:hidden}
.decision-panel{display:flex;flex-direction:column;gap:18px;padding:22px}
.chart-panel{display:flex;flex-direction:column;min-height:0;padding:18px}
.factor-panel{display:flex;flex-direction:column;min-width:0;padding:18px}
#chart{flex:1;min-height:420px;height:auto;width:100%;overflow:hidden}
.analysis-grid{position:relative;z-index:1;display:grid;grid-template-columns:repeat(12,minmax(0,1fr));gap:14px;margin-top:14px}
.analysis-grid>.card{grid-column:span 6;margin:0}
.analysis-grid>#explain-card,.analysis-grid>#robust-card{grid-column:span 7}
.analysis-grid>#factor-card,.analysis-grid>#global-card{grid-column:span 5}
.analysis-grid>#provenance-card{grid-column:1/-1}
@media(max-width:980px){.container.command-shell{padding:14px}.topbar{grid-template-columns:1fr}.tb-status{text-align:left;justify-content:flex-start}.command-center{grid-template-columns:1fr;min-height:auto}.chart-panel{min-height:520px}#chart{min-height:440px}.analysis-grid{grid-template-columns:1fr}.analysis-grid>.card,.analysis-grid>#explain-card,.analysis-grid>#robust-card,.analysis-grid>#factor-card,.analysis-grid>#global-card,.analysis-grid>#provenance-card{grid-column:1/-1}}
@media(max-width:560px){.container.command-shell{padding:12px}.command-center{gap:12px}.decision-panel,.chart-panel,.factor-panel{padding:16px}.chart-panel{min-height:380px}#chart{min-height:300px}.verdict-label{font-size:52px}.score-topline strong{font-size:64px}.tb-status{gap:8px}}
@media(prefers-reduced-motion:reduce){*,*::before,*::after{animation-duration:.01ms!important;animation-iteration-count:1!important;scroll-behavior:auto!important;transition-duration:.01ms!important}}
```

Keep existing algorithm page `.prose` styles and the mobile overflow rules added in the previous fix.

- [ ] **Step 3: Run static test**

Run:

```bash
env -u NODE_OPTIONS npm test -- test/ui-assets.test.ts
```

Expected: PASS after CSS/HTML are in place.

### Task 3: JavaScript Bindings And Chart Fit

**Files:**
- Modify: `public/app.js`
- Modify: `test/ui-assets.test.ts`

**Interfaces:**
- Consumes: DOM from Task 2.
- Produces: Status classes applied without removing layout classes; chart height follows its CSS panel.

- [ ] **Step 1: Add static JS behavior checks**

Add to `test/ui-assets.test.ts`:

```ts
it('keeps command-center layout classes when rendering state', () => {
  const js = read('public/app.js');

  expect(js).toContain("card.classList.remove('bull', 'bear', 'neutral')");
  expect(js).toContain("card.classList.add(VERDICT_CLASS[displayV])");
  expect(js).toContain("card.dataset.tone = g.tone || 'neutral'");
  expect(js).not.toContain("card.className = 'card guidance '");
});

it('sizes charts from their rendered container', () => {
  const js = read('public/app.js');

  expect(js).toContain('height: Math.max(300, el.clientHeight || 420)');
  expect(js).toContain('height: Math.max(180, el.clientHeight || 220)');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
env -u NODE_OPTIONS npm test -- test/ui-assets.test.ts
```

Expected: FAIL because `renderGuidance` still replaces `className` and chart heights are fixed.

- [ ] **Step 3: Update `renderVerdict`**

Change `renderVerdict` so status classes are reset before applying the current verdict:

```js
  card.classList.remove('bull', 'bear', 'neutral');
  card.classList.add(VERDICT_CLASS[displayV]);
```

- [ ] **Step 4: Update `renderGuidance`**

Replace:

```js
  card.className = 'card guidance ' + (g.tone || 'neutral');
```

with:

```js
  card.dataset.tone = g.tone || 'neutral';
```

Keep the existing badge class update.

- [ ] **Step 5: Update chart creation heights**

In `renderChart`, replace `height: 320` with:

```js
height: Math.max(300, el.clientHeight || 420)
```

In `renderGlobal`, replace `height: 220` with:

```js
height: Math.max(180, el.clientHeight || 220)
```

- [ ] **Step 6: Run targeted test**

Run:

```bash
env -u NODE_OPTIONS npm test -- test/ui-assets.test.ts
```

Expected: PASS.

### Task 4: Full Verification And Deployment

**Files:**
- No new source files expected.
- Generated screenshots can be saved outside the repo root or removed after inspection.

**Interfaces:**
- Consumes: Completed Tasks 1-3.
- Produces: Deployed production Worker with verified full-screen dashboard.

- [ ] **Step 1: Run automated checks**

Run:

```bash
env -u NODE_OPTIONS npm test
env -u NODE_OPTIONS npx tsc --noEmit
```

Expected: `13` or more Vitest files pass, all tests pass, and TypeScript exits `0`.

- [ ] **Step 2: Start local Worker**

Run:

```bash
env -u NODE_OPTIONS npx wrangler dev --ip 127.0.0.1 --port 8787
```

Expected: local server starts at `http://127.0.0.1:8787`.

- [ ] **Step 3: Verify local browser layout**

Use Playwright against `http://127.0.0.1:8787/`:

- Desktop viewport `1440x900`: `document.querySelector('.command-center')` exists and `getBoundingClientRect().height >= 760`.
- Mobile viewport `390x844`: `document.documentElement.scrollWidth === 390`.
- `/algorithm`: mobile `scrollWidth === 390`.
- Console has `0` errors.

- [ ] **Step 4: Deploy**

Run:

```bash
env -u NODE_OPTIONS npm run deploy
```

Expected: Wrangler reports deployed URL `https://macro-liquidity-dashboard.pp-account.workers.dev`.

- [ ] **Step 5: Verify production browser layout**

Repeat the desktop/mobile checks against:

```text
https://macro-liquidity-dashboard.pp-account.workers.dev/
https://macro-liquidity-dashboard.pp-account.workers.dev/algorithm
```

Expected: no console errors, no page-level horizontal scroll, command center fills first viewport on desktop.

- [ ] **Step 6: Final status**

Report:

- files changed
- test/typecheck output
- production deployment version
- desktop/mobile verification measurements
