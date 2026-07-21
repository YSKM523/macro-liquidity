import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const dbState = vi.hoisted(() => ({
  row: {
    date: '2026-07-15',
    score: 60,
    verdict: 'BULLISH',
    netliq_dir: 'UP',
    qe_qt_regime: 'FLAT',
    reason: 'macro remains bullish',
    coverage: 1,
  },
}));

vi.mock('../src/service', () => ({
  runIngest: vi.fn(),
  scheduledIngest: vi.fn(),
}));

vi.mock('../src/db', () => ({
  latestSnapshot: vi.fn(async () => dbState.row),
  getAllMeta: vi.fn(async () => ({})),
  countSnapshots: vi.fn(async () => 1),
  snapshotHistory: vi.fn(async () => []),
  loadBacktestRows: vi.fn(async () => []),
  snapshotOnOrBefore: vi.fn(async () => null),
  loadSeriesMap: vi.fn(async () => ({})),
}));

import worker from '../src/worker';

const env = {
  DB: {} as D1Database,
  ASSETS: { fetch: vi.fn() } as unknown as Fetcher,
  FRED_API_KEY: 'test',
  ADMIN_TOKEN: 'test',
  START_DATE: '2024-01-01',
};

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 503 })));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('/api/snapshot live stress status', () => {
  it('returns UNKNOWN and blocks risk increases when every live source fails', async () => {
    const response = await worker.fetch(new Request('https://example.test/api/snapshot'), env);
    const body = await response.json() as any;

    expect(response.status).toBe(200);
    expect(body.snapshot.score).toBe(60);
    expect(body.snapshot.verdict).toBe('BULLISH');
    expect(body.snapshot.live_stress.status).toBe('UNKNOWN');
    expect(body.snapshot.display_verdict).toBe('UNKNOWN');
    expect(body.snapshot.guidance.tierLabel).toBe('实时风险层不可用');
    expect(body.snapshot.guidance.exposure).not.toContain('+15~20pp');
    expect(body.snapshot.guidance.triggers[1].detail).not.toContain('当前未触发');
  });
});
