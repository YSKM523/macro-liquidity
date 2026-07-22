#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { PREREGISTRATION } from './netliq-preregistration.mjs';
import { buildSnapshotManifest, fredCsvUrl, parseFredCsv } from './netliq-snapshot.mjs';

const snapshotDate = process.argv[2];
if (!/^\d{4}-\d{2}-\d{2}$/.test(snapshotDate ?? '')) {
  throw new Error('usage: node scripts/fetch-netliq-snapshot.mjs YYYY-MM-DD');
}

const retrievedAt = new Date().toISOString();
const urls = Object.fromEntries(PREREGISTRATION.series.map(seriesId => [seriesId, fredCsvUrl(seriesId)]));
const results = await Promise.all(PREREGISTRATION.series.map(async seriesId => {
  const response = await fetch(urls[seriesId], { headers: { accept: 'text/csv' } });
  if (!response.ok) throw new Error(`${seriesId} FRED CSV HTTP ${response.status}`);
  return [seriesId, parseFredCsv(await response.text(), seriesId)];
}));

const snapshotId = `netliq-current-vintage-${snapshotDate}`;
const snapshot = {
  schemaVersion: 1,
  snapshotId,
  evidenceClass: PREREGISTRATION.evidenceClass,
  retrievedAt,
  source: 'FRED_CURRENT_VINTAGE',
  series: Object.fromEntries(results),
};
const snapshotText = `${JSON.stringify(snapshot, null, 2)}\n`;
const manifest = await buildSnapshotManifest(snapshot, snapshotText, {
  snapshotId,
  retrievedAt,
  urls,
});
const dataDirectory = resolve('scripts/data');
await mkdir(dataDirectory, { recursive: true });
const snapshotPath = resolve(dataDirectory, `${snapshotId}.json`);
const manifestPath = resolve(dataDirectory, `${snapshotId}.manifest.json`);
await writeFile(snapshotPath, snapshotText, { encoding: 'utf8', flag: 'wx' });
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });

console.log(JSON.stringify({ snapshotPath, manifestPath, snapshotSha256: manifest.snapshotSha256, series: manifest.series }, null, 2));
