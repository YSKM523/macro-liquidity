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
    model_version: 'champion-v1.0.0', config_hash: 'a'.repeat(64), code_commit_sha: 'LOCAL_UNCONFIGURED',
    created_at: '2026-07-16T00:00:01Z',
  } as any,
  nowcast: {
    date: '2026-07-21', score: 61, verdict: 'BULLISH', netliq_dir: 'UP', qe_qt_regime: 'FLAT',
    reason: 'provisional macro estimate', coverage: 1, decision_status: 'OK', channel_status: 'PROVISIONAL',
    factor_quality_json: '{}', freshness_json: '{}',
    model_version: 'champion-v1.0.0', config_hash: 'a'.repeat(64), code_commit_sha: 'LOCAL_UNCONFIGURED',
    data_run_id: 'pit-run', data_cutoff: '2026-07-21T23:59:59Z', decision_at: '2026-07-21T23:59:59Z',
    created_at: '2026-07-22T00:00:00Z',
  } as any,
  reference: null as any,
  meta: {} as Record<string, string>,
  activeSnapshotState: 'FAILED' as 'PENDING' | 'SUCCEEDED' | 'FAILED',
  eventInputs: {
    asOfCutoff: '2024-01-10T01:00:00.001Z',
    signals: [{ signalDate: '2024-01-04', decisionAt: '2024-01-05T12:00:00Z', tradableAt: '2024-01-05T16:00:00Z', score: 60, verdict: 'BULLISH', netliqDir: 'UP', snapshotVixEod: 20, targetExposure: 1, portfolioTier: 'STRONG_TAILWIND', portfolioMethodology: 'DASHBOARD_EXPOSURE_TIERS_V1', stressMethodology: 'PIT_SNAPSHOT_VIX_PROXY', recordedAt: '2024-01-09T00:00:00Z', dataRunId: 'run-a', modelVersion: 'champion-v1.0.0', configHash: 'a'.repeat(64), codeCommitSha: '0123456789abcdef0123456789abcdef01234567', dataCutoff: '2024-01-04T23:59:59Z', createdAt: '2024-01-09T00:00:01Z' }],
    prices: [
      { date: '2024-01-05', adjustedClose: 100, source: 'FRED:SP500', fetchedAt: '2024-01-10T00:00:00Z', dataRunId: 'run-a', activationRunId: 'run-a', activatedAt: '2024-01-10T01:00:00Z', provenanceStatus: 'PIT_RAW' },
      { date: '2024-01-08', adjustedClose: 101, source: 'FRED:SP500', fetchedAt: '2024-01-10T00:00:00Z', dataRunId: 'run-a', activationRunId: 'run-a', activatedAt: '2024-01-10T01:00:00Z', provenanceStatus: 'PIT_RAW' },
    ],
    vix: [{ date: '2024-01-05', value: 20, source: 'FRED:VIXCLS', fetchedAt: '2024-01-10T00:00:00Z', dataRunId: 'run-a', activationRunId: 'run-a', activatedAt: '2024-01-10T01:00:00Z', provenanceStatus: 'PIT_RAW' }],
    cashRates: [{ date: '2024-01-04', rate: 5, source: 'FRED:SOFR', fetchedAt: '2024-01-10T00:00:00Z', dataRunId: 'run-a', activationRunId: 'run-a', activatedAt: '2024-01-10T01:00:00Z', provenanceStatus: 'PIT_RAW' }],
  } as any,
  exportRows: [] as any[],
  adminRateAllowed: true,
  backtestRows: [] as any[],
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
  loadBacktestRows: vi.fn(async () => dbState.backtestRows),
  loadEventBacktestInputs: vi.fn(async () => dbState.eventInputs),
  exportOfficialSnapshots: vi.fn(async () => dbState.exportRows),
  recordAdminAudit: vi.fn(async () => undefined),
  reserveAdminRateLimit: vi.fn(async () => dbState.adminRateAllowed),
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
import { loadEventBacktestInputs } from '../src/db';

const env = {
  DB: {} as D1Database,
  ASSETS: { fetch: vi.fn() } as unknown as Fetcher,
  FRED_API_KEY: 'test',
  ADMIN_TOKEN: 'test',
  START_DATE: '2024-01-01',
};

