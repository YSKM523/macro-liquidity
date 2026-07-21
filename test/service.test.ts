import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SeriesMap, Snapshot, Verdict } from '../src/metrics';

const state = vi.hoisted(() => ({
  seriesMap: {} as SeriesMap,
  snapshots: new Map<string, any>(),
  nowcasts: new Map<string, any>(),
  incompleteDates: new Set<string>(),
}));

vi.mock('../src/fred', () => ({
  fetchFredSeries: vi.fn(async () => []),
}));

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
  maxObsDate: vi.fn(async () => '2024-05-29'),
  upsertObservations: vi.fn(async () => undefined),
  loadSeriesMap: vi.fn(async () => state.seriesMap),
  upsertOfficialSnapshot: vi.fn(async (_db: unknown, snapshot: Snapshot) => {
    state.snapshots.set(snapshot.date, structuredClone(snapshot));
  }),
  upsertNowcastSnapshot: vi.fn(async (_db: unknown, snapshot: Snapshot) => {
    state.nowcasts.set(snapshot.date, structuredClone(snapshot));
  }),
  setMeta: vi.fn(async () => undefined),
  getAllMeta: vi.fn(async () => ({})),
  officialSnapshotBefore: vi.fn(async (_db: unknown, date: string) => {
    const priorDate = [...state.snapshots.keys()]
      .filter(candidate => candidate < date)
      .sort()
      .at(-1);
    return priorDate ? state.snapshots.get(priorDate) : null;
  }),
}));

vi.mock('../src/metrics', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/metrics')>();
  return {
    ...actual,
    computeSnapshot: vi.fn((_map: SeriesMap, date: string, prev?: Verdict): Snapshot => {
      // One breakout establishes BULLISH; every later official and nowcast date
      // is in the 45-55 dead zone and must inherit that state.
      const score = date === '2024-01-03' ? 60 : 50;
      const incomplete = state.incompleteDates.has(date);
      const verdict = incomplete ? null : actual.verdictFromScore(score, prev);
      const factors = {
        netliqTrend: 50, impulse: 50, credit: 50, funding: 50, rates: 50,
        dollar: 50, vol: 50, reserveAdequacy: 50, curve: 50,
      };
      return {
        date,
        walcl: 6000,
        tga: 700,
        rrp: 100,
        repo: 0,
        netliq: 5200,
        netliqTrend: 5200,
        sofrIorb: 0,
        hyOas: 3,
        dgs10: 4,
        dxy: 100,
        vix: 15,
        bsImpulse: 'FLAT',
        netliqDir: 'FLAT',
        verdict,
        score: incomplete ? null : score,
        factors,
        p0: true,
        p1: true,
        p2: true,
        p3: true,
        reason: incomplete ? '宏观数据不完整' : `dead-zone inherits ${verdict}`,
        coverage: 1,
        decisionStatus: incomplete ? 'DATA_INCOMPLETE' : 'OK',
        factorResults: {},
        freshness: {},
      } as any;
    }),
  };
});

import { runIngest } from '../src/service';

const weeklyDates = Array.from({ length: 22 }, (_, index) => {
  const date = new Date(Date.UTC(2024, 0, 3 + index * 7));
  return date.toISOString().slice(0, 10);
});

const makeSeriesMap = (): SeriesMap => ({
  WALCL: weeklyDates.map((date, index) => ({ date, value: 6000 + index })),
  SP500: weeklyDates.map((date, index) => ({ date, value: 4800 + index })),
  DTWEXBGS: [],
});

const makeSnapshot = (date: string, verdict: Verdict): Snapshot => ({
  date,
  walcl: 6000,
  tga: 700,
  rrp: 100,
  repo: 0,
  netliq: 5200,
  netliqTrend: 5200,
  sofrIorb: 0,
  hyOas: 3,
  dgs10: 4,
  dxy: 100,
  vix: 15,
  bsImpulse: 'FLAT',
  netliqDir: 'FLAT',
  verdict,
  score: 50,
  factors: {
    netliqTrend: 50, impulse: 50, credit: 50, funding: 50, rates: 50,
    dollar: 50, vol: 50, reserveAdequacy: 50, curve: 50,
  },
  factorResults: {} as Snapshot['factorResults'],
  freshness: {},
  decisionStatus: 'OK',
  p0: true,
  p1: true,
  p2: true,
  p3: true,
  reason: `dead-zone inherits ${verdict}`,
  coverage: 1,
});

const env = {
  DB: {} as D1Database,
  ASSETS: {} as Fetcher,
  FRED_API_KEY: 'test',
  ADMIN_TOKEN: 'test',
  START_DATE: '2024-01-03',
};

beforeEach(() => {
  vi.clearAllMocks();
  state.seriesMap = makeSeriesMap();
  state.snapshots.clear();
  state.nowcasts.clear();
  state.incompleteDates.clear();
});

describe('runIngest hysteresis continuity', () => {
  it('inherits the verdict immediately before an incremental rebuild window', async () => {
    state.snapshots.set('2024-05-08', makeSnapshot('2024-05-08', 'BULLISH'));

    await runIngest(env, false, new Date('2024-05-29T12:00:00.000Z'));

    expect(state.nowcasts.get('2024-05-15')?.verdict).toBe('BULLISH');
    expect(state.nowcasts.get('2024-05-29')?.verdict).toBe('BULLISH');
  });

  it('calculates same-date incremental nowcasts consistently with a full official rebuild', async () => {
    await runIngest(env, true);
    const fields = ['score', 'verdict', 'netliqDir', 'bsImpulse', 'factors', 'reason'] as const;
    const official = new Map(
      ['2024-05-15', '2024-05-22', '2024-05-29'].map(date => [
        date,
        Object.fromEntries(fields.map(field => [field, state.snapshots.get(date)?.[field]])),
      ]),
    );

    await runIngest(env, false, new Date('2024-05-29T12:00:00.000Z'));

    for (const [date, expected] of official) {
      const actual = state.nowcasts.get(date);
      expect(Object.fromEntries(fields.map(field => [field, actual?.[field]]))).toEqual(expected);
    }
  });

  it('preserves the prior official verdict across DATA_INCOMPLETE dates', async () => {
    state.incompleteDates.add('2024-01-10');

    await runIngest(env, true);

    expect(state.snapshots.get('2024-01-03')?.verdict).toBe('BULLISH');
    expect(state.snapshots.get('2024-01-10')?.verdict).toBeNull();
    expect(state.snapshots.get('2024-01-17')?.verdict).toBe('BULLISH');
  });
});
