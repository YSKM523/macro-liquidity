import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SERIES_IDS } from '../src/config';
import type { Obs, SeriesMap, Snapshot } from '../src/metrics';

const state = vi.hoisted(() => ({
  fetchFailureSeries: null as string | null,
  invalidSeries: null as string | null,
  stagingFailureSeries: null as string | null,
  semanticValidationFailureSeries: null as string | null,
  attemptAuditFailure: false,
  activationFailure: false,
  lockAcquired: true,
  leaseRenewed: true,
  leaseFailureAfterEvent: null as string | null,
  snapshotWriteFailure: false,
  metaFailureKey: null as string | null,
  seriesReadFailureSeries: null as string | null,
  maxPitVintage: '2024-01-03' as string | null,
  maxObsDate: '2024-01-02' as string | null,
  activeSeries: new Set<string>(),
  staged: [] as Array<{ seriesId: string; rows: Obs[] }>,
  pitStaged: [] as string[],
  fetchArgs: [] as Array<{
    seriesId: string;
    observationStart: string;
    realtimeStart: string;
    resolveFirstVintage: boolean;
    currentOnly: boolean;
  }>,
  fetchObservedAts: [] as string[],
  rowResolutionAts: [] as string[],
  eventResolutionAts: [] as string[],
  snapshotResolutionAts: [] as string[],
  attemptFailures: [] as Array<{ seriesId: string; error: string; completedAt: string }>,
  snapshotFailures: [] as Array<{ step: string; error: string; completedAt: string }>,
  successPublications: [] as Array<{ count: number; completedAt: string; meta: Array<[string, string]> }>,
  activationCompletedAt: null as string | null,
  runFailureCompletedAt: null as string | null,
  events: [] as string[],
  failed: [] as Array<{ step: string; seriesId?: string; error: string }>,
  seriesMap: {
    WALCL: [{ date: '2024-01-03', value: 6000 }],
    SP500: [{ date: '2024-01-03', value: 4700 }],
    DTWEXBGS: [],
  } as SeriesMap,
}));

vi.mock('../src/fred', () => ({
  fetchFredSeriesPit: vi.fn(async (
    seriesId: string, observationStart: string, realtimeStart: string,
    _fetchedAt: string, _apiKey: string, _rules: unknown, _overrides: unknown,
    observedAt: () => string,
    options?: { resolveFirstVintage?: boolean; currentOnly?: boolean },
  ) => {
    state.events.push(`fetch:${seriesId}`);
    state.fetchArgs.push({
      seriesId,
      observationStart,
      realtimeStart,
      resolveFirstVintage: options?.resolveFirstVintage ?? false,
      currentOnly: options?.currentOnly ?? false,
    });
    if (seriesId === state.fetchFailureSeries) throw new Error(`fetch failed: ${seriesId}`);
    state.fetchObservedAts.push(observedAt());
    const latestRows = seriesId === state.invalidSeries ? [{ date: 'not-a-date', value: 1 }]
      : seriesId === 'WALCL' ? [] : [{ date: '2024-01-03', value: 1 }];
    return { latestRows, vintages: [] };
  }),
}));

vi.mock('../src/prices', () => ({
  fetchDxyDaily: vi.fn(async () => { state.events.push('fetch-dxy'); return []; }),
  spliceSeries: vi.fn((official: unknown[]) => official),
}));

