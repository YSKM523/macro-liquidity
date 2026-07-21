import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SERIES_IDS } from '../src/config';
import type { Obs, SeriesMap, Snapshot } from '../src/metrics';

const state = vi.hoisted(() => ({
  fetchFailureSeries: null as string | null,
  activationFailure: false,
  lockAcquired: true,
  activeSeries: new Set<string>(),
  staged: [] as Array<{ seriesId: string; rows: Obs[] }>,
  events: [] as string[],
  failed: [] as Array<{ step: string; seriesId?: string; error: string }>,
  seriesMap: {
    WALCL: [{ date: '2024-01-03', value: 6000 }],
    SP500: [{ date: '2024-01-03', value: 4700 }],
    DTWEXBGS: [],
  } as SeriesMap,
}));

vi.mock('../src/fred', () => ({
  fetchFredSeries: vi.fn(async (seriesId: string) => {
    state.events.push(`fetch:${seriesId}`);
    if (seriesId === state.fetchFailureSeries) throw new Error(`fetch failed: ${seriesId}`);
    return seriesId === 'WALCL' ? [] : [{ date: '2024-01-03', value: 1 }];
  }),
}));

vi.mock('../src/prices', () => ({
  fetchDxyDaily: vi.fn(async () => []),
  spliceSeries: vi.fn((official: unknown[]) => official),
}));

vi.mock('../src/db', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/db')>();
  return {
    ...actual,
    getAllMeta: vi.fn(async () => ({})),
    setMeta: vi.fn(async () => undefined),
    maxObsDate: vi.fn(async () => '2024-01-03'),
    upsertObservations: vi.fn(async () => undefined),
    acquireIngestLock: vi.fn(async () => state.lockAcquired),
    releaseIngestLock: vi.fn(async () => { state.events.push('release'); return true; }),
    createIngestRun: vi.fn(async () => { state.events.push('create'); }),
    stageSeriesAttempt: vi.fn(async (_db: unknown, runId: string, seriesId: string, rows: Obs[]) => {
      state.staged.push({ seriesId, rows: structuredClone(rows) });
      state.events.push(`stage:${seriesId}:${rows.length}`);
    }),
    validateIngestRun: vi.fn(async () => { state.events.push('validate'); }),
    activateIngestRun: vi.fn(async () => {
      state.events.push('activate');
      if (state.activationFailure) throw new Error('activation failed');
    }),
    failIngestRun: vi.fn(async (_db: unknown, _runId: string, failure: { step: string; seriesId?: string; error: string }) => {
      state.failed.push(failure);
      state.events.push(`failed:${failure.step}`);
    }),
    loadSeriesMap: vi.fn(async () => { state.events.push('load-active'); return state.seriesMap; }),
    upsertOfficialSnapshot: vi.fn(async (_db: unknown, snapshot: Snapshot) => { state.events.push(`official:${snapshot.date}`); }),
    upsertNowcastSnapshot: vi.fn(async (_db: unknown, snapshot: Snapshot) => { state.events.push(`nowcast:${snapshot.date}`); }),
    officialSnapshotBefore: vi.fn(async () => null),
    officialVerdictAnchors: vi.fn(async () => []),
  };
});

vi.mock('../src/metrics', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/metrics')>();
  return {
    ...actual,
    computeSnapshot: vi.fn((_map: SeriesMap, date: string): Snapshot => ({
      date, walcl: 6000, tga: 700, rrp: 100, repo: 0, netliq: 5200, netliqTrend: 5200,
      sofrIorb: 0, hyOas: 3, dgs10: 4, dxy: 100, vix: 15, bsImpulse: 'FLAT', netliqDir: 'FLAT',
      verdict: 'NEUTRAL', score: 50, factors: {}, factorResults: {}, freshness: {}, decisionStatus: 'OK',
      p0: true, p1: true, p2: true, p3: true, reason: 'test', coverage: 1,
    } as any)),
  };
});

import { runIngest, scheduledIngest } from '../src/service';
import { failIngestRun } from '../src/db';

const env = {
  DB: {} as D1Database,
  ASSETS: {} as Fetcher,
  FRED_API_KEY: 'test',
  ADMIN_TOKEN: 'test',
  START_DATE: '2024-01-01',
};

beforeEach(() => {
  vi.clearAllMocks();
  state.fetchFailureSeries = null;
  state.activationFailure = false;
  state.lockAcquired = true;
  state.activeSeries = new Set(SERIES_IDS);
  state.staged = [];
  state.events = [];
  state.failed = [];
});

describe('atomic ingest orchestration', () => {
  it('records a middle-series fetch failure without activation or snapshot writes', async () => {
    state.fetchFailureSeries = SERIES_IDS[1];

    await expect(runIngest(env, false, new Date('2024-01-10T12:00:00Z'))).rejects.toThrow(SERIES_IDS[1]);

    expect(state.events).toContain('create');
    expect(failIngestRun).toHaveBeenCalled();
    expect(state.failed).toEqual([expect.objectContaining({ step: 'fetch', seriesId: SERIES_IDS[1] })]);
    expect(state.events).not.toContain('activate');
    expect(state.events.some(event => event.startsWith('official:') || event.startsWith('nowcast:'))).toBe(false);
    expect(state.events).not.toContain('load-active');
    expect(state.events.at(-1)).toBe('release');
  });

  it('marks activation failure FAILED and never writes snapshots afterward', async () => {
    state.activationFailure = true;

    await expect(runIngest(env, false, new Date('2024-01-10T12:00:00Z'))).rejects.toThrow('activation failed');

    expect(failIngestRun).toHaveBeenCalled();
    expect(state.failed).toEqual([expect.objectContaining({ step: 'activation' })]);
    expect(state.events.some(event => event.startsWith('official:') || event.startsWith('nowcast:'))).toBe(false);
    expect(state.events).not.toContain('load-active');
  });

  it('stages every attempt, activates exactly once, then rebuilds from the active view', async () => {
    const result = await runIngest(env, false, new Date('2024-01-10T12:00:00Z'));

    expect(state.staged.map(item => item.seriesId)).toEqual(SERIES_IDS);
    expect(state.events.filter(event => event === 'activate')).toHaveLength(1);
    expect(state.events.indexOf('activate')).toBeLessThan(state.events.indexOf('load-active'));
    expect(state.events.some(event => event.startsWith('nowcast:'))).toBe(true);
    expect(result).toEqual(expect.objectContaining({ status: 'active', runId: expect.any(String) }));
  });

  it('records a successful zero-row current series attempt', async () => {
    await runIngest(env, false, new Date('2024-01-10T12:00:00Z'));

    expect(state.staged).toContainEqual({ seriesId: 'WALCL', rows: [] });
    expect(state.events).toContain('stage:WALCL:0');
    expect(state.events).toContain('validate');
  });

  it('returns explicit contention without fetching, staging, activation, or snapshots', async () => {
    state.lockAcquired = false;

    const result = await runIngest(env, false, new Date('2024-01-10T12:00:00Z'));

    expect(result).toEqual(expect.objectContaining({ status: 'conflict', runId: expect.any(String) }));
    expect(state.events).toEqual([]);
  });

  it('scheduled contention is returned explicitly and produces no overlapping writes', async () => {
    state.lockAcquired = false;
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const result = await scheduledIngest('0 */3 * * *', env, new Date('2024-01-10T12:00:00Z'));

    expect(result).toEqual(expect.objectContaining({ status: 'conflict' }));
    expect(warning).toHaveBeenCalledWith(expect.stringContaining('lease contention'));
    expect(state.staged).toEqual([]);
  });
});
