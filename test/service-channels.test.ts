import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SeriesMap, Snapshot, Verdict } from '../src/metrics';

const state = vi.hoisted(() => ({
  seriesMap: {} as SeriesMap,
  official: new Map<string, Snapshot>(),
  nowcasts: new Map<string, Snapshot>(),
  officialWrites: [] as string[],
  nowcastWrites: [] as string[],
  priorVerdict: 'BULLISH' as Verdict | null,
}));

vi.mock('../src/fred', () => ({ fetchFredSeries: vi.fn(async () => []) }));
vi.mock('../src/prices', () => ({
  fetchDxyDaily: vi.fn(async () => []),
  spliceSeries: vi.fn((official: unknown[]) => official),
}));
vi.mock('../src/db', () => ({
  decisionWeek: (date: string) => {
    const d = new Date(`${date}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
    return d.toISOString().slice(0, 10);
  },
  maxObsDate: vi.fn(async () => '2024-01-10'),
  upsertObservations: vi.fn(async () => undefined),
  loadSeriesMap: vi.fn(async () => state.seriesMap),
  upsertOfficialSnapshot: vi.fn(async (_db: unknown, snapshot: Snapshot) => {
    state.officialWrites.push(snapshot.date);
    state.official.set(snapshot.date, structuredClone(snapshot));
  }),
  upsertNowcastSnapshot: vi.fn(async (_db: unknown, snapshot: Snapshot) => {
    state.nowcastWrites.push(snapshot.date);
    state.nowcasts.set(snapshot.date, structuredClone(snapshot));
  }),
  setMeta: vi.fn(async () => undefined),
  getAllMeta: vi.fn(async () => ({})),
  officialSnapshotBefore: vi.fn(async () => ({ verdict: state.priorVerdict })),
}));
vi.mock('../src/metrics', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/metrics')>();
  return {
    ...actual,
    computeSnapshot: vi.fn((_map: SeriesMap, date: string, prev?: Verdict): Snapshot => ({
      date, walcl: 6000, tga: 700, rrp: 100, repo: 0, netliq: 5200, netliqTrend: 5200,
      sofrIorb: 0, hyOas: 3, dgs10: 4, dxy: 100, vix: 15, bsImpulse: 'FLAT', netliqDir: 'FLAT',
      verdict: actual.verdictFromScore(50, prev), score: 50, factors: {}, factorResults: {}, freshness: {},
      decisionStatus: 'OK', p0: true, p1: true, p2: true, p3: true, reason: 'dead zone', coverage: 1,
    } as any)),
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
});
