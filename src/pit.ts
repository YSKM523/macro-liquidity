import { SERIES_IDS } from './config';
import type { SeriesMap } from './metrics';

export type ReleaseTimeStatus = 'OBSERVED_AT_FETCH' | 'CONSERVATIVE_DATE_END' | 'OVERRIDE';

export interface PitObservation {
  seriesId: string;
  observationDate: string;
  vintageDate: string;
  releasedAt: string;
  fetchedAt: string;
  tradableAt: string;
  source: 'ALFRED';
  checksum: string;
  releaseTimeStatus: ReleaseTimeStatus;
  value: number;
}

export interface ReleaseRule {
  expectedReleaseTime: string;
  validFrom?: string;
  validTo?: string;
}
export interface ReleaseOverride { releasedAt: string; tradableAt: string }

export type SnapshotInput =
  | (PitObservation & { inputStatus: 'AVAILABLE' })
  | {
      seriesId: string; inputStatus: 'MISSING'; observationDate: null; vintageDate: null;
      releasedAt: null; fetchedAt: null; tradableAt: null; source: null; checksum: null;
      releaseTimeStatus: null; value: null;
    };

export interface PitDecisionEvent {
  modelDate: string;
  decisionAt: string;
  tradableAt: string;
}

export interface PitFrame {
  event: PitDecisionEvent;
  seriesMap: SeriesMap;
  inputs: SnapshotInput[];
  dataCutoff: string | null;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{3})?Z$/;

function validDate(value: string): boolean {
  if (!DATE_RE.test(value)) return false;
  return new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
}

function requireIso(value: string, field: string): void {
  if (!ISO_RE.test(value) || !Number.isFinite(Date.parse(value))) throw new Error(`invalid ${field}`);
}

export function validateReleaseOverride(override: ReleaseOverride): void {
  requireIso(override.releasedAt, 'override releasedAt');
  requireIso(override.tradableAt, 'override tradableAt');
  if (override.tradableAt < override.releasedAt) {
    throw new Error('override tradableAt precedes releasedAt');
  }
}

function nextWeekday1430(releasedAt: string): string {
  const d = new Date(releasedAt);
  d.setUTCDate(d.getUTCDate() + 1);
  while (d.getUTCDay() === 0 || d.getUTCDay() === 6) d.setUTCDate(d.getUTCDate() + 1);
  d.setUTCHours(14, 30, 0, 0);
  return d.toISOString().replace('.000Z', 'Z');
}

export function deriveReleaseTiming(
  vintageDate: string,
  fetchedAt: string,
  expectedReleaseTime: string,
  override?: ReleaseOverride,
): Pick<PitObservation, 'releasedAt' | 'tradableAt' | 'releaseTimeStatus'> {
  if (!validDate(vintageDate)) throw new Error('invalid vintage date');
  requireIso(fetchedAt, 'fetchedAt');
  if (!TIME_RE.test(expectedReleaseTime)) throw new Error('invalid expected release time');
  if (override) {
    validateReleaseOverride(override);
    return { ...override, releaseTimeStatus: 'OVERRIDE' };
  }
  const releasedAt = fetchedAt.slice(0, 10) === vintageDate
    ? fetchedAt
    : `${vintageDate}T${expectedReleaseTime}Z`;
  return {
    releasedAt,
    tradableAt: nextWeekday1430(releasedAt),
    releaseTimeStatus: fetchedAt.slice(0, 10) === vintageDate
      ? 'OBSERVED_AT_FETCH'
      : 'CONSERVATIVE_DATE_END',
  };
}

export async function pitChecksum(
  seriesId: string,
  observationDate: string,
  vintageDate: string,
  value: number,
): Promise<string> {
  const bytes = new TextEncoder().encode(`${seriesId}|${observationDate}|${vintageDate}|${value}`);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

export function availableForExecution(
  row: PitObservation,
  decisionAt: string,
  executionAt: string,
): boolean {
  return row.releasedAt <= decisionAt && row.tradableAt <= executionAt;
}

interface ActiveSeries {
  rows: PitObservation[];
  observations: { date: string; value: number }[];
  releasedAtMax: string[];
  tradableAtMax: string[];
}

function lowerBoundObservation(rows: PitObservation[], observationDate: string): number {
  let low = 0;
  let high = rows.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (rows[mid].observationDate < observationDate) low = mid + 1;
    else high = mid;
  }
  return low;
}

