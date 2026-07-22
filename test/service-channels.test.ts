import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SeriesMap, Snapshot, Verdict } from '../src/metrics';
import { SERIES_IDS } from '../src/config';

const state = vi.hoisted(() => ({
  seriesMap: {} as SeriesMap,
  official: new Map<string, Snapshot>(),
  nowcasts: new Map<string, Snapshot>(),
  officialWrites: [] as string[],
  nowcastWrites: [] as string[],
  priorVerdict: 'BULLISH' as Verdict | null,
  frozenAnchors: new Map<string, Verdict>(),
  pitRowsOverride: null as any[] | null,
  computedWalcl: new Map<string, number | null>(),
}));

vi.mock('../src/fred', () => ({ fetchFredSeriesPit: vi.fn(async () => ({ latestRows: [], vintages: [] })) }));
vi.mock('../src/prices', () => ({
  fetchDxyDaily: vi.fn(async () => []),
  spliceSeries: vi.fn((official: unknown[]) => official),
}));
vi.mock('../src/db', () => ({
  acquireIngestLock: vi.fn(async () => true),
  renewIngestLock: vi.fn(async () => true),
  releaseIngestLock: vi.fn(async () => true),
  createIngestRun: vi.fn(async () => undefined),
  startSeriesAttempt: vi.fn(async () => undefined),
  stageSeriesAttempt: vi.fn(async () => undefined),
  failSeriesAttempt: vi.fn(async () => undefined),
  validateSeriesRows: vi.fn(() => undefined),
  validateIngestRun: vi.fn(async () => undefined),
  activateIngestRun: vi.fn(async () => undefined),
  failIngestRun: vi.fn(async () => undefined),
  completeIngestSuccess: vi.fn(async () => undefined),
  failIngestSnapshots: vi.fn(async () => undefined),
  decisionWeek: (date: string) => {
    const d = new Date(`${date}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
    return d.toISOString().slice(0, 10);
  },
  maxObsDate: vi.fn(async () => '2024-01-10'),
  maxPitVintageDate: vi.fn(async () => '2024-01-10'),
  loadReleaseRules: vi.fn(async () => new Map(SERIES_IDS.map(id => [id, { expectedReleaseTime: '23:59:59' }]))),
  loadReleaseOverrides: vi.fn(async () => new Map()),
  stagePitObservations: vi.fn(async () => undefined),
  loadPitObservations: vi.fn(async () => state.pitRowsOverride ?? Object.entries(state.seriesMap).flatMap(([seriesId, rows]) => rows.map(row => ({
    seriesId, observationDate: row.date, vintageDate: row.date, releasedAt: `${row.date}T00:00:00Z`,
    fetchedAt: `${row.date}T00:00:00Z`, tradableAt: `${row.date}T14:30:00Z`, source: 'ALFRED',
    checksum: `${seriesId}-${row.date}`, releaseTimeStatus: 'OBSERVED_AT_FETCH', value: row.value,
  })))),
  officialPitDecisionEvents: vi.fn(async () => (state.seriesMap.WALCL ?? []).map(row => ({
    modelDate: row.date, decisionAt: `${row.date}T00:00:00Z`, tradableAt: `${row.date}T14:30:00Z`,
  }))),
  upsertOfficialSnapshot: vi.fn(async (_db: unknown, _runId: string, snapshot: Snapshot) => {
    state.officialWrites.push(snapshot.date);
    if (state.frozenAnchors.has(snapshot.date)) return 'FROZEN';
    state.official.set(snapshot.date, structuredClone(snapshot));
    return 'INSERTED';
  }),
  upsertNowcastSnapshot: vi.fn(async (_db: unknown, _runId: string, snapshot: Snapshot) => {
    state.nowcastWrites.push(snapshot.date);
    state.nowcasts.set(snapshot.date, structuredClone(snapshot));
  }),
  setIngestMeta: vi.fn(async () => undefined),
  getAllMeta: vi.fn(async () => ({})),
  officialSnapshotBefore: vi.fn(async () => ({ verdict: state.priorVerdict })),
  officialVerdictAnchors: vi.fn(async (_db: unknown, from: string, to: string) => [...state.frozenAnchors]
    .filter(([date]) => date >= from && date <= to).map(([date, verdict]) => ({ date, verdict }))),
}));
vi.mock('../src/metrics', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/metrics')>();
  return {
    ...actual,
    computeSnapshot: vi.fn((_map: SeriesMap, date: string, prev?: Verdict): Snapshot => {
      state.computedWalcl.set(date, actual.asOf(_map.WALCL ?? [], date));
      return ({
      date, walcl: 6000, tga: 700, rrp: 100, repo: 0, netliq: 5200, netliqTrend: 5200,
      sofrIorb: 0, hyOas: 3, dgs10: 4, dxy: 100, vix: 15, bsImpulse: 'FLAT', netliqDir: 'FLAT',
      verdict: actual.verdictFromScore(50, prev), score: 50, factors: {}, factorResults: {}, freshness: {},
      decisionStatus: 'OK', p0: true, p1: true, p2: true, p3: true, reason: 'dead zone', coverage: 1,
      } as any);
    }),
  };
});

import { runIngest } from '../src/service';

const env = {
  DB: {} as D1Database, ASSETS: {} as Fetcher,
  FRED_API_KEY: 'test', ADMIN_TOKEN: 'test', START_DATE: '2024-01-01',
};

beforeEach(() => {
  vi.clearAllMocks();
  state.seriesMap = {
    WALCL: [
      { date: '2024-01-03', value: 6000 },
      { date: '2024-01-05', value: 6001 },
      { date: '2024-01-10', value: 6002 },
    ],
    SP500: [],
    DTWEXBGS: [],
  };
  state.official.clear();
  state.nowcasts.clear();
  state.officialWrites.length = 0;
  state.nowcastWrites.length = 0;
  state.priorVerdict = 'BULLISH';
  state.frozenAnchors.clear();
  state.pitRowsOverride = null;
  state.computedWalcl.clear();
});

describe('runIngest snapshot channel routing', () => {
  it('writes full rebuild output only to official storage with at most one decision per week', async () => {
    await runIngest(env, true, new Date('2024-01-10T12:00:00.000Z'));

    expect(state.nowcastWrites).toEqual([]);
    expect(state.officialWrites).toEqual(['2024-01-05', '2024-01-10']);
  });

  it('writes incremental output only to provisional nowcast storage', async () => {
    await runIngest(env, false, new Date('2024-01-10T12:00:00.000Z'));

    expect(state.officialWrites).toEqual([]);
    expect(state.nowcastWrites.at(-1)).toBe('2024-01-10');
  });

  it('initializes nowcasts from the prior official verdict without mutating official history', async () => {
    const official = { date: '2023-12-27', verdict: 'BULLISH' } as Snapshot;
    state.official.set(official.date, official);

    await runIngest(env, false, new Date('2024-01-10T12:00:00.000Z'));

    expect(state.official).toEqual(new Map([[official.date, official]]));
    expect(state.nowcasts.get('2024-01-10')?.verdict).toBe('BULLISH');
  });

  it('carries a frozen official verdict into the next full-rebuild frame', async () => {
    state.frozenAnchors.set('2024-01-05', 'BEARISH');
    await runIngest(env, true, new Date('2024-01-10T12:00:00.000Z'));
    expect(state.official.get('2024-01-10')?.verdict).toBe('BEARISH');
  });

  it('resolves each incremental date at its own cutoff so later revisions cannot alter earlier frames', async () => {
    const base = {
      seriesId: 'WALCL', observationDate: '2024-01-03', fetchedAt: '2024-01-10T12:00:00Z',
      source: 'ALFRED', releaseTimeStatus: 'CONSERVATIVE_DATE_END',
      tradableAt: '2024-01-05T14:30:00Z',
    };
    state.pitRowsOverride = [
      { ...base, vintageDate: '2024-01-04', releasedAt: '2024-01-04T23:59:59Z', checksum: 'a', value: 5800 },
      { ...base, vintageDate: '2024-01-08', releasedAt: '2024-01-08T23:59:59Z', checksum: 'b', value: 5900 },
    ];
    await runIngest(env, false, new Date('2024-01-10T12:00:00.000Z'));
    expect(state.computedWalcl.get('2024-01-05')).toBe(5800);
    expect(state.computedWalcl.get('2024-01-09')).toBe(5900);
  });
});
