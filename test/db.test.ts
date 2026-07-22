import { describe, expect, it, vi } from 'vitest';
// The project tsconfig intentionally only loads Workers types; this test runs in Vitest's Node runtime.
// @ts-ignore
import { existsSync, readFileSync } from 'node:fs';
import * as snapshotDb from '../src/db';
import {
  loadBacktestRows,
  loadEventBacktestInputs,
  officialSnapshotBefore,
  officialVerdictAnchors,
  officialSnapshotHistory,
  officialSnapshotOnOrBefore,
  upsertOfficialSnapshot,
} from '../src/db';
import { Miniflare } from 'miniflare';

const testSnapshot = {
  date: '2024-07-24', walcl: 6000, tga: 700, rrp: 100, repo: 0, netliq: 5200,
  netliqTrend: 5100, sofrIorb: 0, hyOas: 3, dgs10: 4, dxy: 100, vix: 15,
  bsImpulse: 'FLAT', netliqDir: 'UP', verdict: 'BULLISH', score: 60,
  factors: {}, factorResults: {}, freshness: {}, decisionStatus: 'OK',
  p0: true, p1: true, p2: true, p3: true, reason: 'ok', coverage: 1,
} as any;

const persistedSnapshotColumns = [
  'walcl', 'tga', 'rrp', 'repo', 'netliq', 'netliq_trend', 'sofr_iorb', 'hy_oas', 'dgs10',
  'dxy_eod', 'vix_eod', 'qe_qt_regime', 'netliq_dir', 'verdict', 'score', 'p0', 'p1', 'p2',
  'p3', 'spx', 'reason', 'factors_json', 'coverage', 'decision_status', 'factor_quality_json',
  'freshness_json',
];

describe('officialSnapshotBefore', () => {
  it('loads the nearest snapshot strictly before the rebuild start date', async () => {
    const first = vi.fn(async () => ({ date: '2024-05-08', verdict: 'BULLISH' }));
    const bind = vi.fn(() => ({ first }));
    const prepare = vi.fn(() => ({ bind }));
    const db = { prepare } as unknown as D1Database;

    const row = await officialSnapshotBefore(db, '2024-05-15');

    expect(prepare).toHaveBeenCalledWith(
      "SELECT * FROM model_snapshot_weekly WHERE date < ? AND decision_status = 'OK' AND verdict IS NOT NULL ORDER BY date DESC LIMIT 1",
    );
    expect(bind).toHaveBeenCalledWith('2024-05-15');
    expect(row).toEqual({ date: '2024-05-08', verdict: 'BULLISH' });
  });

  it('requires an explicitly valid decision rather than accepting a legacy verdict', async () => {
    const first = vi.fn(async () => null);
    const prepare = vi.fn(() => ({ bind: vi.fn(() => ({ first })) }));
    const db = { prepare } as unknown as D1Database;

    await officialSnapshotBefore(db, '2024-05-15');

    const sql = (prepare.mock.calls as unknown as [[string]])[0][0];
    expect(sql).toContain("decision_status = 'OK'");
    expect(sql).toContain('verdict IS NOT NULL');
  });
});

describe('officialVerdictAnchors', () => {
  it('loads valid in-window official verdict anchors with one ordered query', async () => {
    const rows = [
      { date: '2024-05-22', verdict: 'BULLISH' as const },
      { date: '2024-05-29', verdict: 'BEARISH' as const },
    ];
    const all = vi.fn(async () => ({ results: rows }));
    const bind = vi.fn(() => ({ all }));
    const prepare = vi.fn(() => ({ bind }));
    const db = { prepare } as unknown as D1Database;

    const result = await officialVerdictAnchors(db, '2024-05-15', '2024-05-29');

    expect(prepare).toHaveBeenCalledTimes(1);
    const sql = (prepare.mock.calls as unknown as [[string]])[0][0];
    expect(sql).toContain('FROM model_snapshot_weekly');
    expect(sql).toContain('date BETWEEN ? AND ?');
    expect(sql).toContain("decision_status = 'OK'");
    expect(sql).toContain('verdict IS NOT NULL');
    expect(sql).toContain('ORDER BY date');
    expect(bind).toHaveBeenCalledWith('2024-05-15', '2024-05-29');
    expect(result).toEqual(rows);
  });
});

