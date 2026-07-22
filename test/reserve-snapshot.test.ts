import { describe, expect, it } from 'vitest';
// @ts-ignore -- isolated Node research module
import { buildReserveManifest, fredCsvUrl, nyFedRepoUrl, parseFredCsv, parseNyFedSrf, sha256Hex, verifyReserveSnapshot } from '../scripts/reserve-snapshot.mjs';

const ids = ['WRESBAL', 'GDP', 'SOFR', 'IORB', 'EFFR', 'TGCRRATE', 'SP500'];
const snapshotFixture = async () => {
  const fredUrls = Object.fromEntries(ids.map(id => [id, fredCsvUrl(id, '2024-01-03')]));
  const nyFedUrl = nyFedRepoUrl('2021-07-29', '2024-01-03');
  const series = Object.fromEntries([...ids, 'NYFED_SRF_ACCEPTED'].map((id, index) => [id, [{ date: '2024-01-03', value: index + 1 }]]));
  const snapshot = {
    schemaVersion: 2, snapshotId: 'reserve-current-vintage-2024-01-03-v2', evidenceClass: 'RESEARCH_CURRENT_VINTAGE',
    retrievedAt: '2024-01-03T12:00:00.000Z', source: 'FRED_AND_NYFED_CURRENT_VINTAGE',
    request: { fredStartDate: '2002-01-01', nyFedStartDate: '2021-07-29', endDate: '2024-01-03', fredUrls, nyFedUrl }, series,
  };
  const text = `${JSON.stringify(snapshot, null, 2)}\n`;
  const responseHashes = Object.fromEntries([...ids, 'NYFED_SRF_ACCEPTED'].map(id => [id, 'a'.repeat(64)]));
  const manifest = await buildReserveManifest(snapshot, text, responseHashes);
  return { snapshot, text, manifest, responseHashes };
};

