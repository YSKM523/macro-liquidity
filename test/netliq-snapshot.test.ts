import { describe, expect, it } from 'vitest';
// @ts-ignore -- isolated Node research module
import { buildSnapshotManifest, fredCsvUrl, parseFredCsv, sha256Hex, verifySnapshotManifest } from '../scripts/netliq-snapshot.mjs';

describe('net-liquidity current-vintage research snapshot', () => {
  const seriesIds = ['WALCL', 'WDTGAL', 'WTREGEN', 'RRPONTSYD', 'SP500'];
  const canonicalSnapshot = () => ({
    schemaVersion: 2,
    snapshotId: 'netliq-current-vintage-2024-01-18-corrected-v2',
    evidenceClass: 'RESEARCH_CURRENT_VINTAGE',
    retrievedAt: '2024-01-18T12:00:00.000Z',
    source: 'FRED_CURRENT_VINTAGE',
    request: {
      startDate: '2002-01-01',
      endDate: '2024-01-18',
      urls: Object.fromEntries(seriesIds.map(seriesId => [seriesId, fredCsvUrl(seriesId, '2024-01-18')])),
    },
    series: Object.fromEntries(seriesIds.map((seriesId, index) => [seriesId, [{ date: '2024-01-03', value: 8_000_000 + index }]])),
  });
  const urls = () => Object.fromEntries(seriesIds.map(seriesId => [seriesId, fredCsvUrl(seriesId, '2024-01-18')]));
  const fixture = async () => {
    const snapshot = canonicalSnapshot();
    const text = `${JSON.stringify(snapshot, null, 2)}\n`;
    const manifest = await buildSnapshotManifest(snapshot, text, {
      snapshotId: snapshot.snapshotId,
      retrievedAt: snapshot.retrievedAt,
      urls: urls(),
    });
    return { snapshot, text, manifest };
  };

  it('uses only the primary FRED CSV endpoint with a frozen research start date', () => {
    expect(fredCsvUrl('WALCL', '2026-07-22')).toBe('https://fred.stlouisfed.org/graph/fredgraph.csv?id=WALCL&cosd=2002-01-01&coed=2026-07-22');
    expect(() => fredCsvUrl('NOT_ALLOWED', '2026-07-22')).toThrow(/allowlist/);
  });

  it('parses FRED CSV, skips missing dots, and preserves raw FRED units', () => {
    expect(parseFredCsv('observation_date,WALCL\n2024-01-03,8000000\n2024-01-10,.\n2024-01-17,8100000\n', 'WALCL')).toEqual([
      { date: '2024-01-03', value: 8_000_000 },
      { date: '2024-01-17', value: 8_100_000 },
    ]);
  });

  it('rejects malformed, duplicate, unsorted, and non-finite source rows', () => {
    expect(() => parseFredCsv('date,WALCL\n2024-01-03,1\n', 'WALCL')).toThrow(/header/);
    expect(() => parseFredCsv('observation_date,WALCL\n2024-01-03,1\n2024-01-03,2\n', 'WALCL')).toThrow(/sorted/);
    expect(() => parseFredCsv('observation_date,WALCL\n2024-01-03,nope\n', 'WALCL')).toThrow(/numeric/);
  });

  it('builds and verifies a content-addressed manifest', async () => {
    const { snapshot, text, manifest } = await fixture();
    expect(manifest).toMatchObject({
      schemaVersion: 2,
      source: 'FRED_CURRENT_VINTAGE',
      evidenceClass: 'RESEARCH_CURRENT_VINTAGE',
      snapshotId: 'netliq-current-vintage-2024-01-18-corrected-v2',
      snapshotSha256: await sha256Hex(text),
      series: { WALCL: { rowCount: 1, firstDate: '2024-01-03', lastDate: '2024-01-03' } },
    });
    await expect(verifySnapshotManifest(snapshot, text, manifest)).resolves.toMatchObject({
      snapshotId: snapshot.snapshotId,
      retrievedAt: snapshot.retrievedAt,
      schemaVersion: 2,
      source: 'FRED_CURRENT_VINTAGE',
    });
    await expect(verifySnapshotManifest(snapshot, `${text} `, manifest)).rejects.toThrow(/SHA-256/);
  });

  it.each([
    ['snapshotId', (manifest: any) => { manifest.snapshotId = 'tampered'; }],
    ['retrievedAt', (manifest: any) => { manifest.retrievedAt = '2024-01-19T00:00:00.000Z'; }],
    ['schemaVersion', (manifest: any) => { manifest.schemaVersion = 3; }],
    ['source', (manifest: any) => { manifest.source = 'OTHER'; }],
    ['URL', (manifest: any) => { manifest.series.WALCL.url = 'https://example.test/WALCL.csv'; }],
    ['rowCount', (manifest: any) => { manifest.series.WALCL.rowCount = 2; }],
    ['date range', (manifest: any) => { manifest.series.WALCL.firstDate = '2024-01-02'; }],
    ['series hash', (manifest: any) => { manifest.series.WALCL.sha256 = '0'.repeat(64); }],
  ])('rejects tampered manifest %s', async (_label, tamper) => {
    const { snapshot, text, manifest } = await fixture();
    tamper(manifest);
    await expect(verifySnapshotManifest(snapshot, text, manifest)).rejects.toThrow();
  });

  it.each(['snapshotId', 'retrievedAt', 'schemaVersion', 'source'])('rejects snapshot %s that does not match its bytes', async field => {
    const { snapshot, text, manifest } = await fixture();
    (snapshot as any)[field] = field === 'schemaVersion' ? 3 : 'tampered';
    await expect(verifySnapshotManifest(snapshot, text, manifest)).rejects.toThrow(/snapshot bytes/);
  });

  it.each(['extra', 'missing'])('rejects a cryptographically self-consistent %s series set', async mode => {
    const { snapshot, manifest } = await fixture();
    if (mode === 'extra') {
      (snapshot.series as any).EXTRA = [{ date: '2024-01-03', value: 1 }];
      manifest.series.EXTRA = {
        url: 'https://fred.stlouisfed.org/graph/fredgraph.csv?id=EXTRA&cosd=2002-01-01',
        rowCount: 1,
        firstDate: '2024-01-03',
        lastDate: '2024-01-03',
        sha256: await sha256Hex(`${JSON.stringify((snapshot.series as any).EXTRA)}\n`),
      };
    } else {
      delete snapshot.series.SP500;
      delete manifest.series.SP500;
    }
    const text = `${JSON.stringify(snapshot, null, 2)}\n`;
    manifest.snapshotSha256 = await sha256Hex(text);
    await expect(verifySnapshotManifest(snapshot, text, manifest)).rejects.toThrow(/series set/);
  });
});