beforeEach(() => {
  vi.clearAllMocks();
  dbState.row = {
    date: '2026-07-15', score: 60, verdict: 'BULLISH', netliq_dir: 'UP', qe_qt_regime: 'FLAT',
    reason: 'macro remains bullish', coverage: 1, decision_status: 'OK',
    factor_quality_json: '{"funding":{"score":80,"quality":1,"status":"OK","asOf":"2026-07-15","components":{}}}',
    freshness_json: '{"SOFR":{"value":4.3,"observationDate":"2026-07-15","ageDays":0,"status":"FRESH"}}',
    data_run_id: 'pit-run', data_cutoff: '2026-07-15T23:59:59Z',
    decision_at: '2026-07-16T00:00:00Z', tradable_at: '2026-07-16T14:30:00Z', pit_status: 'PIT',
    model_version: 'champion-v1.0.0', config_hash: 'a'.repeat(64), code_commit_sha: 'LOCAL_UNCONFIGURED',
    created_at: '2026-07-16T00:00:01Z',
  };
  dbState.nowcast = {
    date: '2026-07-21', score: 61, verdict: 'BULLISH', netliq_dir: 'UP', qe_qt_regime: 'FLAT',
    reason: 'provisional macro estimate', coverage: 1, decision_status: 'OK', channel_status: 'PROVISIONAL',
    factor_quality_json: '{}', freshness_json: '{}',
    model_version: 'champion-v1.0.0', config_hash: 'a'.repeat(64), code_commit_sha: 'LOCAL_UNCONFIGURED',
    data_run_id: 'pit-run', data_cutoff: '2026-07-21T23:59:59Z', decision_at: '2026-07-21T23:59:59Z',
    created_at: '2026-07-22T00:00:00Z',
  };
  dbState.reference = null;
  dbState.meta = {};
  dbState.activeSnapshotState = 'FAILED';
  dbState.eventInputs = {
    asOfCutoff: '2024-01-10T01:00:00.001Z',
    signals: [{ signalDate: '2024-01-04', decisionAt: '2024-01-05T12:00:00Z', tradableAt: '2024-01-05T16:00:00Z', score: 60, verdict: 'BULLISH', netliqDir: 'UP', snapshotVixEod: 20, targetExposure: 1, portfolioTier: 'STRONG_TAILWIND', portfolioMethodology: 'DASHBOARD_EXPOSURE_TIERS_V1', stressMethodology: 'PIT_SNAPSHOT_VIX_PROXY', recordedAt: '2024-01-09T00:00:00Z', dataRunId: 'run-a', modelVersion: 'champion-v1.0.0', configHash: 'a'.repeat(64), codeCommitSha: '0123456789abcdef0123456789abcdef01234567', dataCutoff: '2024-01-04T23:59:59Z', createdAt: '2024-01-09T00:00:01Z' }],
    prices: [
      { date: '2024-01-05', adjustedClose: 100, source: 'FRED:SP500', fetchedAt: '2024-01-10T00:00:00Z', dataRunId: 'run-a', activationRunId: 'run-a', activatedAt: '2024-01-10T01:00:00Z', provenanceStatus: 'PIT_RAW' },
      { date: '2024-01-08', adjustedClose: 101, source: 'FRED:SP500', fetchedAt: '2024-01-10T00:00:00Z', dataRunId: 'run-a', activationRunId: 'run-a', activatedAt: '2024-01-10T01:00:00Z', provenanceStatus: 'PIT_RAW' },
    ],
    vix: [{ date: '2024-01-05', value: 20, source: 'FRED:VIXCLS', fetchedAt: '2024-01-10T00:00:00Z', dataRunId: 'run-a', activationRunId: 'run-a', activatedAt: '2024-01-10T01:00:00Z', provenanceStatus: 'PIT_RAW' }],
    cashRates: [{ date: '2024-01-04', rate: 5, source: 'FRED:SOFR', fetchedAt: '2024-01-10T00:00:00Z', dataRunId: 'run-a', activationRunId: 'run-a', activatedAt: '2024-01-10T01:00:00Z', provenanceStatus: 'PIT_RAW' }],
  };
  dbState.exportRows = [];
  dbState.adminRateAllowed = true;
  dbState.backtestRows = [];
  vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 503 })));
});

