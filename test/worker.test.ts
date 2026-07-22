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
    data_run_id: 'pit-run', data_cutoff: '2026-07-15T23:59:59Z',
    decision_at: '2026-07-16T00:00:00Z', tradable_at: '2026-07-16T14:30:00Z', pit_status: 'PIT',
  } as any,
  nowcast: {
    date: '2026-07-21', score: 61, verdict: 'BULLISH', netliq_dir: 'UP', qe_qt_regime: 'FLAT',
    reason: 'provisional macro estimate', coverage: 1, decision_status: 'OK', channel_status: 'PROVISIONAL',
    factor_quality_json: '{}', freshness_json: '{}',
  } as any,
  reference: null as any,
  meta: {} as Record<string, string>,
  activeSnapshotState: 'FAILED' as 'PENDING' | 'SUCCEEDED' | 'FAILED',
}));

vi.mock('../src/service', () => ({
  runIngest: vi.fn(),
  scheduledIngest: vi.fn(),
}));

vi.mock('../src/db', () => ({
  latestOfficialSnapshot: vi.fn(async () => dbState.row),
  latestNowcastSnapshot: vi.fn(async () => dbState.nowcast),
  getAllMeta: vi.fn(async () => dbState.meta),
  countOfficialSnapshots: vi.fn(async () => 1),
  officialSnapshotHistory: vi.fn(async () => []),
  loadBacktestRows: vi.fn(async () => []),
  officialSnapshotOnOrBefore: vi.fn(async () => dbState.reference),
  loadSeriesMap: vi.fn(async () => ({})),
  ingestRunSummary: vi.fn(async () => ({
    active: {
      run_id: 'active-1', state: 'ACTIVE', row_count: 20, series_count: 18,
      snapshot_state: dbState.activeSnapshotState, snapshot_error: 'snapshot write failed', snapshot_count: 2,
    },
    latestFailed: {
      run_id: 'failed-1', state: 'FAILED', failed_step: 'fetch', failed_series: 'SOFR',
      snapshot_state: 'FAILED', snapshot_error: 'not activated', snapshot_count: 0,
    },
  })),
}));

import worker from '../src/worker';
import { runIngest } from '../src/service';

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
    data_run_id: 'pit-run', data_cutoff: '2026-07-15T23:59:59Z',
    decision_at: '2026-07-16T00:00:00Z', tradable_at: '2026-07-16T14:30:00Z', pit_status: 'PIT',
  };
  dbState.nowcast = {
    date: '2026-07-21', score: 61, verdict: 'BULLISH', netliq_dir: 'UP', qe_qt_regime: 'FLAT',
    reason: 'provisional macro estimate', coverage: 1, decision_status: 'OK', channel_status: 'PROVISIONAL',
    factor_quality_json: '{}', freshness_json: '{}',
  };
  dbState.reference = null;
  dbState.meta = {};
  dbState.activeSnapshotState = 'FAILED';
  vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 503 })));
});

describe('/api/snapshot explicit channels', () => {
  it('returns official and provisional nowcast snapshots separately', async () => {
    const response = await worker.fetch(new Request('https://example.test/api/snapshot'), env);
    const body = await response.json() as any;

    expect(body.official.date).toBe('2026-07-15');
    expect(body.official).toMatchObject({
      data_run_id: 'pit-run', data_cutoff: '2026-07-15T23:59:59Z',
      decision_at: '2026-07-16T00:00:00Z', tradable_at: '2026-07-16T14:30:00Z', pit_status: 'PIT',
    });
    expect(body.nowcast.date).toBe('2026-07-21');
    expect(body.nowcast.channel_status).toBe('PROVISIONAL');
    expect(body.snapshot).toBeUndefined();
    expect(body.ingest.runs.active).toMatchObject({ run_id: 'active-1', state: 'ACTIVE' });
    expect(body.ingest.runs.active).toMatchObject({ snapshot_state: 'FAILED', snapshot_count: 2 });
    expect(body.ingest.runs.latestFailed).toMatchObject({ run_id: 'failed-1', failed_series: 'SOFR' });
  });
});

describe('/api/health ingest snapshot outcome', () => {
  it('exposes the ACTIVE run snapshot failure in health metadata', async () => {
    dbState.meta = { last_ingest_at: new Date().toISOString(), last_status: 'ok' };
    const response = await worker.fetch(new Request('https://example.test/api/health'), env);
    const body = await response.json() as any;

    expect(response.status).toBe(503);
    expect(body.ok).toBe(false);
    expect(body.ingest_runs.active).toMatchObject({
      run_id: 'active-1', snapshot_state: 'FAILED', snapshot_error: 'snapshot write failed', snapshot_count: 2,
    });
  });

  it('returns 503 with an explicit reason while the ACTIVE snapshot outcome is PENDING', async () => {
    dbState.activeSnapshotState = 'PENDING';
    dbState.meta = { last_ingest_at: new Date().toISOString(), last_status: 'ok' };

    const response = await worker.fetch(new Request('https://example.test/api/health'), env);
    const body = await response.json() as any;

    expect(response.status).toBe(503);
    expect(body.ok).toBe(false);
    expect(body.error).toBe('snapshot_pending');
  });
});

describe('/api/admin/refresh contention', () => {
  it('returns HTTP 409 when another ingest owns the database lease', async () => {
    vi.mocked(runIngest).mockResolvedValueOnce({ status: 'conflict', runId: 'run-2' } as any);

    const response = await worker.fetch(new Request('https://example.test/api/admin/refresh', {
      method: 'POST',
      headers: { authorization: 'Bearer test' },
    }), env);
    const body = await response.json() as any;

    expect(response.status).toBe(409);
    expect(body).toEqual({ status: 'conflict', runId: 'run-2' });
  });
});

