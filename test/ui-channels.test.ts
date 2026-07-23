import { describe, expect, it } from 'vitest';
// The project tsconfig intentionally only loads Workers types; this test runs in Vitest's Node runtime.
// @ts-ignore
import { readFileSync } from 'node:fs';

function appWithoutBootstrap(): string {
  return readFileSync('public/app.js', 'utf8').replace(
    /main\(\)\.catch\([^\n]+\);/,
    '',
  );
}

function createMainHarness(official: any, nowcast: any) {
  const createHarness = new Function('fetch', `
    let primary = null;
    let channels = null;
    let provenance = null;
    ${appWithoutBootstrap()}
    setupExplain = () => {};
    fetchExplain = () => {};
    fetchRobust = () => {};
    fetchScoreStressDiagnostics = () => {};
    fetchLiquidityStructureChallenger = () => {};
    fetchEventBacktest = () => {};
    renderSnapshotChannels = value => { channels = value; };
    renderVerdict = value => { primary = value.snapshot; };
    renderGuidance = () => {};
    renderScore = () => {};
    renderFactorTable = () => {};
    renderChart = () => {};
    renderIngest = () => {};
    renderProvenance = value => { provenance = value; };
    renderGlobal = () => {};
    setupAccordions = () => {};
    return {
      main,
      getPrimary: () => primary,
      getChannels: () => channels,
      getProvenance: () => provenance,
    };
  `);
  return createHarness(async (url: string) => ({
    json: async () => url.startsWith('/api/snapshot')
      ? { official, nowcast, ingest: {} }
      : { rows: [] },
  }));
}

function createRenderHarness() {
  const nodes = new Map<string, any>([
    ['explain-body', { innerHTML: '' }],
    ['provenance-card', { style: {} }],
    ['provenance-body', { innerHTML: '' }],
  ]);
  const document = { getElementById: (id: string) => nodes.get(id) ?? null };
  const createHarness = new Function('document', `
    ${appWithoutBootstrap()}
    return { renderExplain, renderProvenance };
  `);
  return { ...createHarness(document), nodes };
}

describe('snapshot channel UI', () => {
  it('visibly labels the official signal and provisional intra-week estimate', () => {
    const html = readFileSync('public/index.html', 'utf8');
    const app = readFileSync('public/app.js', 'utf8');

    expect(html).toContain('正式信号');
    expect(html).toContain('周中预估');
    expect(html).toContain('PROVISIONAL');
    expect(app).toContain('snapRes.official');
    expect(app).toContain('snapRes.nowcast');
  });

  it('visibly marks official-only historical analytics as OFFICIAL', () => {
    const html = readFileSync('public/index.html', 'utf8');

    expect(html).toContain('正式历史 · OFFICIAL · 净流动性 vs 标普500');
    expect(html).toContain('正式历史稳健性 · OFFICIAL');
  });

  it('keeps a newer official snapshot primary while rendering both channel summaries', async () => {
    const official = { date: '2026-07-21', verdict: 'BULLISH' };
    const nowcast = { date: '2026-07-20', verdict: 'BEARISH', channel_status: 'PROVISIONAL' };
    const harness = createMainHarness(official, nowcast);

    await harness.main();

    expect(harness.getPrimary()).toEqual(official);
    expect(harness.getChannels()).toMatchObject({ official, nowcast });
  });

  it('prefers the official verdict when official and nowcast dates are equal', async () => {
    const official = { date: '2026-07-21', verdict: 'BULLISH' };
    const nowcast = { date: '2026-07-21', verdict: 'BEARISH', channel_status: 'PROVISIONAL' };
    const harness = createMainHarness(official, nowcast);

    await harness.main();

    expect(harness.getPrimary()).toEqual(official);
    expect(harness.getProvenance()).toMatchObject({ snapshot: official, snapshotChannel: 'official' });
  });

  it('labels explanation as official-only and renders its official source date', () => {
    const html = readFileSync('public/index.html', 'utf8');
    const harness = createRenderHarness();

    harness.renderExplain({
      window: '1w',
      current: { date: '2026-07-15', score: 60 },
      reference: null,
      deltaScore: null,
      contributions: [],
      attribution: null,
      netliq: null,
    });

    expect(html).toContain('正式信号归因 · OFFICIAL');
    const rendered = harness.nodes.get('explain-body').innerHTML;
    expect(rendered).toContain('正式信号');
    expect(rendered).toContain('OFFICIAL');
    expect(rendered).toContain('2026-07-15');
    expect(rendered).not.toContain('PROVISIONAL');
  });

  it('uses provisional provenance for a newer nowcast primary instead of calling it weekly', async () => {
    const official = { date: '2026-07-15', verdict: 'BULLISH' };
    const nowcast = { date: '2026-07-21', verdict: 'BEARISH', channel_status: 'PROVISIONAL' };
    const mainHarness = createMainHarness(official, nowcast);
    await mainHarness.main();
    expect(mainHarness.getProvenance()).toMatchObject({ snapshot: nowcast, snapshotChannel: 'nowcast' });

    const renderHarness = createRenderHarness();
    renderHarness.renderProvenance({
      snapshot: nowcast,
      snapshotChannel: 'nowcast',
      live: {},
      ingest: {},
    });

    const rendered = renderHarness.nodes.get('provenance-body').innerHTML;
    expect(rendered).toContain('<span class="prov-tag provisional">PROVISIONAL</span>');
    expect(rendered).not.toContain('<span class="prov-tag weekly">周更</span>');
  });
});