describe('/api/snapshot explicit channels', () => {
  it('returns official and provisional nowcast snapshots separately', async () => {
    dbState.row.factor_quality_json = '{"vol":{"score":40,"quality":1,"status":"OK","asOf":"2026-07-15","components":{}}}';
    const response = await worker.fetch(new Request('https://example.test/api/snapshot'), env);
    const body = await response.json() as any;

    expect(body.official.date).toBe('2026-07-15');
    expect(body.official).toMatchObject({
      data_run_id: 'pit-run', data_cutoff: '2026-07-15T23:59:59Z',
      decision_at: '2026-07-16T00:00:00Z', tradable_at: '2026-07-16T14:30:00Z', pit_status: 'PIT',
    });
    expect(body.nowcast.date).toBe('2026-07-21');
    expect(body.nowcast.channel_status).toBe('PROVISIONAL');
    expect(body.official.factor_classification).toEqual({
      scoring_factor_keys: ['netliqTrend', 'impulse', 'credit', 'funding', 'rates', 'dollar', 'reserveAdequacy', 'curve'],
      legacy_zero_weight_diagnostics: { vol: 'LEGACY_ZERO_WEIGHT_DIAGNOSTIC' },
      live_risk_overlay_inputs: ['vix', 'spx', 'us10y', 'dxy'],
    });
    expect(body.official.factor_quality.vol.classification).toBe('LEGACY_ZERO_WEIGHT_DIAGNOSTIC');
    expect(body.snapshot).toBeUndefined();
    expect(body.ingest.runs.active).toMatchObject({ run_id: 'active-1', state: 'ACTIVE' });
    expect(body.ingest.runs.active).toMatchObject({ snapshot_state: 'FAILED', snapshot_count: 2 });
    expect(body.ingest.runs.latestFailed).toMatchObject({ run_id: 'failed-1', failed_series: 'SOFR' });
  });

  it('keeps v1 and live-cache metadata in an empty snapshot response', async () => {
    dbState.row = null;
    dbState.nowcast = null;
    const response = await worker.fetch(new Request('https://example.test/api/v1/snapshot'), env);
    const body = await response.json() as any;
    expect(body).toMatchObject({ api_version: 'v1', error: 'no_data', official: null, nowcast: null });
    expect(body.live_cache).toMatchObject({ prices: expect.any(String), stress: expect.any(String) });
  });
});

describe('public error contract', () => {
  it('returns only a stable code and request id while redacting the logged exception', async () => {
    const errorSink = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const throwingEnv = {
      ...env,
      ASSETS: { fetch: vi.fn(async () => {
        throw new Error('authorization=Bearer super-secret token=also-secret');
      }) } as unknown as Fetcher,
    };
    const response = await worker.fetch(new Request('https://example.test/not-api', {
      headers: { 'x-request-id': 'public-request-1' },
    }), throwingEnv);
    const body = await response.json() as any;
    expect(response.status).toBe(500);
    expect(body).toEqual({ error: 'internal_error', error_code: 'INTERNAL_ERROR', request_id: 'public-request-1' });
    expect(JSON.stringify(body)).not.toContain('super-secret');
    expect(errorSink).toHaveBeenCalledOnce();
    expect(errorSink.mock.calls[0][0]).not.toMatch(/super-secret|also-secret/);
  });
});

