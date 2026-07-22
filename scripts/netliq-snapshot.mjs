import { createHash } from 'node:crypto';

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const FRED_ALLOWLIST = new Set(['WALCL', 'WDTGAL', 'WTREGEN', 'RRPONTSYD', 'SP500']);

export function fredCsvUrl(seriesId) {
  if (!FRED_ALLOWLIST.has(seriesId)) throw new Error(`${seriesId} is not in the FRED allowlist`);
  return `https://fred.stlouisfed.org/graph/fredgraph.csv?id=${seriesId}&cosd=2002-01-01`;
}

export async function sha256Hex(content) {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

export function parseFredCsv(csv, seriesId) {
  const lines = csv.replace(/^\uFEFF/, '').trim().split(/\r?\n/);
  if (lines[0] !== `observation_date,${seriesId}`) {
    throw new Error(`${seriesId} CSV header is invalid`);
  }
  const rows = [];
  let prior = '';
  for (const line of lines.slice(1)) {
    if (line === '') continue;
    const comma = line.indexOf(',');
    if (comma < 0) throw new Error(`${seriesId} CSV row is malformed`);
    const date = line.slice(0, comma);
    const raw = line.slice(comma + 1);
    if (!DATE.test(date) || !Number.isFinite(Date.parse(`${date}T00:00:00Z`))) {
      throw new Error(`${seriesId} CSV date is invalid`);
    }
    if (date <= prior) throw new Error(`${seriesId} rows must be strictly sorted without duplicates`);
    prior = date;
    if (raw === '.' || raw === '') continue;
    const value = Number(raw);
    if (!Number.isFinite(value)) throw new Error(`${seriesId} CSV value is not numeric`);
    rows.push({ date, value });
  }
  return rows;
}

export async function buildSnapshotManifest(snapshot, snapshotText, metadata) {
  const series = {};
  for (const [seriesId, rows] of Object.entries(snapshot.series)) {
    if (!Array.isArray(rows) || rows.length === 0) throw new Error(`${seriesId} snapshot is empty`);
    series[seriesId] = {
      url: metadata.urls[seriesId],
      rowCount: rows.length,
      firstDate: rows[0].date,
      lastDate: rows.at(-1).date,
      sha256: await sha256Hex(`${JSON.stringify(rows)}\n`),
    };
  }
  return {
    schemaVersion: 1,
    snapshotId: metadata.snapshotId,
    evidenceClass: snapshot.evidenceClass,
    retrievedAt: metadata.retrievedAt,
    snapshotSha256: await sha256Hex(snapshotText),
    series,
  };
}

export async function verifySnapshotManifest(snapshot, snapshotText, manifest) {
  const actual = await sha256Hex(snapshotText);
  if (actual !== manifest.snapshotSha256) throw new Error('snapshot SHA-256 mismatch');
  if (snapshot.evidenceClass !== 'RESEARCH_CURRENT_VINTAGE'
    || manifest.evidenceClass !== 'RESEARCH_CURRENT_VINTAGE') {
    throw new Error('snapshot evidence class mismatch');
  }
  for (const [seriesId, rows] of Object.entries(snapshot.series)) {
    const metadata = manifest.series[seriesId];
    if (!metadata || metadata.rowCount !== rows.length
      || metadata.firstDate !== rows[0]?.date || metadata.lastDate !== rows.at(-1)?.date) {
      throw new Error(`${seriesId} manifest metadata mismatch`);
    }
    if (await sha256Hex(`${JSON.stringify(rows)}\n`) !== metadata.sha256) {
      throw new Error(`${seriesId} SHA-256 mismatch`);
    }
  }
  return true;
}
