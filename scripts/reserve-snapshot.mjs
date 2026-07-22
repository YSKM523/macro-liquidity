import { createHash } from 'node:crypto';
import { PREREGISTRATION } from './reserve-preregistration.mjs';

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const HASH = /^[0-9a-f]{64}$/;
const FRED_START_DATE = '2002-01-01';
const SRF_LAUNCH_DATE = '2021-07-29';
const FRED_IDS = Object.freeze(['WRESBAL', 'GDP', 'SOFR', 'IORB', 'EFFR', 'TGCRRATE', 'SP500']);
const SERIES = Object.freeze([...FRED_IDS, 'NYFED_SRF_ACCEPTED']);

function validDate(date) {
  return DATE.test(date ?? '') && new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) === date;
}

export function fredCsvUrl(seriesId, endDate) {
  if (!FRED_IDS.includes(seriesId)) throw new Error(`${seriesId} is not in the FRED allowlist`);
  if (!validDate(endDate)) throw new Error('FRED end date is invalid');
  return `https://fred.stlouisfed.org/graph/fredgraph.csv?id=${seriesId}&cosd=${FRED_START_DATE}&coed=${endDate}`;
}

export function nyFedRepoUrl(startDate, endDate) {
  if (!validDate(startDate) || !validDate(endDate) || startDate > endDate) throw new Error('NY Fed request date range is invalid');
  if (startDate !== SRF_LAUNCH_DATE) throw new Error(`NY Fed canonical request must start at SRF launch ${SRF_LAUNCH_DATE}`);
  return `https://markets.newyorkfed.org/api/rp/results/search.json?startDate=${startDate}&endDate=${endDate}&operationTypes=Repo`;
}

export function parseFredCsv(csv, seriesId) {
  if (!FRED_IDS.includes(seriesId)) throw new Error(`${seriesId} is not in the FRED allowlist`);
  const lines = csv.replace(/^\uFEFF/, '').trim().split(/\r?\n/);
  if (lines[0] !== `observation_date,${seriesId}`) throw new Error(`${seriesId} CSV header is invalid`);
  const rows = [];
  let prior = '';
  for (const line of lines.slice(1)) {
    if (!line) continue;
    const comma = line.indexOf(',');
    if (comma < 0) throw new Error(`${seriesId} CSV row is malformed`);
    const date = line.slice(0, comma);
    const raw = line.slice(comma + 1);
    if (!validDate(date)) throw new Error(`${seriesId} CSV date is invalid`);
    if (date <= prior) throw new Error(`${seriesId} CSV rows must be strictly sorted without duplicates`);
    prior = date;
    if (raw === '.' || raw === '') continue;
    const value = Number(raw);
    if (!Number.isFinite(value)) throw new Error(`${seriesId} CSV value is not numeric`);
    rows.push({ date, value });
  }
  return rows;
}

export function parseNyFedSrf(body) {
  let parsed;
  try { parsed = JSON.parse(body); } catch { throw new Error('NY Fed response is not valid JSON'); }
  if (!Array.isArray(parsed?.repo?.operations)) throw new Error('NY Fed repo.operations schema is invalid');
  const byDate = new Map();
  for (const operation of parsed.repo.operations) {
    if (!validDate(operation?.operationDate)) throw new Error('NY Fed operationDate is invalid');
    if (operation.operationDate < SRF_LAUNCH_DATE) throw new Error('NY Fed operationDate is before SRF launch');
    if (operation.operationType !== 'Repo') throw new Error('NY Fed operationType must be Repo');
    if (typeof operation.term !== 'string') throw new Error('NY Fed term is missing');
    if (!Number.isFinite(operation.totalAmtAccepted) || operation.totalAmtAccepted < 0) throw new Error('NY Fed totalAmtAccepted is invalid');
    if (operation.term !== 'Overnight') continue;
    byDate.set(operation.operationDate, (byDate.get(operation.operationDate) ?? 0) + operation.totalAmtAccepted / 1_000_000_000);
  }
  return [...byDate.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([date, value]) => ({ date, value }));
}