describe('/api/v1 governance routes', () => {
  it('returns a migration-backfilled legacy snapshot honestly instead of permanently rejecting it', async () => {
    dbState.row = {
      ...dbState.row,
      model_version: 'LEGACY_UNVERSIONED', config_hash: 'LEGACY_UNVERSIONED',
      code_commit_sha: 'LEGACY_UNVERSIONED', data_run_id: 'must-not-leak',
      data_cutoff: '2020-01-01T00:00:00Z', decision_at: null,
      created_at: '2026-01-01T00:00:00Z',
    };
    dbState.nowcast = null;
    const response = await worker.fetch(new Request('https://example.test/api/v1/snapshot'), env);
    const body = await response.json() as any;
    expect(response.status).toBe(200);
    expect(body.snapshot_provenance).toEqual({
      totalCount: 1, governedCount: 0, legacyCount: 1, completeness: 'PARTIAL_LEGACY',
    });
    expect(body.official).toMatchObject({
      provenance_status: 'LEGACY', model_version: 'LEGACY_UNVERSIONED',
      config_hash: null, code_commit_sha: null, data_run_id: null,
      data_cutoff: null, decision_at: null, created_at: null,
    });
  });

  it('returns strict joint legacy/governed provenance instead of permanently rejecting legacy history', async () => {
    const legacy = {
      date: '2020-01-01', score: 50, spx: 3200, verdict: 'NEUTRAL', factors_json: '{}',
      qe_qt_regime: 'FLAT', vix_eod: 15, model_version: 'LEGACY_UNVERSIONED',
      config_hash: 'LEGACY_UNVERSIONED', code_commit_sha: 'LEGACY_UNVERSIONED',
      data_run_id: 'must-not-leak', data_cutoff: null, decision_at: null, created_at: null,
    };
    dbState.backtestRows = [legacy];
    dbState.eventInputs.signals = [{
      ...dbState.eventInputs.signals[0],
      modelVersion: 'LEGACY_UNVERSIONED', configHash: 'LEGACY_UNVERSIONED',
      codeCommitSha: 'LEGACY_UNVERSIONED', dataRunId: 'must-not-leak',
      dataCutoff: undefined, decisionAt: '2024-01-05T12:00:00Z', createdAt: undefined,
    }];
    dbState.exportRows = [legacy];
    const backtest = await worker.fetch(new Request('https://example.test/api/v1/backtest'), env);
    expect(backtest.status).toBe(200);
    await expect(backtest.json()).resolves.toMatchObject({ snapshot_provenance: {
      totalCount: 1, governedCount: 0, legacyCount: 1, completeness: 'PARTIAL_LEGACY',
    } });
    const exported = await worker.fetch(new Request('https://example.test/api/v1/snapshots/export'), env);
    const body = await exported.json() as any;
    expect(exported.status).toBe(200);
    expect(body.provenance).toMatchObject({ governedCount: 0, legacyCount: 1 });
    expect(body.rows[0]).toMatchObject({ provenance_status: 'LEGACY', data_run_id: null, config_hash: null });
  });
  it('returns schema-validated version metadata without changing the legacy route', async () => {
    const response = await worker.fetch(new Request('https://example.test/api/v1/snapshot'), env);
    const body = await response.json() as any;
    expect(response.status).toBe(200);
    expect(body.api_version).toBe('v1');
    expect(body.official).toMatchObject({
      model_version: 'champion-v1.0.0', config_hash: 'a'.repeat(64),
      code_commit_sha: 'LOCAL_UNCONFIGURED', data_run_id: 'pit-run',
    });
  });

  it('fails closed when persisted version metadata is malformed', async () => {
    dbState.row.config_hash = 'bad';
    const response = await worker.fetch(new Request('https://example.test/api/v1/snapshot'), env);
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ error: 'schema_validation_failed' });
  });

  it('publishes the frozen model descriptor and deterministic identity', async () => {
    const response = await worker.fetch(new Request('https://example.test/api/v1/model'), env);
    const body = await response.json() as any;
    expect(response.status).toBe(200);
    expect(body.model).toMatchObject({
      modelVersion: 'champion-v1.0.0', codeCommitSha: 'LOCAL_UNCONFIGURED',
    });
    expect(body.model.configHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('validates export queries and safely emits CSV', async () => {
    dbState.exportRows = [{
      ...dbState.row, date: '2026-07-15', verdict: '=FORMULA()', reason: 'quoted, value',
    }];
    const invalid = await worker.fetch(new Request('https://example.test/api/v1/snapshots/export?from=bad'), env);
    expect(invalid.status).toBe(400);
    const response = await worker.fetch(new Request('https://example.test/api/v1/snapshots/export?format=csv'), env);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/csv');
    expect(await response.text()).toContain("'=FORMULA()");
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

  it('requires a second exact confirmation for full rebuild', async () => {
    const response = await worker.fetch(new Request('https://example.test/api/admin/refresh?all=1', {
      method: 'POST', headers: { authorization: 'Bearer test' },
    }), env);
    expect(response.status).toBe(428);
    expect(runIngest).not.toHaveBeenCalled();
  });

  it('rate limits authenticated admin attempts before starting ingest', async () => {
    dbState.adminRateAllowed = false;
    const response = await worker.fetch(new Request('https://example.test/api/admin/refresh', {
      method: 'POST', headers: { authorization: 'Bearer test' },
    }), env);
    expect(response.status).toBe(429);
    expect(runIngest).not.toHaveBeenCalled();
  });

  it('reserves capacity before authentication so unauthorized attempts share the same limit', async () => {
    dbState.adminRateAllowed = false;
    const response = await worker.fetch(new Request('https://example.test/api/admin/refresh', {
      method: 'POST', headers: { 'cf-connecting-ip': '203.0.113.10' },
    }), env);
    expect(response.status).toBe(429);
    expect(runIngest).not.toHaveBeenCalled();
  });

  it('accepts a full rebuild only with both authentication and confirmation', async () => {
    vi.mocked(runIngest).mockResolvedValueOnce({ status: 'active', runId: 'full-1', updated: 1, snapshots: 1 } as any);
    const response = await worker.fetch(new Request('https://example.test/api/admin/refresh?all=1', {
      method: 'POST', headers: {
        authorization: 'Bearer test', 'x-confirm-full-rebuild': 'FULL_REBUILD',
      },
    }), env);
    expect(response.status).toBe(200);
    expect(runIngest).toHaveBeenCalledWith(env, true);
  });
});

describe('/api/backtest event-time performance', () => {
  it('v1 returns only the persisted model/data identities in the exact as-of replay cohort', async () => {
    dbState.backtestRows = [{
      date: '2026-07-15', score: 60, spx: 6000, verdict: 'BULLISH', factors_json: '{}',
      qe_qt_regime: 'FLAT', vix_eod: 20, model_version: 'champion-v1.0.0',
      config_hash: 'b'.repeat(64), code_commit_sha: '0123456789abcdef0123456789abcdef01234567',
      data_run_id: 'historical-run', data_cutoff: '2026-07-15T23:59:59Z',
      decision_at: '2026-07-16T00:00:00Z', created_at: '2026-07-16T00:00:01Z',
    }];
    dbState.eventInputs.signals = [{
      ...dbState.eventInputs.signals[0],
      modelVersion: 'champion-v1.0.0', configHash: 'c'.repeat(64),
      codeCommitSha: 'fedcba9876543210fedcba9876543210fedcba98', dataRunId: 'asof-signal-run',
      dataCutoff: '2024-01-04T23:59:59Z', createdAt: '2024-01-09T00:00:01Z',
    }];
    const response = await worker.fetch(new Request(
      'https://example.test/api/v1/backtest?as_of=2024-01-10T01%3A00%3A00.001Z',
    ), env);
    const body = await response.json() as any;
    expect(response.status).toBe(200);
    expect(body.snapshot_models).toEqual([expect.objectContaining({
      modelVersion: 'champion-v1.0.0', configHash: 'c'.repeat(64),
      codeCommitSha: 'fedcba9876543210fedcba9876543210fedcba98', dataRunId: 'asof-signal-run',
    })]);
    expect(body.snapshot_models).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ dataRunId: 'historical-run' }),
    ]));
    expect(body.snapshot_provenance).toMatchObject({ totalCount: 1, governedCount: 1, legacyCount: 0 });
    expect(vi.mocked(loadEventBacktestInputs)).toHaveBeenCalledWith(env.DB, '2024-01-10T01:00:00.001Z');
    expect(body.runtime_model).toBeDefined();
  });

  it('adds event-time NAV while preserving diagnostics and marks weekly strategy legacy', async () => {
    const response = await worker.fetch(new Request('https://example.test/api/backtest?as_of=2024-01-10T01%3A00%3A00.001Z'), env);
    const body = await response.json() as any;
    expect(response.status).toBe(200);
    expect(body.event_time.status).toBe('OK');
    expect(body.event_time.nav).toHaveLength(2);
    expect(body.horizons).toBeDefined();
    expect(body.factor_ic_spearman).toBeDefined();
    expect(body.strategy_long_flat.methodology).toBe('LEGACY_WEEKLY');
    expect(body.event_time.provenance).toMatchObject({
      revisionPolicy: 'APPEND_ONLY_AS_OF', responseReproducible: true,
      asOfCutoff: '2024-01-10T01:00:00.001Z',
    });
    expect(body.event_time.portfolio).toMatchObject({
      methodology: 'DASHBOARD_EXPOSURE_TIERS_V1',
      stressMethodology: 'PIT_SNAPSHOT_VIX_PROXY',
      benchmarks: {
        spxBuyHold: { methodology: 'SPX_BUY_HOLD' },
        betaMatchedStatic: { methodology: 'STATIC_SPX_CASH_AVERAGE_BETA' },
        volatilityTarget: { methodology: 'PRIOR_20_SESSION_10PCT_VOL_TARGET_CAP_100' },
        movingAverage200: { methodology: 'PRIOR_CLOSE_200DMA_RISK_CONTROL' },
      },
    });
    expect(vi.mocked(loadEventBacktestInputs)).toHaveBeenCalledWith(env.DB, '2024-01-10T01:00:00.001Z');
  });

  it('returns typed event-time DATA_INCOMPLETE instead of a 500 or zero return', async () => {
    dbState.eventInputs = { ...dbState.eventInputs, cashRates: [] };
    const response = await worker.fetch(new Request('https://example.test/api/backtest'), env);
    const body = await response.json() as any;
    expect(response.status).toBe(200);
    expect(body.event_time.status).toBe('DATA_INCOMPLETE');
    expect(body.event_time.reason).toMatch(/SOFR/i);
    expect(body.event_time.nav).toEqual([]);
    expect(body.event_time.totals).toEqual({ totalReturn: null, tradingCostRate: null, sessions: null });
    expect(body.event_time.provenance.revisionPolicy).toBe('APPEND_ONLY_AS_OF');
    expect(body.event_time.portfolio).toBeNull();
  });

  it.each([
    ['score', { score: Number.NaN }],
    ['verdict', { verdict: null }],
    ['net liquidity direction', { netliqDir: 'SIDEWAYS' }],
    ['snapshot VIX', { snapshotVixEod: -1 }],
  ])('returns HTTP 200 typed DATA_INCOMPLETE for invalid official %s', async (_label, patch) => {
    dbState.eventInputs = {
      ...dbState.eventInputs,
      signals: [{ ...dbState.eventInputs.signals[0], ...patch }],
    };
    const response = await worker.fetch(new Request('https://example.test/api/backtest'), env);
    const body = await response.json() as any;
    expect(response.status).toBe(200);
    expect(body.event_time.status).toBe('DATA_INCOMPLETE');
    expect(body.event_time.reason).toMatch(/official.*portfolio.*field/i);
    expect(body.event_time.portfolio).toBeNull();
  });
});