describe('official and nowcast snapshot channels', () => {
  it('provides explicit writers for official weekly and provisional daily storage', async () => {
    expect(typeof (snapshotDb as any).upsertOfficialSnapshot).toBe('function');
    expect(typeof (snapshotDb as any).upsertNowcastSnapshot).toBe('function');

    const run = vi.fn(async () => ({ meta: { changes: 1 } }));
    const bind = vi.fn(() => ({ run }));
    const prepare = vi.fn(() => ({ bind }));
    const db = { prepare } as unknown as D1Database;
    const snapshot = {
      date: '2024-07-24', walcl: 6000, tga: 700, rrp: 100, repo: 0, netliq: 5200,
      netliqTrend: 5100, sofrIorb: 0, hyOas: 3, dgs10: 4, dxy: 100, vix: 15,
      bsImpulse: 'FLAT', netliqDir: 'UP', verdict: 'BULLISH', score: 60,
      factors: {}, factorResults: {}, freshness: {}, decisionStatus: 'OK',
      p0: true, p1: true, p2: true, p3: true, reason: 'ok', coverage: 1,
    } as any;

    await (snapshotDb as any).upsertOfficialSnapshot(db, 'run-1', snapshot, 5000);
    expect((prepare.mock.calls as unknown as Array<[string]>)[0][0]).toContain('INSERT INTO model_snapshot_weekly');
    expect(bind.mock.calls[0]).toContain('2024-07-22');
    expect(bind.mock.calls[0].at(-1)).toBe('run-1');

    await (snapshotDb as any).upsertNowcastSnapshot(db, 'run-1', snapshot, 5000);
    expect((prepare.mock.calls as unknown as Array<[string]>)[1][0]).toContain('INSERT INTO nowcast_snapshot_daily');
    expect(bind.mock.calls[1]).toContain('PROVISIONAL');
    expect(bind.mock.calls[1].at(-1)).toBe('run-1');
  });

  it.each([
    ['official', 'transferred'],
    ['official', 'expired'],
    ['nowcast', 'transferred'],
    ['nowcast', 'expired'],
  ] as const)('rejects a %s upsert when the owner lease is %s', async (channel, leaseState) => {
    const mf = new Miniflare({
      modules: true,
      script: 'export default { fetch() { return new Response(); } }',
      d1Databases: ['DB'],
    });
    const db = await mf.getD1Database('DB') as unknown as D1Database;
    const extraColumn = channel === 'official'
      ? "decision_week TEXT UNIQUE, recorded_at TEXT, pit_status TEXT NOT NULL DEFAULT 'LEGACY_NON_PIT'"
      : 'channel_status TEXT';
    const table = channel === 'official' ? 'model_snapshot_weekly' : 'nowcast_snapshot_daily';
    await db.batch([
      db.prepare(`CREATE TABLE ${table} (
        date TEXT PRIMARY KEY, ${extraColumn}, ${persistedSnapshotColumns.join(', ')}
      )`),
      db.prepare('CREATE TABLE ingest_lock (lock_name TEXT PRIMARY KEY, owner_run_id TEXT, acquired_at TEXT, expires_at TEXT)'),
      db.prepare(`INSERT INTO ingest_lock VALUES (
        'fred_ingest', ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
        strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ?)
      )`).bind(
        leaseState === 'transferred' ? 'replacement' : 'run-1',
        leaseState === 'expired' ? '-1 second' : '+60 seconds',
      ),
    ]);

    const write = channel === 'official'
      ? snapshotDb.upsertOfficialSnapshot(db, 'run-1', testSnapshot, 5000)
      : snapshotDb.upsertNowcastSnapshot(db, 'run-1', testSnapshot, 5000);
    await expect(write).rejects.toThrow(/lease|fence/i);
    await expect(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first())
      .resolves.toEqual({ n: 0 });
    await mf.dispose();
  }, 30_000);

  it('loads official analytics exclusively from weekly storage', async () => {
    const all = vi.fn(async () => ({ results: [] }));
    const prepare = vi.fn(() => ({ all }));
    const db = { prepare } as unknown as D1Database;

    await loadBacktestRows(db);

    const sql = (prepare.mock.calls as unknown as [[string]])[0][0];
    expect(sql).toContain('FROM model_snapshot_weekly');
    expect(sql).not.toContain('daily_snapshot');
    expect(sql).not.toContain('nowcast_snapshot_daily');
  });

  it('creates frequency-safe tables and migrates only WALCL-cadence legacy rows', () => {
    expect(existsSync('migrations/0005_official_nowcast.sql')).toBe(true);
    if (!existsSync('migrations/0005_official_nowcast.sql')) return;
    const migration = readFileSync('migrations/0005_official_nowcast.sql', 'utf8');

    expect(migration).toMatch(/CREATE TABLE IF NOT EXISTS model_snapshot_weekly/i);
    expect(migration).toMatch(/decision_week\s+TEXT\s+NOT NULL\s+UNIQUE/i);
    expect(migration).toMatch(/CREATE TABLE IF NOT EXISTS nowcast_snapshot_daily/i);
    expect(migration).toMatch(/channel_status\s+TEXT\s+NOT NULL\s+DEFAULT\s+'PROVISIONAL'/i);
    expect(migration).toMatch(/series_id\s*=\s*'WALCL'/i);
    expect(migration).toMatch(/o\.date\s*=\s*d\.date/i);
    expect(migration).not.toMatch(/DROP TABLE\s+daily_snapshot/i);
  });
});

