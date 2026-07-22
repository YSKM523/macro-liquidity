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

export interface ReleaseRule { expectedReleaseTime: string }
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

function frameFromActive(
  active: Map<string, Map<string, PitObservation>>,
  event: PitDecisionEvent,
): PitFrame {
  const seriesMap: SeriesMap = {};
  const inputs: SnapshotInput[] = [];
  let dataCutoff: string | null = null;
  let frameTradableAt = event.tradableAt;
  for (const seriesId of SERIES_IDS) {
    const rows = [...(active.get(seriesId)?.values() ?? [])]
      .filter(row => row.observationDate <= event.modelDate)
      .sort((a, b) => a.observationDate.localeCompare(b.observationDate));
    seriesMap[seriesId] = rows.map(row => ({ date: row.observationDate, value: row.value }));
    for (const row of rows) {
      if (row.tradableAt > frameTradableAt) frameTradableAt = row.tradableAt;
    }
    const latest = rows.at(-1);
    if (latest) {
      inputs.push({ ...latest, inputStatus: 'AVAILABLE' });
      if (dataCutoff == null || latest.releasedAt > dataCutoff) dataCutoff = latest.releasedAt;
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

export function buildPitFrames(rows: PitObservation[], events: PitDecisionEvent[]): PitFrame[] {
  const releases = rows.slice().sort((a, b) =>
    a.releasedAt.localeCompare(b.releasedAt)
    || a.seriesId.localeCompare(b.seriesId)
    || a.observationDate.localeCompare(b.observationDate)
    || a.vintageDate.localeCompare(b.vintageDate));
  const orderedEvents = events.slice().sort((a, b) => a.decisionAt.localeCompare(b.decisionAt));
  const active = new Map<string, Map<string, PitObservation>>();
  const frames: PitFrame[] = [];
  let cursor = 0;
  for (const event of orderedEvents) {
    while (cursor < releases.length && releases[cursor].releasedAt <= event.decisionAt) {
      const row = releases[cursor++];
      const byDate = active.get(row.seriesId) ?? new Map<string, PitObservation>();
      const previous = byDate.get(row.observationDate);
      if (previous == null || row.vintageDate >= previous.vintageDate) byDate.set(row.observationDate, row);
      active.set(row.seriesId, byDate);
    }
    frames.push(frameFromActive(active, event));
  }
  return frames;
}

export function resolvePitFrame(rows: PitObservation[], event: PitDecisionEvent): PitFrame {
  return buildPitFrames(rows, [event])[0];
}