describe('/api/robustness legacy methodology', () => {
  it('marks the robustness strategy and caveat as legacy weekly', async () => {
    const response = await worker.fetch(new Request('https://example.test/api/robustness'), env);
    const body = await response.json() as any;
    expect(body.strategy.methodology).toBe('LEGACY_WEEKLY');
    expect(body.caveats.join(' ')).toMatch(/LEGACY_WEEKLY/);
  });

  it('adds purged validation using persisted verdicts and the existing portfolio target mapping', async () => {
    dbState.backtestRows = Array.from({ length: 300 }, (_, index) => ({
      date: new Date(Date.UTC(2020, 0, 6 + index * 7)).toISOString().slice(0, 10),
      score: index % 2 ? 60 : 40,
      spx: 100 + index,
      verdict: index % 2 ? 'BEARISH' : 'BULLISH',
      netliq_dir: index % 2 ? 'UP' : 'DOWN',
      vix_eod: 20,
      factors_json: JSON.stringify({ netliqTrend: index }),
      pit_status: 'PIT',
      model_version: 'champion-v1.0.0', config_hash: 'a'.repeat(64),
      code_commit_sha: '0123456789abcdef0123456789abcdef01234567', data_run_id: `run-${index}`,
      data_cutoff: '2026-07-15T23:59:59Z', decision_at: '2026-07-16T00:00:00Z', created_at: '2026-07-16T00:00:01Z',
    }));

    const response = await worker.fetch(new Request('https://example.test/api/robustness'), env);
    const body = await response.json() as any;

    expect(body.validation).toMatchObject({ status: 'OK', protocol: { protocol: 'PURGED_VALIDATION_V1', embargoDays: 91 } });
    expect(body.validation.folds[0].metrics.formalVerdict.n).toBeGreaterThan(0);
    expect(body.validation.folds[0].metrics.risk.precision.n).toBeGreaterThan(0);
    expect(body.validation.holdout).toMatchObject({ status: 'PENDING_MATURITY', frozen: { holdoutFrom: '2026-07-23' } });
  });

  it('fails the additive validation closed without altering legacy robustness fields', async () => {
    dbState.backtestRows = [{
      date: '2024-01-01', score: 60, spx: 100, verdict: 'BULLISH', netliq_dir: 'UP', vix_eod: 20,
      factors_json: '{}', pit_status: 'LEGACY_NON_PIT', model_version: 'LEGACY_UNVERSIONED',
      config_hash: 'LEGACY_UNVERSIONED', code_commit_sha: 'LEGACY_UNVERSIONED',
    }];
    const response = await worker.fetch(new Request('https://example.test/api/robustness'), env);
    const body = await response.json() as any;
    expect(body.strategy.methodology).toBe('LEGACY_WEEKLY');
    expect(body.validation).toMatchObject({ status: 'DATA_INCOMPLETE', folds: [], aggregateMetrics: null });
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

    const pendingResponse = worker.fetch(new Request('https://example.test/api/prices'), env);
    await vi.runAllTimersAsync();
    const response = await pendingResponse;
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