function upperBoundObservation(rows: PitObservation[], modelDate: string): number {
  let low = 0;
  let high = rows.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (rows[mid].observationDate <= modelDate) low = mid + 1;
    else high = mid;
  }
  return low;
}

function activateRow(active: Map<string, ActiveSeries>, row: PitObservation): void {
  const series = active.get(row.seriesId) ?? {
    rows: [], observations: [], releasedAtMax: [], tradableAtMax: [],
  };
  const index = lowerBoundObservation(series.rows, row.observationDate);
  const previous = series.rows[index];
  if (previous?.observationDate === row.observationDate) {
    if (row.vintageDate < previous.vintageDate) return;
    series.rows[index] = row;
    series.observations[index] = { date: row.observationDate, value: row.value };
  } else {
    series.rows.splice(index, 0, row);
    series.observations.splice(index, 0, { date: row.observationDate, value: row.value });
    series.releasedAtMax.splice(index, 0, row.releasedAt);
    series.tradableAtMax.splice(index, 0, row.tradableAt);
  }
  for (let cursor = index; cursor < series.rows.length; cursor++) {
    const current = series.rows[cursor];
    const previousReleasedAt = cursor === 0 ? null : series.releasedAtMax[cursor - 1];
    const previousTradableAt = cursor === 0 ? null : series.tradableAtMax[cursor - 1];
    series.releasedAtMax[cursor] = previousReleasedAt != null && previousReleasedAt > current.releasedAt
      ? previousReleasedAt : current.releasedAt;
    series.tradableAtMax[cursor] = previousTradableAt != null && previousTradableAt > current.tradableAt
      ? previousTradableAt : current.tradableAt;
  }
  active.set(row.seriesId, series);
}

function frameFromActive(active: Map<string, ActiveSeries>, event: PitDecisionEvent): PitFrame {
  const seriesMap: SeriesMap = {};
  const inputs: SnapshotInput[] = [];
  let dataCutoff: string | null = null;
  let frameTradableAt = event.tradableAt;
  for (const seriesId of SERIES_IDS) {
    const series = active.get(seriesId);
    const end = series == null ? 0 : upperBoundObservation(series.rows, event.modelDate);
    const rows = series?.rows.slice(0, end) ?? [];
    seriesMap[seriesId] = series?.observations.slice(0, end) ?? [];
    const releasedAt = end === 0 ? null : series!.releasedAtMax[end - 1];
    const tradableAt = end === 0 ? null : series!.tradableAtMax[end - 1];
    if (tradableAt != null && tradableAt > frameTradableAt) frameTradableAt = tradableAt;
    if (releasedAt != null && (dataCutoff == null || releasedAt > dataCutoff)) dataCutoff = releasedAt;
    const latest = rows.at(-1);
    if (latest) {
      inputs.push({ ...latest, inputStatus: 'AVAILABLE' });
    } else {
      inputs.push({
        seriesId, inputStatus: 'MISSING', observationDate: null, vintageDate: null,
        releasedAt: null, fetchedAt: null, tradableAt: null, source: null, checksum: null,
        releaseTimeStatus: null, value: null,
      });
    }
  }
  return {
    event: { ...event, tradableAt: frameTradableAt },
    seriesMap,
    inputs,
    dataCutoff: dataCutoff ?? event.decisionAt,
  };
}

export function* iteratePitFrames(
  rows: PitObservation[],
  events: PitDecisionEvent[],
): Generator<PitFrame, void, undefined> {
  const releases = rows.slice().sort((a, b) =>
    a.releasedAt.localeCompare(b.releasedAt)
    || a.seriesId.localeCompare(b.seriesId)
    || a.observationDate.localeCompare(b.observationDate)
    || a.vintageDate.localeCompare(b.vintageDate));
  const orderedEvents = events.slice().sort((a, b) => a.decisionAt.localeCompare(b.decisionAt));
  const active = new Map<string, ActiveSeries>();
  let cursor = 0;
  for (const event of orderedEvents) {
    while (cursor < releases.length && releases[cursor].releasedAt <= event.decisionAt) {
      activateRow(active, releases[cursor++]);
    }
    yield frameFromActive(active, event);
  }
}

export function buildPitFrames(rows: PitObservation[], events: PitDecisionEvent[]): PitFrame[] {
  return Array.from(iteratePitFrames(rows, events));
}

export function resolvePitFrame(rows: PitObservation[], event: PitDecisionEvent): PitFrame {
  return buildPitFrames(rows, [event])[0];
}