export function sha256Hex(content) {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

function sortedKeys(object) {
  return Object.keys(object ?? {}).sort();
}

function sameKeys(object, keys) {
  return JSON.stringify(sortedKeys(object)) === JSON.stringify([...keys].sort());
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function validateRows(name, rows) {
  if (!Array.isArray(rows) || rows.length === 0) throw new Error(`${name} snapshot is empty`);
  let prior = '';
  for (const row of rows) {
    if (!validDate(row?.date)) throw new Error(`${name} snapshot date is invalid`);
    if (row.date <= prior) throw new Error(`${name} snapshot rows must be strictly sorted`);
    if (!Number.isFinite(row.value)) throw new Error(`${name} snapshot value is non-finite`);
    prior = row.date;
  }
}

function validateEnvelope(snapshot) {
  if (snapshot?.schemaVersion !== 2) throw new Error('snapshot schemaVersion mismatch');
  if (typeof snapshot.snapshotId !== 'string' || !snapshot.snapshotId) throw new Error('snapshotId is invalid');
  if (snapshot.evidenceClass !== PREREGISTRATION.evidenceClass) throw new Error('snapshot evidence class mismatch');
  if (snapshot.source !== PREREGISTRATION.source) throw new Error('snapshot source mismatch');
  if (typeof snapshot.retrievedAt !== 'string' || new Date(snapshot.retrievedAt).toISOString() !== snapshot.retrievedAt) throw new Error('snapshot retrievedAt is invalid');
  if (snapshot.request?.fredStartDate !== FRED_START_DATE || snapshot.request?.nyFedStartDate !== SRF_LAUNCH_DATE || !validDate(snapshot.request?.endDate)) throw new Error('snapshot request range mismatch');
  if (!sameKeys(snapshot.request.fredUrls, FRED_IDS)) throw new Error('snapshot FRED URL set mismatch');
  for (const id of FRED_IDS) if (snapshot.request.fredUrls[id] !== fredCsvUrl(id, snapshot.request.endDate)) throw new Error(`${id} snapshot URL mismatch`);
  if (snapshot.request.nyFedUrl !== nyFedRepoUrl(SRF_LAUNCH_DATE, snapshot.request.endDate)) throw new Error('NY Fed snapshot URL mismatch');
  if (!sameKeys(snapshot.series, SERIES)) throw new Error('snapshot series set mismatch');
  for (const id of SERIES) validateRows(id, snapshot.series[id]);
  if (snapshot.series.NYFED_SRF_ACCEPTED[0].date < SRF_LAUNCH_DATE) throw new Error('NY Fed normalized series begins before SRF launch');
}

export async function buildReserveManifest(snapshot, snapshotText, responseHashes) {
  validateEnvelope(snapshot);
  if (!sameKeys(responseHashes, SERIES)) throw new Error('response hash series set mismatch');
  const series = {};
  for (const id of SERIES) {
    if (!HASH.test(responseHashes[id])) throw new Error(`${id} response SHA-256 is invalid`);
    const rows = snapshot.series[id];
    series[id] = {
      provider: id === 'NYFED_SRF_ACCEPTED' ? 'NYFED_MARKETS_API' : 'FRED',
      url: id === 'NYFED_SRF_ACCEPTED' ? snapshot.request.nyFedUrl : snapshot.request.fredUrls[id],
      rowCount: rows.length, firstDate: rows[0].date, lastDate: rows.at(-1).date,
      normalizedSha256: sha256Hex(`${JSON.stringify(rows)}\n`),
      sourceResponseSha256: responseHashes[id],
    };
  }
  return {
    schemaVersion: snapshot.schemaVersion, snapshotId: snapshot.snapshotId,
    evidenceClass: snapshot.evidenceClass, source: snapshot.source, retrievedAt: snapshot.retrievedAt,
    fredStartDate: snapshot.request.fredStartDate, nyFedStartDate: snapshot.request.nyFedStartDate,
    requestEndDate: snapshot.request.endDate,
    snapshotSha256: sha256Hex(snapshotText), series,
  };
}

export async function verifyReserveSnapshot(snapshot, snapshotText, manifest) {
  const actualHash = sha256Hex(snapshotText);
  if (actualHash !== manifest.snapshotSha256) throw new Error('snapshot SHA-256 mismatch');
  let bytesObject;
  try { bytesObject = JSON.parse(snapshotText); } catch { throw new Error('snapshot bytes are invalid JSON'); }
  if (stableJson(bytesObject) !== stableJson(snapshot)) throw new Error('snapshot object does not match snapshot bytes');
  validateEnvelope(bytesObject);
  for (const field of ['schemaVersion', 'snapshotId', 'evidenceClass', 'source', 'retrievedAt']) {
    if (manifest[field] !== bytesObject[field]) throw new Error(`manifest ${field} mismatch`);
  }
  if (manifest.fredStartDate !== bytesObject.request.fredStartDate
    || manifest.nyFedStartDate !== bytesObject.request.nyFedStartDate
    || manifest.requestEndDate !== bytesObject.request.endDate) throw new Error('manifest request range mismatch');
  if (!sameKeys(manifest.series, SERIES)) throw new Error('manifest series set mismatch');
  for (const id of SERIES) {
    const metadata = manifest.series[id];
    const rows = bytesObject.series[id];
    const expectedUrl = id === 'NYFED_SRF_ACCEPTED' ? bytesObject.request.nyFedUrl : bytesObject.request.fredUrls[id];
    const expectedProvider = id === 'NYFED_SRF_ACCEPTED' ? 'NYFED_MARKETS_API' : 'FRED';
    if (metadata.url !== expectedUrl) throw new Error(`${id} manifest URL mismatch`);
    if (metadata.provider !== expectedProvider) throw new Error(`${id} manifest provider mismatch`);
    if (metadata.rowCount !== rows.length || metadata.firstDate !== rows[0].date || metadata.lastDate !== rows.at(-1).date) throw new Error(`${id} manifest range mismatch`);
    if (metadata.normalizedSha256 !== sha256Hex(`${JSON.stringify(rows)}\n`)) throw new Error(`${id} normalized SHA-256 mismatch`);
    if (!HASH.test(metadata.sourceResponseSha256)) throw new Error(`${id} response SHA-256 is invalid`);
  }
  return Object.freeze({ ...manifest, snapshot: bytesObject });
}
