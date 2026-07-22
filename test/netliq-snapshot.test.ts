import { describe, expect, it } from 'vitest';
import {
  buildSnapshotManifest,
  fredCsvUrl,
  parseFredCsv,
  sha256Hex,
  verifySnapshotManifest,
} from '../scripts/netliq-snapshot.mjs';

describe('net-liquidity current-vintage research snapshot', () => {
  it('uses only the primary FRED CSV endpoint with a frozen research start date', () => {
    expect(fredCsvUrl('WALCL')).toBe('https://fred.stlouisfed.org/graph/fredgraph.csv?id=WALCL&cosd=2002-01-01');
    expect(() => fredCsvUrl('NOT_ALLOWED')).toThrow(/allowlist/);
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
    const snapshot = {
      evidenceClass: 'RESEARCH_CURRENT_VINTAGE',
      series: { WALCL: [{ date: '2024-01-03', value: 8_000_000 }] },
    };
    const text = `${JSON.stringify(snapshot, null, 2)}\n`;
    const manifest = await buildSnapshotManifest(snapshot, text, {
      snapshotId: 'netliq-current-vintage-2024-01-18',
      retrievedAt: '2024-01-18T12:00:00.000Z',
      urls: { WALCL: 'https://fred.stlouisfed.org/graph/fredgraph.csv?id=WALCL' },
    });
    expect(manifest).toMatchObject({
      evidenceClass: 'RESEARCH_CURRENT_VINTAGE',
      snapshotId: 'netliq-current-vintage-2024-01-18',
      snapshotSha256: await sha256Hex(text),
      series: { WALCL: { rowCount: 1, firstDate: '2024-01-03', lastDate: '2024-01-03' } },
    });
    await expect(verifySnapshotManifest(snapshot, text, manifest)).resolves.toBe(true);
    await expect(verifySnapshotManifest(snapshot, `${text} `, manifest)).rejects.toThrow(/SHA-256/);
  });
});