describe('historical snapshot consumers', () => {
  it('uses only explicit OK rows as explain references', async () => {
    const first = vi.fn(async () => null);
    const prepare = vi.fn(() => ({ bind: vi.fn(() => ({ first })) }));
    const db = { prepare } as unknown as D1Database;

    await officialSnapshotOnOrBefore(db, '2024-05-15');

    const sql = (prepare.mock.calls as unknown as [[string]])[0][0];
    expect(sql).toContain("decision_status = 'OK'");
  });

  it('excludes legacy and incomplete rows from every analytics loader', async () => {
    const all = vi.fn(async () => ({ results: [] }));
    const prepare = vi.fn(() => ({ all }));
    const db = { prepare } as unknown as D1Database;

    await loadBacktestRows(db);

    const sql = (prepare.mock.calls as unknown as [[string]])[0][0];
    expect(sql).toContain("decision_status = 'OK'");
  });

  it('exposes decision status while masking official score and verdict for non-OK history rows', async () => {
    const all = vi.fn(async () => ({ results: [] }));
    const bind = vi.fn(() => ({ all }));
    const prepare = vi.fn(() => ({ bind }));
    const db = { prepare } as unknown as D1Database;

    await officialSnapshotHistory(db, '2024-01-01', '2024-12-31');

    const sql = (prepare.mock.calls as unknown as [[string]])[0][0];
    expect(sql).toContain('decision_status');
    expect(sql).toMatch(/CASE WHEN decision_status = 'OK' THEN score ELSE NULL END AS score/);
    expect(sql).toMatch(/CASE WHEN decision_status = 'OK' AND verdict IS NOT NULL THEN verdict ELSE NULL END AS verdict/);
    expect(sql).toContain('netliq');
    expect(sql).toContain('walcl');
    expect(bind).toHaveBeenCalledWith('2024-01-01', '2024-12-31');
  });
});

describe('event-time backtest repository', () => {
  it('loads only official OK PIT signals and ordered SPX/VIX/SOFR inputs', async () => {
    const queries: string[] = [];
    const results = [
      [{ db_now: '2024-01-20T00:00:00Z', cutoff: '2024-01-15T00:00:00Z' }],
      [{ signal_date: '2024-01-04', decision_at: '2024-01-05T12:00:00Z', tradable_at: '2024-01-05T16:00:00Z', score: 60, verdict: 'BULLISH', netliq_dir: 'DOWN', vix_eod: 20, recorded_at: '2024-01-06T00:00:00Z', data_run_id: 'signal-a' }],
      [
        { symbol: 'SPX', date: '2024-01-05', adjusted_close: 100, source: 'FRED:SP500', fetched_at: '2024-01-06T00:00:00Z', data_run_id: 'run-a', activation_run_id: 'activation-a', activated_at: '2024-01-07T00:00:00Z', provenance_status: 'PIT_RAW' },
        { symbol: 'VIX', date: '2024-01-05', adjusted_close: 20, source: 'FRED:VIXCLS', fetched_at: '2024-01-06T00:00:00Z', data_run_id: 'run-a', activation_run_id: 'activation-a', activated_at: '2024-01-07T00:00:00Z', provenance_status: 'PIT_RAW' },
      ],
      [{ date: '2024-01-05', rate: 5, source: 'FRED:SOFR', fetched_at: '2024-01-06T00:00:00Z', data_run_id: 'run-b', activation_run_id: 'activation-a', activated_at: '2024-01-07T00:00:00Z', provenance_status: 'PIT_RAW' }],
    ];
    const db = {
      prepare(sql: string) {
        queries.push(sql);
        const rows = results[queries.length - 1];
        const statement: any = {
          bind: vi.fn(() => statement),
          all: vi.fn(async () => ({ results: rows })),
          first: vi.fn(async () => rows[0]),
        };
        return statement;
      },
    } as unknown as D1Database;

    const loaded = await loadEventBacktestInputs(db, '2024-01-15T00:00:00Z');

    expect(queries[0]).toMatch(/strftime[\s\S]*now[\s\S]*cutoff/i);
    expect(queries[1]).toMatch(/model_snapshot_weekly[\s\S]*decision_status='OK'[\s\S]*pit_status='PIT'/i);
    expect(queries[1]).toMatch(/recorded_at[\s\S]*julianday\(recorded_at\).*julianday\(\?\)/i);
    expect(queries[1]).toMatch(/ORDER BY[\s\S]*julianday\(decision_at\)/i);
    expect(queries[1]).toMatch(/verdict[\s\S]*netliq_dir[\s\S]*vix_eod/i);
    expect(queries[2]).toMatch(/ROW_NUMBER\(\)[\s\S]*market_prices_daily[\s\S]*activated_at/i);
    expect(queries[3]).toMatch(/ROW_NUMBER\(\)[\s\S]*cash_rates_daily[\s\S]*activated_at/i);
    expect(loaded).toEqual({
      asOfCutoff: '2024-01-15T00:00:00Z',
      signals: [{
        signalDate: '2024-01-04', decisionAt: '2024-01-05T12:00:00Z', tradableAt: '2024-01-05T16:00:00Z',
        score: 60, verdict: 'BULLISH', netliqDir: 'DOWN', snapshotVixEod: 20,
        stressMethodology: 'PIT_SNAPSHOT_VIX_PROXY', targetExposure: 0.9,
        portfolioTier: 'ORDINARY_TAILWIND', portfolioMethodology: 'DASHBOARD_EXPOSURE_TIERS_V1',
        recordedAt: '2024-01-06T00:00:00Z', dataRunId: 'signal-a',
      }],
      prices: [{ date: '2024-01-05', adjustedClose: 100, source: 'FRED:SP500', fetchedAt: '2024-01-06T00:00:00Z', dataRunId: 'run-a', activationRunId: 'activation-a', activatedAt: '2024-01-07T00:00:00Z', provenanceStatus: 'PIT_RAW' }],
      vix: [{ date: '2024-01-05', value: 20, source: 'FRED:VIXCLS', fetchedAt: '2024-01-06T00:00:00Z', dataRunId: 'run-a', activationRunId: 'activation-a', activatedAt: '2024-01-07T00:00:00Z', provenanceStatus: 'PIT_RAW' }],
      cashRates: [{ date: '2024-01-05', rate: 5, source: 'FRED:SOFR', fetchedAt: '2024-01-06T00:00:00Z', dataRunId: 'run-b', activationRunId: 'activation-a', activatedAt: '2024-01-07T00:00:00Z', provenanceStatus: 'PIT_RAW' }],
    });
  });
});