vi.mock('../src/db', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/db')>();
  return {
    ...actual,
    getAllMeta: vi.fn(async () => ({})),
    recordAlertDelivery: vi.fn(async () => undefined),
    setIngestMeta: vi.fn(async (_db: unknown, _runId: string, key: string) => {
      state.events.push(`meta:${key}`);
      if (key === state.metaFailureKey) throw new Error(`meta failed: ${key}`);
    }),
    maxPitVintageDate: vi.fn(async (_db: unknown, seriesId: string) => {
      state.events.push(`max-pit:${seriesId}`);
      if (seriesId === state.seriesReadFailureSeries) throw new Error(`series read failed: ${seriesId}`);
      return state.maxPitVintage;
    }),
    maxObsDate: vi.fn(async (_db: unknown, seriesId: string) => {
      state.events.push(`max-obs:${seriesId}`);
      return state.maxObsDate;
    }),
    loadReleaseRules: vi.fn(async () => { state.events.push('release-rules'); return new Map(SERIES_IDS.map(id => [id, { expectedReleaseTime: '23:59:59' }])); }),
    loadReleaseOverrides: vi.fn(async () => new Map()),
    stagePitObservations: vi.fn(async (_db: unknown, _runId: string, rows: Array<{seriesId:string}>) => {
      state.pitStaged.push(...rows.map(row => row.seriesId)); state.events.push('stage-pit');
    }),
    acquireIngestLock: vi.fn(async () => state.lockAcquired),
    renewIngestLock: vi.fn(async () => {
      const previous = state.events.at(-1);
      state.events.push('renew');
      if (previous === state.leaseFailureAfterEvent) state.leaseRenewed = false;
      return state.leaseRenewed;
    }),
    releaseIngestLock: vi.fn(async () => { state.events.push('release'); return true; }),
    createIngestRun: vi.fn(async () => { state.events.push('create'); }),
    startSeriesAttempt: vi.fn(async (_db: unknown, _runId: string, seriesId: string, startedAt: string) => {
      state.events.push(`attempt-start:${seriesId}:${startedAt}`);
    }),
    failSeriesAttempt: vi.fn(async (_db: unknown, _runId: string, seriesId: string, error: string, completedAt: string) => {
      state.events.push(`attempt-failed:${seriesId}`);
      if (state.attemptAuditFailure) throw new Error('attempt audit failed');
      state.attemptFailures.push({ seriesId, error, completedAt });
    }),
    stageSeriesAttempt: vi.fn(async (_db: unknown, _runId: string, seriesId: string, rows: Obs[], completedAt: string) => {
      if (seriesId === state.stagingFailureSeries) throw new Error(`staging failed: ${seriesId}`);
      state.staged.push({ seriesId, rows: structuredClone(rows) });
      state.events.push(`stage:${seriesId}:${rows.length}:${completedAt}`);
    }),
    validateIngestRun: vi.fn(async () => {
      state.events.push('validate');
      if (state.semanticValidationFailureSeries) {
        const error = new Error(
          `${state.semanticValidationFailureSeries} returned empty without active production history`,
        ) as Error & { seriesId: string };
        error.seriesId = state.semanticValidationFailureSeries;
        throw error;
      }
    }),
    activateIngestRun: vi.fn(async (_db: unknown, _runId: string, completedAt: string) => {
      state.activationCompletedAt = completedAt;
      state.events.push('activate');
      if (state.activationFailure) throw new Error('activation failed');
    }),
    failIngestRun: vi.fn(async (_db: unknown, _runId: string, failure: { step: string; seriesId?: string; error: string }, completedAt: string) => {
      state.runFailureCompletedAt = completedAt;
      state.failed.push(failure);
      state.events.push(`failed:${failure.step}`);
    }),
    loadPitObservations: vi.fn(async (_db: unknown, releaseResolutionAt: string) => {
      state.rowResolutionAts.push(releaseResolutionAt);
      state.events.push('load-active');
      return Object.entries(state.seriesMap).flatMap(([seriesId, rows]) => rows.map(row => ({
        seriesId, observationDate: row.date, vintageDate: row.date, releasedAt: `${row.date}T00:00:00Z`,
        fetchedAt: `${row.date}T00:00:00Z`, tradableAt: `${row.date}T14:30:00Z`, source: 'ALFRED',
        checksum: `${seriesId}-${row.date}`, releaseTimeStatus: 'OBSERVED_AT_FETCH', value: row.value,
      })));
    }),
    officialPitDecisionEvents: vi.fn(async (_db: unknown, releaseResolutionAt: string) => {
      state.eventResolutionAts.push(releaseResolutionAt);
      return (state.seriesMap.WALCL ?? []).map(row => ({
        modelDate: row.date, decisionAt: `${row.date}T00:00:00Z`, tradableAt: `${row.date}T14:30:00Z`,
      }));
    }),
    upsertOfficialSnapshot: vi.fn(async (
      _db: unknown, _runId: string, snapshot: Snapshot, _spx: number,
      provenance: { releaseResolutionAt?: string },
    ) => {
      if (provenance?.releaseResolutionAt) state.snapshotResolutionAts.push(provenance.releaseResolutionAt);
      state.events.push(`official:${snapshot.date}`);
    }),
    upsertNowcastSnapshot: vi.fn(async (
      _db: unknown, _runId: string, snapshot: Snapshot, _spx: number,
      provenance: { releaseResolutionAt?: string },
    ) => {
      if (provenance?.releaseResolutionAt) state.snapshotResolutionAts.push(provenance.releaseResolutionAt);
      state.events.push(`nowcast:${snapshot.date}`);
      if (state.snapshotWriteFailure) throw new Error('snapshot write failed');
    }),
    completeIngestSuccess: vi.fn(async (
      _db: unknown,
      _runId: string,
      count: number,
      completedAt: string,
      meta: Array<[string, string]>,
    ) => {
      if (meta.some(([key]) => key === state.metaFailureKey)) {
        throw new Error(`meta failed: ${state.metaFailureKey}`);
      }
      state.successPublications.push({ count, completedAt, meta });
      state.events.push(`snapshots-succeeded:${count}:${completedAt}`);
    }),
    failIngestSnapshots: vi.fn(async (
      _db: unknown,
      _runId: string,
      failure: { step: string; error: string; snapshotCount: number },
      completedAt: string,
    ) => {
      state.snapshotFailures.push({ ...failure, completedAt });
      state.events.push(`snapshots-failed:${failure.step}`);
    }),
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
import { failIngestRun, failIngestSnapshots, failSeriesAttempt } from '../src/db';
import { fetchDxyDaily } from '../src/prices';

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
  state.invalidSeries = null;
  state.stagingFailureSeries = null;
  state.semanticValidationFailureSeries = null;
  state.attemptAuditFailure = false;
  state.activationFailure = false;
  state.lockAcquired = true;
  state.leaseRenewed = true;
  state.leaseFailureAfterEvent = null;
  state.snapshotWriteFailure = false;
  state.metaFailureKey = null;
  state.seriesReadFailureSeries = null;
  state.maxPitVintage = '2024-01-03';
  state.maxObsDate = '2024-01-02';
  state.activeSeries = new Set(SERIES_IDS);
  state.staged = [];
  state.pitStaged = [];
  state.fetchArgs = [];
  state.fetchObservedAts = [];
  state.rowResolutionAts = [];
  state.eventResolutionAts = [];
  state.snapshotResolutionAts = [];
  state.attemptFailures = [];
  state.snapshotFailures = [];
  state.successPublications = [];
  state.activationCompletedAt = null;
  state.runFailureCompletedAt = null;
  state.events = [];
  state.failed = [];
});

