import { createHash } from 'node:crypto';

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const FRED_ALLOWLIST = new Set(['WALCL', 'WDTGAL', 'WTREGEN', 'RRPONTSYD', 'SP500']);
const CANONICAL_SERIES = [...FRED_ALLOWLIST].sort();
const SNAPSHOT_SCHEMA_VERSION = 2;
const SNAPSHOT_SOURCE = 'FRED_CURRENT_VINTAGE';
const EVIDENCE_CLASS = 'RESEARCH_CURRENT_VINTAGE';
const RESEARCH_START_DATE = '2002-01-01';

export function fredCsvUrl(seriesId, endDate) {
  if (!FRED_ALLOWLIST.has(seriesId)) throw new Error(`${seriesId} is not in the FRED allowlist`);
  if (!DATE.test(endDate ?? '') || new Date(`${endDate}T00:00:00Z`).toISOString().slice(0, 10) !== endDate) {
    throw new Error('FRED research end date is invalid');
  }
  return `https://fred.stlouisfed.org/graph/fredgraph.csv?id=${seriesId}&cosd=${RESEARCH_START_DATE}&coed=${endDate}`;
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
  validateSnapshotEnvelope(snapshot);
  if (metadata.snapshotId !== snapshot.snapshotId || metadata.retrievedAt !== snapshot.retrievedAt) {
    throw new Error('snapshot metadata does not match manifest inputs');
  }
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
    schemaVersion: snapshot.schemaVersion,
    snapshotId: metadata.snapshotId,
    evidenceClass: snapshot.evidenceClass,
    retrievedAt: metadata.retrievedAt,
    source: snapshot.source,
    requestStartDate: snapshot.request.startDate,
    requestEndDate: snapshot.request.endDate,
    snapshotSha256: await sha256Hex(snapshotText),
    series,
  };
}

function sortedKeys(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? Object.keys(value).sort() : [];
}

function sameKeys(actual, expected) {
  return JSON.stringify(sortedKeys(actual)) === JSON.stringify([...expected].sort());
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function validateNormalizedRows(seriesId, rows) {
  if (!Array.isArray(rows) || rows.length === 0) throw new Error(`${seriesId} snapshot is empty`);
  let prior = '';
  for (const row of rows) {
    if (!DATE.test(row?.date)
      || new Date(`${row.date}T00:00:00Z`).toISOString().slice(0, 10) !== row.date) {
      throw new Error(`${seriesId} snapshot date is invalid`);
    }
    if (row.date <= prior) throw new Error(`${seriesId} snapshot must be strictly sorted`);
    if (!Number.isFinite(row.value)) throw new Error(`${seriesId} snapshot value is non-finite`);
    prior = row.date;
  }
}

function validateSnapshotEnvelope(snapshot) {
  if (snapshot?.schemaVersion !== SNAPSHOT_SCHEMA_VERSION) throw new Error('snapshot schemaVersion mismatch');
  if (typeof snapshot.snapshotId !== 'string' || snapshot.snapshotId.length === 0) throw new Error('snapshotId is invalid');
  if (snapshot.evidenceClass !== EVIDENCE_CLASS) throw new Error('snapshot evidence class mismatch');
  if (snapshot.source !== SNAPSHOT_SOURCE) throw new Error('snapshot source mismatch');
  if (typeof snapshot.retrievedAt !== 'string'
    || new Date(snapshot.retrievedAt).toISOString() !== snapshot.retrievedAt) {
    throw new Error('snapshot retrievedAt is invalid');
  }
  if (snapshot.request?.startDate !== RESEARCH_START_DATE
    || !DATE.test(snapshot.request?.endDate ?? '')
    || !sameKeys(snapshot.request?.urls, CANONICAL_SERIES)) {
    throw new Error('snapshot request metadata mismatch');
  }
  for (const seriesId of CANONICAL_SERIES) {
    if (snapshot.request.urls[seriesId] !== fredCsvUrl(seriesId, snapshot.request.endDate)) {
      throw new Error(`${seriesId} snapshot request URL mismatch`);
    }
  }
  if (!sameKeys(snapshot.series, CANONICAL_SERIES)) throw new Error('snapshot series set mismatch');
  for (const seriesId of CANONICAL_SERIES) validateNormalizedRows(seriesId, snapshot.series[seriesId]);
}

export async function verifySnapshotManifest(snapshot, snapshotText, manifest) {
  const actual = await sha256Hex(snapshotText);
  if (actual !== manifest.snapshotSha256) throw new Error('snapshot SHA-256 mismatch');
  let parsedSnapshot;
  try {
    parsedSnapshot = JSON.parse(snapshotText);
  } catch {
    throw new Error('snapshot bytes are not valid JSON');
  }
  if (stableJson(parsedSnapshot) !== stableJson(snapshot)) {
    throw new Error('snapshot object does not match snapshot bytes');
  }
  validateSnapshotEnvelope(parsedSnapshot);
  if (manifest.schemaVersion !== parsedSnapshot.schemaVersion) throw new Error('manifest schemaVersion mismatch');
  if (manifest.snapshotId !== parsedSnapshot.snapshotId) throw new Error('manifest snapshotId mismatch');
  if (manifest.retrievedAt !== parsedSnapshot.retrievedAt) throw new Error('manifest retrievedAt mismatch');
  if (manifest.source !== parsedSnapshot.source) throw new Error('manifest source mismatch');
  if (manifest.requestStartDate !== parsedSnapshot.request.startDate
    || manifest.requestEndDate !== parsedSnapshot.request.endDate) {
    throw new Error('manifest request range mismatch');
  }
  if (manifest.evidenceClass !== parsedSnapshot.evidenceClass) {
    throw new Error('manifest evidence class mismatch');
  }
  if (!sameKeys(manifest.series, CANONICAL_SERIES)) throw new Error('manifest series set mismatch');
  for (const seriesId of CANONICAL_SERIES) {
    const rows = parsedSnapshot.series[seriesId];
    const metadata = manifest.series[seriesId];
    if (metadata.url !== parsedSnapshot.request.urls[seriesId]
      || metadata.url !== fredCsvUrl(seriesId, parsedSnapshot.request.endDate)) {
      throw new Error(`${seriesId} manifest URL mismatch`);
    }
    if (metadata.rowCount !== rows.length
      || metadata.firstDate !== rows[0]?.date || metadata.lastDate !== rows.at(-1)?.date) {
      throw new Error(`${seriesId} manifest metadata mismatch`);
    }
    if (await sha256Hex(`${JSON.stringify(rows)}\n`) !== metadata.sha256) {
      throw new Error(`${seriesId} SHA-256 mismatch`);
    }
  }
  return Object.freeze({
    schemaVersion: parsedSnapshot.schemaVersion,
    snapshotId: parsedSnapshot.snapshotId,
    evidenceClass: parsedSnapshot.evidenceClass,
    retrievedAt: parsedSnapshot.retrievedAt,
    source: parsedSnapshot.source,
    snapshotSha256: actual,
    snapshot: parsedSnapshot,
  });
}