describe('snapshot quality persistence', () => {
  it('serializes decision status, factor quality, and series freshness in the snapshot upsert', async () => {
    const run = vi.fn(async () => ({ meta: { changes: 1 } }));
    const bind = vi.fn(() => ({ run }));
    const prepare = vi.fn(() => ({ bind }));
    const db = { prepare } as unknown as D1Database;
    const factorResults = {
      credit: { score: null, quality: 0, status: 'MISSING', asOf: null, components: {} },
    };
    const freshness = {
      BAMLH0A0HYM2: { value: null, observationDate: null, ageDays: null, status: 'MISSING' },
    };
    const snapshot = {
      date: '2024-07-24', walcl: 6000, tga: 700, rrp: 100, repo: 0, netliq: 5200,
      netliqTrend: 5100, sofrIorb: 0, hyOas: null, dgs10: 4, dxy: 100, vix: 15,
      bsImpulse: 'FLAT', netliqDir: 'UP', verdict: 'BULLISH', score: 60,
      factors: { netliqTrend: 60 }, factorResults, freshness, decisionStatus: 'OK',
      p0: true, p1: true, p2: true, p3: true, reason: 'ok', coverage: 0.875,
    } as any;

    await upsertOfficialSnapshot(db, 'run-1', snapshot, 5000);

    const preparedSql = (prepare.mock.calls as unknown as [[string]])[0][0];
    expect(preparedSql).toContain('decision_status');
    expect(preparedSql).toContain('factor_quality_json');
    expect(preparedSql).toContain('freshness_json');
    expect(bind.mock.calls[0].slice(-4)).toEqual([
      'OK', JSON.stringify(factorResults), JSON.stringify(freshness),
      'run-1',
    ]);
  });

  it('defines conservative defaults so pre-migration rows remain readable', () => {
    expect(existsSync('migrations/0004_snapshot_quality.sql')).toBe(true);
    if (!existsSync('migrations/0004_snapshot_quality.sql')) return;
    const migration = readFileSync('migrations/0004_snapshot_quality.sql', 'utf8');

    expect(migration).toMatch(/decision_status\s+TEXT\s+NOT NULL\s+DEFAULT\s+'DATA_INCOMPLETE'/i);
    expect(migration).toMatch(/factor_quality_json\s+TEXT\s+NOT NULL\s+DEFAULT\s+'\{\}'/i);
    expect(migration).toMatch(/freshness_json\s+TEXT\s+NOT NULL\s+DEFAULT\s+'\{\}'/i);
  });
});