describe('atomic ingest orchestration', () => {
  it('records a middle-series fetch failure without activation or snapshot writes', async () => {
    state.fetchFailureSeries = SERIES_IDS[1];

    await expect(runIngest(env, false, new Date('2024-01-10T12:00:00Z'))).rejects.toThrow(SERIES_IDS[1]);

    expect(state.events).toContain('create');
    expect(state.events.findIndex(event => event.startsWith(`attempt-start:${SERIES_IDS[1]}:`)))
      .toBeLessThan(state.events.indexOf(`fetch:${SERIES_IDS[1]}`));
    expect(failSeriesAttempt).toHaveBeenCalled();
    expect(state.attemptFailures).toEqual([
      expect.objectContaining({ seriesId: SERIES_IDS[1], error: `fetch failed: ${SERIES_IDS[1]}` }),
    ]);
    expect(state.attemptFailures[0].completedAt).not.toBe('2024-01-10T12:00:00.000Z');
    expect(failIngestRun).toHaveBeenCalled();
    expect(state.failed).toEqual([expect.objectContaining({ step: 'fetch', seriesId: SERIES_IDS[1] })]);
    expect(state.runFailureCompletedAt).not.toBe('2024-01-10T12:00:00.000Z');
    expect(state.events).not.toContain('activate');
    expect(state.events.some(event => event.startsWith('official:') || event.startsWith('nowcast:'))).toBe(false);
    expect(state.events).not.toContain('load-active');
    expect(state.events.at(-1)).toBe('release');
  });

  it('starts and fails the series attempt when the production series read fails', async () => {
    state.seriesReadFailureSeries = SERIES_IDS[0];

    await expect(runIngest(env, false, new Date('2024-01-10T12:00:00Z')))
      .rejects.toThrow(`series read failed: ${SERIES_IDS[0]}`);

    expect(state.events.indexOf(`max-pit:${SERIES_IDS[0]}`)).toBeGreaterThan(
      state.events.findIndex(event => event.startsWith(`attempt-start:${SERIES_IDS[0]}:`)),
    );
    expect(state.attemptFailures).toEqual([
      expect.objectContaining({ seriesId: SERIES_IDS[0], error: `series read failed: ${SERIES_IDS[0]}` }),
    ]);
    expect(state.failed).toEqual([
      expect.objectContaining({ step: 'series-read', seriesId: SERIES_IDS[0] }),
    ]);
  });

  it.each([
    ['structural validation', () => { state.invalidSeries = SERIES_IDS[0]; }, 'structural'],
    ['staging', () => { state.stagingFailureSeries = SERIES_IDS[0]; }, 'staging'],
  ])('closes the series attempt as FAILED when %s fails', async (_label, arrange, failedStep) => {
    arrange();

    await expect(runIngest(env, false, new Date('2024-01-10T12:00:00Z'))).rejects.toThrow();

    expect(state.attemptFailures).toEqual([
      expect.objectContaining({ seriesId: SERIES_IDS[0], error: expect.any(String), completedAt: expect.any(String) }),
    ]);
    expect(state.failed).toEqual([expect.objectContaining({ step: failedStep, seriesId: SERIES_IDS[0] })]);
  });

  it('preserves the fetch exception when the FAILED-attempt audit write also fails', async () => {
    state.fetchFailureSeries = SERIES_IDS[0];
    state.attemptAuditFailure = true;

    await expect(runIngest(env, false, new Date('2024-01-10T12:00:00Z')))
      .rejects.toThrow(`fetch failed: ${SERIES_IDS[0]}`);
  });

  it('invalidates a SUCCEEDED zero-row attempt and records its series when semantic validation fails', async () => {
    state.semanticValidationFailureSeries = 'WALCL';
    state.activeSeries.delete('WALCL');

    await expect(runIngest(env, false, new Date('2024-01-10T12:00:00Z')))
      .rejects.toThrow('WALCL returned empty without active production history');

    expect(state.staged).toContainEqual({ seriesId: 'WALCL', rows: [] });
    expect(state.attemptFailures).toEqual([
      expect.objectContaining({
        seriesId: 'WALCL',
        error: 'WALCL returned empty without active production history',
        completedAt: expect.any(String),
      }),
    ]);
    expect(state.failed).toEqual([
      expect.objectContaining({ step: 'validation', seriesId: 'WALCL' }),
    ]);
  });

  it('preserves the semantic validation error when invalidating the attempt fails', async () => {
    state.semanticValidationFailureSeries = 'WALCL';
    state.attemptAuditFailure = true;

    await expect(runIngest(env, false, new Date('2024-01-10T12:00:00Z')))
      .rejects.toThrow('WALCL returned empty without active production history');
    expect(state.failed).toEqual([
      expect.objectContaining({ step: 'validation', seriesId: 'WALCL' }),
    ]);
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

    expect(fetchDxyDaily).toHaveBeenCalledWith({ fredApiKey: 'test' });
    expect(state.staged.map(item => item.seriesId)).toEqual(SERIES_IDS);
    expect(state.events.filter(event => event === 'activate')).toHaveLength(1);
    expect(state.events.indexOf('activate')).toBeLessThan(state.events.indexOf('load-active'));
    expect(state.events.some(event => event.startsWith('nowcast:'))).toBe(true);
    expect(state.events.some(event => event.startsWith('snapshots-succeeded:'))).toBe(true);
    expect(state.activationCompletedAt).not.toBe('2024-01-10T12:00:00.000Z');
    expect(result).toEqual(expect.objectContaining({ status: 'active', runId: expect.any(String) }));
  });

  it('freezes one post-fetch resolution cutoff and uses it for rows, events, and snapshots', async () => {
    let clockCalls = 0;
    const clock = () => ++clockCalls <= SERIES_IDS.length
      ? '2024-01-10T12:00:00.500Z'
      : '2024-01-10T12:00:00.900Z';

    await runIngest(env, true, new Date('2024-01-10T12:00:00Z'), clock);

    expect(state.fetchObservedAts).toEqual(
      Array.from({ length: SERIES_IDS.length }, () => '2024-01-10T12:00:00.500Z'),
    );
    expect(state.rowResolutionAts).toEqual(['2024-01-10T12:00:00.900Z']);
    expect(state.eventResolutionAts).toEqual(['2024-01-10T12:00:00.900Z']);
    expect(new Set(state.snapshotResolutionAts)).toEqual(new Set(['2024-01-10T12:00:00.900Z']));
  });

  it('starts each attempt before PIT metadata reads and uses an inclusive incremental checkpoint', async () => {
    await runIngest(env, false, new Date('2024-01-10T12:00:00Z'));
    expect(state.events.findIndex(event => event.startsWith(`attempt-start:${SERIES_IDS[0]}:`)))
      .toBeLessThan(state.events.indexOf(`max-pit:${SERIES_IDS[0]}`));
    expect(state.fetchArgs[0]).toEqual({
      seriesId: SERIES_IDS[0],
      observationStart: env.START_DATE,
      realtimeStart: '2024-01-03',
      resolveFirstVintage: false,
      currentOnly: false,
    });
    expect(state.events.indexOf('stage-pit')).toBeLessThan(
      state.events.findIndex(event => event.startsWith(`stage:${SERIES_IDS[0]}:`)),
    );
  });

  it('resolves the first ALFRED vintage only when no PIT checkpoint exists', async () => {
    state.maxPitVintage = null;

    await runIngest(env, false, new Date('2024-01-10T12:00:00Z'));

    expect(state.fetchArgs
      .filter(call => call.seriesId !== 'SP500')
      .every(call => call.resolveFirstVintage)).toBe(true);
  });

  it('uses the active observation checkpoint for current-only SP500', async () => {
    await runIngest(env, false, new Date('2024-01-10T12:00:00Z'));

    expect(state.fetchArgs.find(call => call.seriesId === 'SP500')).toEqual({
      seriesId: 'SP500',
      observationStart: '2024-01-02',
      realtimeStart: env.START_DATE,
      resolveFirstVintage: false,
      currentOnly: true,
    });
    expect(state.events).toContain('max-obs:SP500');
  });

  it('uses START_DATE as the full rebuild vintage checkpoint', async () => {
    await runIngest(env, true, new Date('2024-01-10T12:00:00Z'));
    expect(state.fetchArgs.every(call => call.realtimeStart === env.START_DATE)).toBe(true);
  });

  it('publishes success metadata and SUCCEEDED outcome through one terminal database operation', async () => {
    await runIngest(env, false, new Date('2024-01-10T12:00:00Z'));

    expect(state.successPublications).toEqual([
      expect.objectContaining({
        count: expect.any(Number),
        completedAt: expect.any(String),
        meta: expect.arrayContaining([
          ['last_status', 'ok'],
          ['last_error', ''],
        ]),
      }),
    ]);
  });

  it('renews ownership after active reads and DXY fetch, before every snapshot write and finalization', async () => {
    await runIngest(env, false, new Date('2024-01-10T12:00:00Z'));

    const load = state.events.indexOf('load-active');
    const dxy = state.events.indexOf('fetch-dxy');
    expect(state.events[load + 1]).toBe('renew');
    expect(state.events[dxy + 1]).toBe('renew');
    for (const [index, event] of state.events.entries()) {
      if (event.startsWith('nowcast:') || event.startsWith('official:') || event.startsWith('snapshots-succeeded:')) {
        expect(state.events[index - 1]).toBe('renew');
      }
      if (event.startsWith('meta:last_')) expect(state.events[index - 1]).toBe('renew');
    }
  });

  it('stops snapshot writes and records FAILED when ownership is lost after the DXY fetch', async () => {
    state.leaseFailureAfterEvent = 'fetch-dxy';

    await expect(runIngest(env, false, new Date('2024-01-10T12:00:00Z'))).rejects.toThrow(/lease.*lost/i);

    expect(state.events.some(event => event.startsWith('nowcast:') || event.startsWith('official:'))).toBe(false);
    expect(failIngestSnapshots).toHaveBeenCalled();
    expect(state.snapshotFailures).toEqual([expect.objectContaining({ step: 'lock' })]);
  });

  it.each([
    ['snapshot write', () => { state.snapshotWriteFailure = true; }, 'snapshot'],
    ['success publication', () => { state.metaFailureKey = 'last_ingest_at'; }, 'snapshot-finalization'],
  ])('records the ACTIVE run snapshot outcome FAILED after a %s failure', async (_label, arrange, failedStep) => {
    arrange();

    await expect(runIngest(env, false, new Date('2024-01-10T12:00:00Z'))).rejects.toThrow();

    expect(failIngestRun).not.toHaveBeenCalled();
    expect(state.snapshotFailures).toEqual([expect.objectContaining({ step: failedStep })]);
  });

  it('records a successful zero-row current series attempt', async () => {
    await runIngest(env, false, new Date('2024-01-10T12:00:00Z'));

    expect(state.staged).toContainEqual({ seriesId: 'WALCL', rows: [] });
    expect(state.events.some(event => event.startsWith('stage:WALCL:0:'))).toBe(true);
    expect(state.events).toContain('validate');
  });

  it('renews the owned lease while progressing and aborts if ownership is lost', async () => {
    state.leaseFailureAfterEvent = `fetch:${SERIES_IDS[0]}`;

    await expect(runIngest(env, false, new Date('2024-01-10T12:00:00Z'))).rejects.toThrow(/lease.*lost/i);

    expect(state.events).toContain('renew');
    expect(state.failed).toEqual([expect.objectContaining({ step: 'lock' })]);
    expect(state.events).not.toContain('activate');
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
