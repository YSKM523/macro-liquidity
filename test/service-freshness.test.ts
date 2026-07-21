import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SeriesMap, Snapshot } from '../src/metrics';

const DATE = '2024-07-24';
const state = vi.hoisted(() => ({
  seriesMap: {} as SeriesMap,
  snapshots: new Map<string, Snapshot>(),
}));

vi.mock('../src/fred', () => ({ fetchFredSeries: vi.fn(async () => []) }));
vi.mock('../src/prices', () => ({
  fetchDxyDaily: vi.fn(async () => []),
  spliceSeries: vi.fn((official: unknown[]) => official),
}));
vi.mock('../src/db', () => ({
  maxObsDate: vi.fn(async () => DATE),
  upsertObservations: vi.fn(async () => undefined),
  loadSeriesMap: vi.fn(async () => state.seriesMap),
  upsertSnapshot: vi.fn(async (_db: unknown, snapshot: Snapshot) => {
    state.snapshots.set(snapshot.date, structuredClone(snapshot));
  }),
  setMeta: vi.fn(async () => undefined),
  getAllMeta: vi.fn(async () => ({})),
  snapshotBefore: vi.fn(async () => null),
}));

import { runIngest } from '../src/service';

const weekly = (start: number, step: number, count = 30) =>
  Array.from({ length: count }, (_, index) => ({
    date: new Date(Date.UTC(2024, 0, 3 + index * 7)).toISOString().slice(0, 10),
    value: start + index * step,
  }));
const daily = (start: number, step = 0, count = 206) =>
  Array.from({ length: count }, (_, index) => ({
    date: new Date(Date.UTC(2024, 0, 1 + index)).toISOString().slice(0, 10),
    value: start + index * step,
  }));

function completeMap(): SeriesMap {
  return {
    WALCL: weekly(6000, 15), WDTGAL: weekly(700, 1), RRPONTSYD: daily(500, -0.4),
    RPONTSYD: daily(0), SOFR: daily(5.3, -0.0002), IORB: daily(5.4),
    BAMLH0A0HYM2: daily(3.8, -0.001), DGS10: daily(4.2, 0.001), VIXCLS: daily(14),
    DTWEXBGS: daily(120, 0.01), SP500: daily(5000, 1), WRBWFRBL: weekly(3200, 8),
    T10Y2Y: daily(0.3, 0.001),
  };
}

const env = {
  DB: {} as D1Database, ASSETS: {} as Fetcher,
  FRED_API_KEY: 'test', ADMIN_TOKEN: 'test', START_DATE: '2024-01-01',
};

beforeEach(() => {
  vi.clearAllMocks();
  state.seriesMap = completeMap();
  state.snapshots.clear();
});

describe('incremental ingest current as-of', () => {
  it('persists a current incomplete snapshot when WALCL has halted beyond its freshness limit', async () => {
    await runIngest(env, false, new Date('2024-08-05T12:00:00.000Z'));

    const newest = state.snapshots.get('2024-08-05')!;
    expect(newest).toBeDefined();
    expect(newest.freshness.WALCL.status).toBe('STALE');
    expect(newest.decisionStatus).toBe('DATA_INCOMPLETE');
    expect(newest.score).toBeNull();
    expect(newest.verdict).toBeNull();
  });

  it('keeps a current complete feed decision valid', async () => {
    await runIngest(env, false, new Date('2024-07-24T12:00:00.000Z'));

    expect(state.snapshots.get(DATE)?.decisionStatus).toBe('OK');
    expect(state.snapshots.get(DATE)?.verdict).not.toBeNull();
  });
});
