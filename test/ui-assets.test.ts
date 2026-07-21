import { describe, expect, it } from 'vitest';
// The project tsconfig intentionally only loads Workers types; this test runs in Vitest's Node runtime.
// @ts-ignore
import { readFileSync, existsSync } from 'node:fs';
// @ts-ignore
import { join } from 'node:path';

declare const process: { cwd(): string };

const root = process.cwd();
const read = (path: string) => readFileSync(join(root, path), 'utf8');

describe('static UI assets', () => {
  it('declares a favicon that is present in public assets', () => {
    for (const page of ['public/index.html', 'public/algorithm.html']) {
      const html = read(page);
      expect(html).toContain('rel="icon"');
      expect(html).toContain('href="/favicon.svg"');
    }

    expect(existsSync(join(root, 'public/favicon.svg'))).toBe(true);
  });

  it('keeps mobile cards, charts, and prose from forcing page-level horizontal scroll', () => {
    const css = read('public/styles.css');

    expect(css).toMatch(/\.panel[^}]*min-width\s*:\s*0/s);
    expect(css).toMatch(/\.command-center[^}]*grid-template-columns\s*:\s*1fr/s);
    expect(css).toMatch(/\.chart-card[^}]*min-width\s*:\s*0/s);
    expect(css).toMatch(/#chart[^}]*min-width\s*:\s*0/s);
    expect(css).toMatch(/\.factor-bars[^}]*min-width\s*:\s*0/s);
    expect(css).toMatch(/\.fb[^}]*minmax\(0,\s*1fr\)/s);
    expect(css).toMatch(/\.prose[^}]*min-width\s*:\s*0/s);
    expect(css).toMatch(/\.prose\s+table[^}]*width\s*:\s*max-content/s);
    expect(css).toMatch(/\.prose\s+pre[^}]*max-width\s*:\s*100%/s);
  });

  it('declares the command-center first viewport structure', () => {
    const html = read('public/index.html');
    const algorithmHtml = read('public/algorithm.html');

    expect(html).toContain('class="dashboard-doc"');
    expect(html).toContain('class="dashboard-page"');
    expect(algorithmHtml).not.toContain('dashboard-page');
    expect(html).toContain('class="command-shell"');
    expect(html).toContain('class="command-center"');
    expect(html).toContain('class="command-column decision-column"');
    expect(html).toContain('class="command-column primary-column"');
    expect(html).toContain('class="command-column factor-column"');
    expect(html).toContain('class="decision-panel');
    expect(html).toContain('class="state-grid"');
    expect(html).toContain('class="guidance-mosaic"');
    expect(html).toContain('class="chart-panel');
    expect(html).toContain('class="factor-panel');
    expect(html).toContain('id="score-card"');
    expect(html).toContain('id="guidance-card"');
    expect(html).not.toContain('class="analysis-grid"');
  });

  it('styles the command center as a compact responsive stage', () => {
    const css = read('public/styles.css');

    expect(css).toMatch(/\.command-shell[^}]*min-height\s*:\s*100svh/s);
    expect(css).toMatch(/\.command-center[^}]*grid-template-columns\s*:[^;]*minmax\(330px,\s*\.9fr\)[^;]*minmax\(360px,\s*1\.05fr\)[^;]*minmax\(280px,\s*\.78fr\)/s);
    expect(css).toMatch(/\.chart-panel[^}]*min-height\s*:\s*0/s);
    expect(css).toMatch(/#chart[^}]*height\s*:\s*360px/s);
    expect(css).toMatch(/\.factor-panel[^}]*min-width\s*:\s*0/s);
    expect(css).toMatch(/\.command-column[^}]*flex-direction\s*:\s*column/s);
    expect(css).not.toContain('.analysis-grid');
    expect(css).toMatch(/@media\(prefers-reduced-motion:reduce\)/s);
    expect(css).toMatch(/@media\(max-width:980px\)[\s\S]*\.command-center[^}]*grid-template-columns\s*:\s*1fr/s);
    expect(css).toMatch(/@media\(max-width:980px\)[\s\S]*\.command-column[^}]*display\s*:\s*contents/s);
    expect(css).toMatch(/@media\(max-width:980px\)[\s\S]*#provenance-card[^}]*order\s*:\s*8/s);
  });

  it('enables a no-page-scroll desktop fit mode for monitor dashboards', () => {
    const css = read('public/styles.css');

    expect(css).toMatch(/@media\(min-width:1200px\)\s+and\s+\(min-height:800px\)/s);
    expect(css).toMatch(/@media\(min-width:1200px\)\s+and\s+\(min-height:800px\)[\s\S]*\.dashboard-doc,\.dashboard-page[^}]*overflow\s*:\s*hidden/s);
    expect(css).toMatch(/@media\(min-width:1200px\)\s+and\s+\(min-height:800px\)[\s\S]*\.command-shell[^}]*height\s*:\s*100svh/s);
    expect(css).toMatch(/@media\(min-width:1200px\)\s+and\s+\(min-height:800px\)[\s\S]*\.command-center[^}]*height\s*:\s*100%/s);
    expect(css).toMatch(/@media\(min-width:1200px\)\s+and\s+\(min-height:800px\)[\s\S]*\.primary-column[^}]*grid-template-rows/s);
    expect(css).toMatch(/@media\(min-width:1200px\)\s+and\s+\(min-height:800px\)[\s\S]*#global-chart[^}]*height\s*:\s*115px/s);
  });

  it('uses tiled decision details without a side status rail', () => {
    const css = read('public/styles.css');
    const js = read('public/app.js');

    expect(css).toMatch(/\.state-grid[^}]*grid-template-columns\s*:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/s);
    expect(css).toMatch(/\.guidance-mosaic[^}]*grid-template-columns\s*:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/s);
    expect(css).not.toContain('inset 4px 0 0');
    expect(js).toContain('toneForRegime');
    expect(js).toContain('toneForDirection');
    expect(js).toContain('toneForPolicy');
  });

  it('keeps the command UI solid rather than gradient or glass-styled', () => {
    const css = read('public/styles.css');
    const js = read('public/app.js');

    expect(css).not.toContain('linear-gradient');
    expect(css).not.toContain('rgba(');
    expect(css).not.toContain('transparent');
    expect(css).not.toContain('backdrop-filter');
    expect(js).not.toContain('rgba(');
    expect(js).not.toContain('transparent');
  });

  it('keeps command-center layout classes when rendering state', () => {
    const js = read('public/app.js');

    expect(js).toContain("card.classList.remove('bull', 'bear', 'neutral', 'unknown')");
    expect(js).toContain('card.classList.add(VERDICT_CLASS[displayV])');
    expect(js).toContain("card.dataset.tone = g.tone || 'neutral'");
    expect(js).not.toContain("card.className = 'card guidance '");
  });

  it('renders UNKNOWN live-risk state explicitly and cache-busts the updated assets', () => {
    const html = read('public/index.html');
    const css = read('public/styles.css');
    const js = read('public/app.js');

    expect(js).toContain("UNKNOWN: '风险未知'");
    expect(js).toContain("stress.status === 'UNKNOWN'");
    expect(js).toContain('实时风险层不可用');
    expect(css).toContain('.verdict.unknown');
    expect(css).toContain('.g-badge.unknown');
    expect(html).toContain('/styles.css?v=0721b');
    expect(html).toContain('/app.js?v=0721c');
  });

  it('sizes charts from their rendered container', () => {
    const js = read('public/app.js');

    expect(js).toContain('height: Math.max(260, el.clientHeight || 360)');
    expect(js).toContain('height: Math.max(260, el.clientHeight || 320)');
    expect(js).toContain('height: Math.max(110, el.clientHeight || 220)');
    expect(js).toContain('height: Math.max(110, el.clientHeight || 180)');
  });

  it('renders persisted factor status and as-of quality without neutralizing absent scores', () => {
    const js = read('public/app.js');
    const css = read('public/styles.css');

    expect(js).toContain('factor_quality');
    expect(js).toContain('result.asOf');
    expect(js).toContain("result.status === 'STALE'");
    expect(js).toContain("result.status === 'MISSING'");
    expect(js).toContain("result.score == null ? '—'");
    expect(js).toContain('宏观数据不完整');
    expect(js).toContain("const macroIncomplete = s.decision_status === 'DATA_INCOMPLETE'");
    expect(js).toContain("res.error === 'data_incomplete'");
    expect(css).toContain('.factor-status.stale');
    expect(css).toContain('.factor-status.missing');
    expect(css).toContain('.fb.is-unavailable');
  });

  it('explains factor availability changes without labelling the residual as a score-cap adjustment', () => {
    const js = read('public/app.js');

    expect(js).toContain("res.attribution_unavailable_reason === 'factor_availability_changed'");
    expect(js).toContain('因子可用性发生变化');
    expect(js.indexOf("res.attribution_unavailable_reason === 'factor_availability_changed'"))
      .toBeLessThan(js.indexOf('含分数封顶调整'));
  });
});