afterEach(() => {
  vi.useRealTimers();
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

    expect(body.official.decision_status).toBe('DATA_INCOMPLETE');
    expect(body.official.score).toBeNull();
    expect(body.official.verdict).toBeNull();
    expect(body.official.display_verdict).toBe('UNKNOWN');
    expect(body.official.reason).toContain('宏观数据不完整');
    expect(body.official.guidance.tone).toBe('unknown');
    expect(body.official.guidance.exposure).not.toMatch(/加仓|\+/);
    expect(JSON.stringify(body.official.guidance)).not.toContain('未触发');
    expect(body.official.factor_quality.netliqTrend.asOf).toBe('2026-07-01');
    expect(body.official.freshness.WDTGAL.observationDate).toBe('2026-07-01');
    expect(body.official.policy_regime).toBeNull();
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

  it('withholds explain attribution and names a factor availability change', async () => {
    dbState.row = {
      ...dbState.row,
      score: 65,
      factors_json: '{"netliqTrend":80,"credit":40}',
      walcl: 6000, tga: 700, rrp: 100, netliq: 5200,
    };
    dbState.reference = {
      date: '2026-07-01', score: 55, decision_status: 'OK',
      factors_json: '{"netliqTrend":60}', walcl: 5900, tga: 700, rrp: 100, netliq: 5100,
    };

    const response = await worker.fetch(new Request('https://example.test/api/explain'), env);
    const body = await response.json() as any;

    expect(body.attribution).toBeNull();
    expect(body.attribution_unavailable_reason).toBe('factor_availability_changed');
    expect(body.attribution_message).toContain('因子可用性');
  });

  it('treats legacy rows without quality columns conservatively', async () => {
    dbState.row = {
      date: '2024-01-01', score: 60, verdict: 'BULLISH', netliq_dir: 'UP', qe_qt_regime: 'FLAT',
      reason: 'legacy', coverage: 1,
    } as any;

    const response = await worker.fetch(new Request('https://example.test/api/snapshot'), env);
    const body = await response.json() as any;

    expect(body.official.decision_status).toBe('DATA_INCOMPLETE');
    expect(body.official.display_verdict).toBe('UNKNOWN');
    expect(body.official.factor_quality).toEqual({});
    expect(body.official.freshness).toEqual({});
  });
});

describe('/api/snapshot live stress status', () => {
  it('returns UNKNOWN and blocks risk increases when every live source fails', async () => {
    const response = await worker.fetch(new Request('https://example.test/api/snapshot'), env);
    const body = await response.json() as any;

    expect(response.status).toBe(200);
    expect(body.official.score).toBe(60);
    expect(body.official.verdict).toBe('BULLISH');
    expect(body.official.live_stress.status).toBe('UNKNOWN');
    expect(body.official.display_verdict).toBe('UNKNOWN');
    expect(body.official.guidance.tierLabel).toBe('实时风险层不可用');
    expect(body.official.guidance.exposure).not.toContain('+15~20pp');
    expect(body.official.guidance.triggers[1].detail).not.toContain('当前未触发');
  });
});

describe('/api/prices provider metadata', () => {
  it('keeps numeric fields and exposes source/fetch/provider/fallback metadata', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-21T12:00:00.000Z'));
    const sourceSeconds = Date.parse('2026-07-17T20:00:00.000Z') / 1000;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('DX-Y.NYB') || url.includes('%5ETNX') || url.includes('^TNX')) {
        return new Response('', { status: 503 });
      }
      if (url.includes('stooq.com') && url.includes('dx.f')) {
        return new Response('Symbol,Date,Time,Open,High,Low,Close,Volume\nDX.F,2026-07-17,20:00:00,98.2,98.2,98.2,98.2,0\n');
      }
      if (url.includes('api.stlouisfed.org') && url.includes('DGS10')) {
        return Response.json({ observations: [{ date: '2026-07-17', value: '4.25' }] });
      }
      if (url.includes('stooq.com')) return new Response('', { status: 503 });
      return Response.json({ chart: { result: [{ meta: {
        regularMarketPrice: 5000, regularMarketTime: sourceSeconds,
        marketState: 'CLOSED', exchangeDataDelayedBy: 0,
      } }] } });
    });
    vi.stubGlobal('fetch', fetchMock);

    const response = await worker.fetch(new Request('https://example.test/api/prices'), env);
    const body = await response.json() as any;

    expect(body).toMatchObject({ dxy: 98.2, us10y: 4.25, asofSemantics: 'FETCH_TIME' });
    expect(body.quotes.dxy).toMatchObject({ sourceName: 'Stooq', fallbackUsed: true, status: 'OK' });
    expect(body.quotes.us10y).toMatchObject({ sourceName: 'FRED', fallbackUsed: true, status: 'OK' });
    expect(body.quotes.spx).toMatchObject({
      sourceTimestamp: '2026-07-17T20:00:00.000Z', marketState: 'CLOSED', sourceName: 'Yahoo Finance',
    });
    expect(body.quotes.spx.fetchedAt).not.toBe(body.quotes.spx.sourceTimestamp);
  });
});

describe('/api/health persisted decision quality', () => {
  it('returns 503 for a fresh successful ingest whose latest snapshot is incomplete', async () => {
    dbState.row = { ...dbState.row, decision_status: 'DATA_INCOMPLETE', score: null, verdict: null };
    dbState.meta = { last_ingest_at: new Date().toISOString(), last_status: 'ok' };

    const response = await worker.fetch(new Request('https://example.test/api/health'), env);
    const body = await response.json() as any;

    expect(response.status).toBe(503);
    expect(body.ok).toBe(false);
    expect(body.stale).toBe(true);
    expect(body.decision_status).toBe('DATA_INCOMPLETE');
  });
});
