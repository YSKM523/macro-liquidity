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
    decision_status: 'OK',
    factor_quality_json: '{"funding":{"score":80,"quality":1,"status":"OK","asOf":"2026-07-15","components":{}}}',
    freshness_json: '{"SOFR":{"value":4.3,"observationDate":"2026-07-15","ageDays":0,"status":"FRESH"}}',
  } as any,
  reference: null as any,
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
  snapshotOnOrBefore: vi.fn(async () => dbState.reference),
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
  dbState.row = {
    date: '2026-07-15', score: 60, verdict: 'BULLISH', netliq_dir: 'UP', qe_qt_regime: 'FLAT',
    reason: 'macro remains bullish', coverage: 1, decision_status: 'OK',
    factor_quality_json: '{"funding":{"score":80,"quality":1,"status":"OK","asOf":"2026-07-15","components":{}}}',
    freshness_json: '{"SOFR":{"value":4.3,"observationDate":"2026-07-15","ageDays":0,"status":"FRESH"}}',
  };
  dbState.reference = null;
  vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 503 })));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('/api/snapshot persisted macro quality', () => {
  it('fails closed for DATA_INCOMPLETE and exposes persisted quality dates without inventing current as-of values', async () => {
    dbState.row = {
      ...dbState.row,
      score: null,
      verdict: null,
      decision_status: 'DATA_INCOMPLETE',
      factor_quality_json: '{"netliqTrend":{"score":null,"quality":0,"status":"STALE","asOf":"2026-07-01","components":{}}}',
      freshness_json: '{"WDTGAL":{"value":null,"observationDate":"2026-07-01","ageDays":14,"status":"STALE"}}',
    };

    const response = await worker.fetch(new Request('https://example.test/api/snapshot'), env);
    const body = await response.json() as any;

    expect(body.snapshot.decision_status).toBe('DATA_INCOMPLETE');
    expect(body.snapshot.score).toBeNull();
    expect(body.snapshot.verdict).toBeNull();
    expect(body.snapshot.display_verdict).toBe('UNKNOWN');
    expect(body.snapshot.reason).toContain('宏观数据不完整');
    expect(body.snapshot.guidance.tone).toBe('unknown');
    expect(body.snapshot.guidance.exposure).not.toMatch(/加仓|\+/);
    expect(JSON.stringify(body.snapshot.guidance)).not.toContain('未触发');
    expect(body.snapshot.factor_quality.netliqTrend.asOf).toBe('2026-07-01');
    expect(body.snapshot.freshness.WDTGAL.observationDate).toBe('2026-07-01');
    expect(body.snapshot.policy_regime).toBeNull();
  });

  it('does not use an incomplete reference returned by the explain lookup', async () => {
    dbState.row = {
      ...dbState.row,
      factors_json: '{"netliqTrend":80}',
      walcl: 6000, tga: 700, rrp: 100, netliq: 5200,
    };
    dbState.reference = {
      date: '2026-07-01', score: 20, decision_status: 'DATA_INCOMPLETE',
      factors_json: '{"netliqTrend":20}', walcl: 5900, tga: 700, rrp: 100, netliq: 5100,
    };

    const response = await worker.fetch(new Request('https://example.test/api/explain'), env);
    const body = await response.json() as any;

    expect(body.reference).toBeNull();
    expect(body.deltaScore).toBeNull();
    expect(body.attribution).toBeNull();
    expect(body.netliq.reference).toBeNull();
  });

  it('does not invent neutral factor attribution for an incomplete latest snapshot', async () => {
    dbState.row = {
      ...dbState.row,
      score: null,
      verdict: null,
      decision_status: 'DATA_INCOMPLETE',
      factors_json: '{}',
    };

    const response = await worker.fetch(new Request('https://example.test/api/explain'), env);
    const body = await response.json() as any;

    expect(body.error).toBe('data_incomplete');
    expect(body.message).toContain('宏观数据不完整');
    expect(body.contributions).toBeUndefined();
  });

  it('treats legacy rows without quality columns conservatively', async () => {
    dbState.row = {
      date: '2024-01-01', score: 60, verdict: 'BULLISH', netliq_dir: 'UP', qe_qt_regime: 'FLAT',
      reason: 'legacy', coverage: 1,
    } as any;

    const response = await worker.fetch(new Request('https://example.test/api/snapshot'), env);
    const body = await response.json() as any;

    expect(body.snapshot.decision_status).toBe('DATA_INCOMPLETE');
    expect(body.snapshot.display_verdict).toBe('UNKNOWN');
    expect(body.snapshot.factor_quality).toEqual({});
    expect(body.snapshot.freshness).toEqual({});
  });
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
