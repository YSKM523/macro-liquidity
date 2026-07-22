#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { PREREGISTRATION } from './reserve-preregistration.mjs';
import { buildReserveManifest, fredCsvUrl, nyFedRepoUrl, parseFredCsv, parseNyFedSrf, sha256Hex } from './reserve-snapshot.mjs';

const endDate = process.argv[2];
if (!/^\d{4}-\d{2}-\d{2}$/.test(endDate ?? '')) throw new Error('usage: node scripts/fetch-reserve-snapshot.mjs YYYY-MM-DD');

const startDate = '2002-01-01';
const fredIds = PREREGISTRATION.sources.FRED.series;
const fredUrls = Object.fromEntries(fredIds.map(id => [id, fredCsvUrl(id, endDate)]));
const nyFedUrl = nyFedRepoUrl(startDate, endDate);
const requests = [
  ...fredIds.map(id => ({ id, url: fredUrls[id], accept: 'text/csv' })),
  { id: 'NYFED_SRF_ACCEPTED', url: nyFedUrl, accept: 'application/json' },
];
const responses = await Promise.all(requests.map(async request => {
  const response = await fetch(request.url, { headers: { accept: request.accept } });
  if (!response.ok) throw new Error(`${request.id} canonical source HTTP ${response.status}`);
  const body = await response.text();
  return { ...request, body };
}));
const bodies = Object.fromEntries(responses.map(response => [response.id, response.body]));
const series = Object.fromEntries([
  ...fredIds.map(id => [id, parseFredCsv(bodies[id], id)]),
  ['NYFED_SRF_ACCEPTED', parseNyFedSrf(bodies.NYFED_SRF_ACCEPTED)],
]);
const retrievedAt = new Date().toISOString();
const snapshotId = `reserve-current-vintage-${endDate}-v1`;
const snapshot = {
  schemaVersion: 1, snapshotId, evidenceClass: PREREGISTRATION.evidenceClass,
  retrievedAt, source: PREREGISTRATION.source,
  request: { startDate, endDate, fredUrls, nyFedUrl }, series,
};
const snapshotText = `${JSON.stringify(snapshot, null, 2)}\n`;
const responseHashes = Object.fromEntries(responses.map(response => [response.id, sha256Hex(response.body)]));
const manifest = await buildReserveManifest(snapshot, snapshotText, responseHashes);
const directory = resolve('scripts/data');
await mkdir(directory, { recursive: true });
const snapshotPath = resolve(directory, `${snapshotId}.json`);
const manifestPath = resolve(directory, `${snapshotId}.manifest.json`);
await writeFile(snapshotPath, snapshotText, { encoding: 'utf8', flag: 'wx' });
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
console.log(JSON.stringify({ snapshotPath, manifestPath, snapshotSha256: manifest.snapshotSha256, series: manifest.series }, null, 2));