describe('reserve challenger canonical current-vintage artifact', () => {
  it('binds exact canonical FRED and NY Fed URLs', () => {
    expect(fredCsvUrl('TGCRRATE', '2026-07-22')).toBe('https://fred.stlouisfed.org/graph/fredgraph.csv?id=TGCRRATE&cosd=2002-01-01&coed=2026-07-22');
    expect(nyFedRepoUrl('2021-07-29', '2026-07-22')).toBe('https://markets.newyorkfed.org/api/rp/results/search.json?startDate=2021-07-29&endDate=2026-07-22&operationTypes=Repo');
    expect(() => nyFedRepoUrl('2002-01-01', '2026-07-22')).toThrow(/launch/);
    expect(() => fredCsvUrl('TGCR', '2026-07-22')).toThrow(/allowlist/);
  });

  it('parses strict FRED schema and rejects malformed rows', () => {
    expect(parseFredCsv('observation_date,TGCRRATE\n2024-01-02,5.33\n2024-01-03,.\n', 'TGCRRATE')).toEqual([{ date: '2024-01-02', value: 5.33 }]);
    expect(() => parseFredCsv('date,TGCRRATE\n2024-01-02,5.33\n', 'TGCRRATE')).toThrow(/header/);
    expect(() => parseFredCsv('observation_date,TGCRRATE\n2024-01-02,5\n2024-01-02,6\n', 'TGCRRATE')).toThrow(/sorted/);
  });

  it('aggregates same-day Overnight Repo totalAmtAccepted dollars into billions and ignores non-overnight terms', () => {
    expect(parseNyFedSrf(JSON.stringify({ repo: { operations: [
      { operationDate: '2024-01-03', operationType: 'Repo', term: 'Overnight', totalAmtAccepted: 1_000_000_000 },
      { operationDate: '2024-01-03', operationType: 'Repo', term: 'Overnight', totalAmtAccepted: 500_000_000 },
      { operationDate: '2024-01-04', operationType: 'Repo', term: '14-Day', totalAmtAccepted: 9_000_000_000 },
      { operationDate: '2024-01-04', operationType: 'Repo', term: 'Overnight', totalAmtAccepted: 0 },
    ] } }))).toEqual([{ date: '2024-01-03', value: 1.5 }, { date: '2024-01-04', value: 0 }]);
    expect(() => parseNyFedSrf('{"repo":{"operations":[{"operationDate":"2024-01-03","operationType":"Repo","term":"Overnight"}]}}')).toThrow(/totalAmtAccepted/);
    expect(() => parseNyFedSrf('{"repo":{"operations":[{"operationDate":"2024-01-03","operationType":"Reverse Repo","term":"Overnight","totalAmtAccepted":0}]}}')).toThrow(/operationType/);
    expect(() => parseNyFedSrf('{"repo":{"operations":[{"operationDate":"2021-07-28","operationType":"Repo","term":"Overnight","totalAmtAccepted":0}]}}')).toThrow(/before SRF launch/);
  });

  it('verifies bytes/object, exact series set, metadata, normalized hashes, and provider response hashes', async () => {
    const { snapshot, text, manifest } = await snapshotFixture();
    expect(manifest).toMatchObject({ snapshotSha256: await sha256Hex(text), series: { TGCRRATE: { provider: 'FRED', sourceResponseSha256: 'a'.repeat(64) }, NYFED_SRF_ACCEPTED: { provider: 'NYFED_MARKETS_API' } } });
    await expect(verifyReserveSnapshot(snapshot, text, manifest)).resolves.toMatchObject({ snapshotId: snapshot.snapshotId, snapshotSha256: manifest.snapshotSha256 });
    await expect(verifyReserveSnapshot(snapshot, `${text} `, manifest)).rejects.toThrow(/SHA-256/);
    const tampered = structuredClone(manifest);
    tampered.series.TGCRRATE.url = 'https://example.test';
    await expect(verifyReserveSnapshot(snapshot, text, tampered)).rejects.toThrow(/URL/);
  });

  it('rejects cryptographically self-consistent extra/missing series and invalid response hashes', async () => {
    const { snapshot, manifest } = await snapshotFixture();
    delete snapshot.series.SP500;
    delete manifest.series.SP500;
    const text = `${JSON.stringify(snapshot, null, 2)}\n`;
    manifest.snapshotSha256 = await sha256Hex(text);
    await expect(verifyReserveSnapshot(snapshot, text, manifest)).rejects.toThrow(/series set/);
    const valid = await snapshotFixture();
    valid.manifest.series.WRESBAL.sourceResponseSha256 = 'nope';
    await expect(verifyReserveSnapshot(valid.snapshot, valid.text, valid.manifest)).rejects.toThrow(/response SHA-256/);
  });

  it.each([
    ['after request end', 'WRESBAL', '2024-01-04'],
    ['before FRED request start', 'GDP', '2001-12-31'],
    ['NY Fed after request end', 'NYFED_SRF_ACCEPTED', '2024-01-04'],
  ])('rejects normalized rows %s', async (_label, seriesId, date) => {
    const { snapshot, responseHashes } = await snapshotFixture();
    snapshot.series[seriesId][0].date = date;
    const text = `${JSON.stringify(snapshot, null, 2)}\n`;
    await expect(buildReserveManifest(snapshot, text, responseHashes)).rejects.toThrow(/request range/);
  });

  it.each([
    ['FRED after end', 'WRESBAL', '2024-01-04'],
    ['FRED before start', 'GDP', '2001-12-31'],
    ['NY Fed before SRF launch', 'NYFED_SRF_ACCEPTED', '2021-07-28'],
  ])('rejects a cryptographically self-consistent %s tamper during verify', async (_label, seriesId, date) => {
    const { snapshot, manifest } = await snapshotFixture();
    snapshot.series[seriesId][0].date = date;
    const text = `${JSON.stringify(snapshot, null, 2)}\n`;
    manifest.snapshotSha256 = await sha256Hex(text);
    manifest.series[seriesId].firstDate = date;
    manifest.series[seriesId].lastDate = date;
    manifest.series[seriesId].normalizedSha256 = await sha256Hex(`${JSON.stringify(snapshot.series[seriesId])}\n`);
    await expect(verifyReserveSnapshot(snapshot, text, manifest)).rejects.toThrow(/request range/);
  });
});
