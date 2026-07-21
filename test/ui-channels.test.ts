import { describe, expect, it } from 'vitest';
// The project tsconfig intentionally only loads Workers types; this test runs in Vitest's Node runtime.
// @ts-ignore
import { readFileSync } from 'node:fs';

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

  it('keeps a newer official snapshot primary while rendering both channel summaries', async () => {
    const app = readFileSync('public/app.js', 'utf8');
    const withoutBootstrap = app.replace(
      /main\(\)\.catch\([^\n]+\);/,
      '',
    );
    const createHarness = new Function('fetch', `
      let primary = null;
      let channels = null;
      ${withoutBootstrap}
      setupExplain = () => {};
      fetchExplain = () => {};
      fetchRobust = () => {};
      renderSnapshotChannels = value => { channels = value; };
      renderVerdict = value => { primary = value.snapshot; };
      renderGuidance = () => {};
      renderScore = () => {};
      renderFactorTable = () => {};
      renderChart = () => {};
      renderIngest = () => {};
      renderProvenance = () => {};
      renderGlobal = () => {};
      setupAccordions = () => {};
      return { main, getPrimary: () => primary, getChannels: () => channels };
    `);
    const official = { date: '2026-07-21', verdict: 'BULLISH' };
    const nowcast = { date: '2026-07-20', verdict: 'BEARISH', channel_status: 'PROVISIONAL' };
    const harness = createHarness(async (url: string) => ({
      json: async () => url.startsWith('/api/snapshot')
        ? { official, nowcast, ingest: {} }
        : { rows: [] },
    }));

    await harness.main();

    expect(harness.getPrimary()).toEqual(official);
    expect(harness.getChannels()).toMatchObject({ official, nowcast });
  });
});
