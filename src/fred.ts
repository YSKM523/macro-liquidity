import { UNIT_BY_ID } from './config';
import { fetchWithRetry, releaseResponseBody } from './http-retry';
import type { HttpFetcher, HttpRetryOptions } from './http-retry';
import { deriveReleaseTiming, pitChecksum } from './pit';
import type { PitObservation, ReleaseOverride, ReleaseRule } from './pit';

export interface Obs { date: string; value: number }

export type ReleaseRules = ReleaseRule | ReleaseRule[];

export interface FredFetchOptions extends HttpRetryOptions {
  fetchFn?: HttpFetcher;
}

export function parseFredJson(seriesId: string, json: any): Obs[] {
  const unit = UNIT_BY_ID[seriesId] ?? 'I';
  const rows: Obs[] = [];
  for (const o of (json?.observations ?? [])) {
    if (o.value === '.' || o.value == null || o.value === '') continue;
    let v = Number(o.value);
    if (!Number.isFinite(v)) continue;
    if (unit === 'M') v = v / 1000; // millions → billions
    rows.push({ date: o.date, value: v });
  }
  rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return rows;
}

export async function fetchFredSeries(
  seriesId: string,
  fromDate: string,
  apiKey: string,
  options: FredFetchOptions = {},
): Promise<Obs[]> {
  const url = new URL('https://api.stlouisfed.org/fred/series/observations');
  url.searchParams.set('series_id', seriesId);
  url.searchParams.set('api_key', apiKey);
  url.searchParams.set('file_type', 'json');
  url.searchParams.set('observation_start', fromDate);
  const res = await fetchWithRetry(options.fetchFn ?? fetch, url.toString(), undefined, options);
  if (!res.ok) {
    await releaseResponseBody(res);
    throw new Error(`FRED ${seriesId} ${res.status}`);
  }
  return parseFredJson(seriesId, await res.json());
}

function strictDate(value: unknown, field: string): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)
    || new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) {
    throw new Error(`invalid ALFRED ${field}`);
  }
  return value;
}

function normalizeReleaseRules(releaseRules: ReleaseRules): ReleaseRule[] {
  const rules = Array.isArray(releaseRules) ? releaseRules : [releaseRules];
  for (const rule of rules) {
    if (rule.validFrom != null) strictDate(rule.validFrom, 'release rule validFrom');
    if (rule.validTo != null) strictDate(rule.validTo, 'release rule validTo');
    if (rule.validFrom != null && rule.validTo != null && rule.validFrom > rule.validTo) {
      throw new Error('invalid ALFRED release rule validity range');
    }
  }
  return rules;
}

export async function parseFredPitJson(
  seriesId: string,
  json: any,
  fetchedAt: string,
  releaseRules: ReleaseRules,
  overrides: Map<string, ReleaseOverride>,
): Promise<PitObservation[]> {
  const unit = UNIT_BY_ID[seriesId] ?? 'I';
  const byKey = new Map<string, PitObservation>();
  const rules = normalizeReleaseRules(releaseRules);
  for (const raw of (json?.observations ?? [])) {
    if (raw.value === '.' || raw.value == null || raw.value === '') continue;
    let value = Number(raw.value);
    if (!Number.isFinite(value)) continue;
    if (unit === 'M') value /= 1000;
    const observationDate = strictDate(raw.date, 'observation date');
    const vintageDate = strictDate(raw.realtime_start, 'vintage date');
    const matchingRules = rules.filter(rule =>
      vintageDate >= (rule.validFrom ?? '0000-01-01')
      && vintageDate <= (rule.validTo ?? '9999-12-31'));
    if (matchingRules.length !== 1) {
      throw new Error(`${seriesId} vintage ${vintageDate} must match one unique release rule`);
    }
    const timing = deriveReleaseTiming(
      vintageDate, fetchedAt, matchingRules[0].expectedReleaseTime, overrides.get(vintageDate),
    );
    const checksum = await pitChecksum(seriesId, observationDate, vintageDate, value);
    const row: PitObservation = {
      seriesId, observationDate, vintageDate, fetchedAt, source: 'ALFRED', value, checksum, ...timing,
    };
    const key = `${seriesId}|${observationDate}|${vintageDate}`;
    const previous = byKey.get(key);
    if (previous && previous.checksum !== checksum) throw new Error(`conflicting ALFRED vintage ${key}`);
    byKey.set(key, row);
  }
  return [...byKey.values()].sort((a, b) =>
    a.vintageDate.localeCompare(b.vintageDate) || a.observationDate.localeCompare(b.observationDate));
}

export async function fetchFredSeriesPit(
  seriesId: string,
  observationStart: string,
  realtimeStart: string,
  fetchedAt: string,
  apiKey: string,
  releaseRules: ReleaseRules,
  overrides: Map<string, ReleaseOverride>,
  observedAt: () => string = () => fetchedAt,
  options: FredFetchOptions = {},
): Promise<{ latestRows: Obs[]; vintages: PitObservation[] }> {
  const all: PitObservation[] = [];
  const limit = 100000;
  let offset = 0;
  for (;;) {
    const url = new URL('https://api.stlouisfed.org/fred/series/observations');
    for (const [key, value] of Object.entries({
      series_id: seriesId, api_key: apiKey, file_type: 'json', output_type: '3',
      observation_start: observationStart, realtime_start: realtimeStart,
      realtime_end: fetchedAt.slice(0, 10), limit: String(limit), offset: String(offset),
    })) url.searchParams.set(key, value);
    const response = await fetchWithRetry(options.fetchFn ?? fetch, url.toString(), undefined, options);
    if (!response.ok) {
      await releaseResponseBody(response);
      throw new Error(`ALFRED ${seriesId} ${response.status}`);
    }
    const json: any = await response.json();
    const pageFetchedAt = observedAt();
    all.push(...await parseFredPitJson(seriesId, json, pageFetchedAt, releaseRules, overrides));
    const count = Number(json?.count ?? all.length);
    const pageLimit = Number(json?.limit ?? limit);
    const pageOffset = Number(json?.offset ?? offset);
    if (!Number.isFinite(count) || count <= pageOffset + pageLimit) break;
    offset = pageOffset + pageLimit;
  }
  const unique = new Map<string, PitObservation>();
  for (const row of all) {
    const key = `${row.seriesId}|${row.observationDate}|${row.vintageDate}`;
    const previous = unique.get(key);
    if (previous && previous.checksum !== row.checksum) throw new Error(`conflicting ALFRED vintage ${key}`);
    unique.set(key, row);
  }
  const vintages = [...unique.values()].sort((a, b) =>
    a.vintageDate.localeCompare(b.vintageDate) || a.observationDate.localeCompare(b.observationDate));
  const latest = new Map<string, PitObservation>();
  for (const row of vintages) {
    const previous = latest.get(row.observationDate);
    if (previous == null || row.vintageDate >= previous.vintageDate) latest.set(row.observationDate, row);
  }
  const latestRows = [...latest.values()]
    .sort((a, b) => a.observationDate.localeCompare(b.observationDate))
    .map(row => ({ date: row.observationDate, value: row.value }));
  return { latestRows, vintages };
}
