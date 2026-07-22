import { describe, expect, it } from 'vitest';
// @ts-ignore Node-only migration fixture.
import { readFileSync } from 'node:fs';
import { Miniflare } from 'miniflare';
import { activateIngestRun, loadEventBacktestInputs, stagePitObservations } from '../src/db';

const migrations = [
  '0001_init.sql', '0002_add_coverage.sql', '0003_meta.sql',
  '0004_snapshot_quality.sql', '0005_official_nowcast.sql',
  '0006_atomic_ingest.sql', '0007_ingest_snapshot_outcome.sql',
  '0008_point_in_time_observations.sql', '0009_event_time_backtest.sql',
  '0010_model_governance.sql',
];

async function emptyDb() {
  const mf = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response(); } }',
    d1Databases: ['DB'],
  });
  return { mf, db: await mf.getD1Database('DB') as unknown as D1Database };
}

async function apply(db: D1Database, files = migrations) {
  for (const file of files) {
    const sql = readFileSync(`migrations/${file}`, 'utf8')
      .replace(/^\s*--.*$/gm, '')
      .replace(/\s+/g, ' ');
    await db.exec(sql);
  }
}

async function seedActivation(db: D1Database, runId = 'run-1') {
  await db.batch([
    db.prepare("INSERT INTO ingest_runs (run_id,state,mode,started_at) VALUES (?,'RUNNING','INCREMENTAL','2024-01-03T00:00:00Z')").bind(runId),
    db.prepare("INSERT INTO ingest_lock VALUES ('fred_ingest',?,strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now','+60 seconds'))").bind(runId),
    db.prepare("INSERT INTO ingest_series_attempts (run_id,series_id,status,started_at,completed_at,row_count) VALUES (?,'SP500','SUCCEEDED','2024-01-03T00:00:00Z','2024-01-03T00:01:00Z',1)").bind(runId),
    db.prepare("INSERT INTO ingest_series_attempts (run_id,series_id,status,started_at,completed_at,row_count) VALUES (?,'VIXCLS','SUCCEEDED','2024-01-03T00:00:00Z','2024-01-03T00:01:00Z',1)").bind(runId),
    db.prepare("INSERT INTO ingest_series_attempts (run_id,series_id,status,started_at,completed_at,row_count) VALUES (?,'SOFR','SUCCEEDED','2024-01-03T00:00:00Z','2024-01-03T00:01:00Z',1)").bind(runId),
    db.prepare("INSERT INTO staging_observations VALUES (?,'SP500','2024-01-02',4000)").bind(runId),
    db.prepare("INSERT INTO staging_observations VALUES (?,'VIXCLS','2024-01-02',20)").bind(runId),
    db.prepare("INSERT INTO staging_observations VALUES (?,'SOFR','2024-01-02',5.25)").bind(runId),
  ]);
}

describe('event-time daily input storage', () => {
  it('stores append-only revisions with D1 activation time and explicit provenance status', async () => {
    const { mf, db } = await emptyDb();
    await apply(db, migrations.slice(0, 8));
    await db.batch([
      db.prepare("INSERT INTO observations VALUES ('SP500','2024-01-02',4000)"),
      db.prepare("INSERT INTO model_snapshot_weekly (date,decision_week,score,decision_status,pit_status,decision_at,tradable_at,data_run_id) VALUES ('2024-01-03','2024-01-01',60,'OK','PIT','2024-01-03T12:00:00Z','2024-01-03T16:00:00Z','snapshot-run')"),
    ]);
    await apply(db, migrations.slice(8));

    expect(await db.prepare("SELECT data_run_id,activated_at,provenance_status FROM market_prices_daily WHERE symbol='SPX'").first())
      .toMatchObject({ data_run_id: 'MIGRATION_0009_BACKFILL', provenance_status: 'SYNTHETIC_BACKFILL' });
    expect(await db.prepare('SELECT recorded_at FROM model_snapshot_weekly').first<{ recorded_at: string }>())
      .toMatchObject({ recorded_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/) });

    await db.prepare(`INSERT INTO market_prices_daily
      (symbol,date,close,adjusted_close,source,fetched_at,data_run_id,activation_run_id,activated_at,provenance_status)
      VALUES ('SPX','2024-01-02',4100,4100,'ALFRED','2024-01-04T00:00:00Z','run-real','run-real','2024-01-04T01:00:00Z','PIT_RAW')`).run();
    await expect(db.prepare("SELECT COUNT(*) AS n FROM market_prices_daily WHERE symbol='SPX' AND date='2024-01-02'").first())
      .resolves.toEqual({ n: 2 });
    await expect(db.prepare("UPDATE market_prices_daily SET close=1 WHERE data_run_id='run-real'").run()).rejects.toThrow(/append.only/i);
    await expect(db.prepare("DELETE FROM market_prices_daily WHERE data_run_id='run-real'").run()).rejects.toThrow(/append.only/i);
    await mf.dispose();
  }, 30_000);

  it('assigns every input from one activation the same D1 visibility instant and keeps same-run replay idempotent', async () => {
    const { mf, db } = await emptyDb();
    await apply(db);
    await seedActivation(db, 'pit-run');
    await stagePitObservations(db, 'pit-run', [
      ['SP500', 4000], ['VIXCLS', 20], ['SOFR', 5.25],
    ].map(([seriesId, value]) => ({
      seriesId: String(seriesId), observationDate: '2024-01-02', vintageDate: '2024-01-03',
      releasedAt: '2024-01-02T23:59:59Z', fetchedAt: '2024-01-03T00:01:00Z',
      tradableAt: '2024-01-03T14:30:00Z', source: 'ALFRED' as const,
      checksum: `${seriesId}-pit`, releaseTimeStatus: 'CONSERVATIVE_DATE_END' as const, value: Number(value),
    })));
    await activateIngestRun(db, 'pit-run', '2024-01-03T00:05:00Z');

    expect(await db.prepare(`SELECT COUNT(DISTINCT activated_at) AS instants,
      MIN(provenance_status) AS min_status,MAX(provenance_status) AS max_status
      FROM (SELECT activated_at,provenance_status FROM market_prices_daily WHERE data_run_id='pit-run'
            UNION ALL SELECT activated_at,provenance_status FROM cash_rates_daily WHERE data_run_id='pit-run')`).first())
      .toEqual({ instants: 1, min_status: 'PIT_RAW', max_status: 'PIT_RAW' });
    expect(await db.prepare("SELECT activated_at FROM ingest_runs WHERE run_id='pit-run'").first())
      .toEqual(await db.prepare("SELECT activated_at FROM market_prices_daily WHERE data_run_id='pit-run' LIMIT 1").first());
    const before = await db.prepare("SELECT COUNT(*) AS n FROM market_prices_daily WHERE data_run_id='pit-run'").first();
    await expect(activateIngestRun(db, 'pit-run', '2024-01-03T00:05:00Z')).rejects.toThrow(/activation|fence/i);
    expect(await db.prepare("SELECT COUNT(*) AS n FROM market_prices_daily WHERE data_run_id='pit-run'").first()).toEqual(before);
    await mf.dispose();
  }, 30_000);

  it('replays signals and all daily revisions at one requested as-of cutoff', async () => {
    const { mf, db } = await emptyDb();
    await apply(db);
    await db.prepare(`INSERT INTO model_snapshot_weekly
      (date,decision_week,score,decision_status,pit_status,decision_at,tradable_at,data_run_id,recorded_at)
      VALUES ('2024-01-04','2024-01-01',60,'OK','PIT','2024-01-05T12:00:00Z','2024-01-05T16:00:00Z','signal-run','2024-01-06T00:00:00Z')`).run();
    for (const [run, activated, spx] of [
      ['run-a', '2024-01-06T01:00:00Z', 100],
      ['run-b', '2024-01-10T01:00:00Z', 110],
    ] as const) {
      await db.batch([
        ...['2024-01-05', '2024-01-08'].map(date => db.prepare(`INSERT INTO market_prices_daily
          (symbol,date,close,adjusted_close,source,fetched_at,data_run_id,activation_run_id,activated_at,provenance_status)
          VALUES ('SPX',?,?,?,'ALFRED',?,?,?,?, 'PIT_RAW')`).bind(date, spx, spx, activated, run, run, activated)),
        db.prepare(`INSERT INTO market_prices_daily
          (symbol,date,close,adjusted_close,source,fetched_at,data_run_id,activation_run_id,activated_at,provenance_status)
          VALUES ('VIX','2024-01-05',20,20,'ALFRED',?,?,?,?,'PIT_RAW')`).bind(activated, run, run, activated),
        db.prepare(`INSERT INTO cash_rates_daily
          (rate_id,date,rate,source,fetched_at,data_run_id,activation_run_id,activated_at,provenance_status)
          VALUES ('SOFR','2024-01-04',5,'ALFRED',?,?,?,?,'PIT_RAW')`).bind(activated, run, run, activated),
      ]);
    }

    const old = await loadEventBacktestInputs(db, '2024-01-08T00:00:00Z');
    expect(old.asOfCutoff).toBe('2024-01-08T00:00:00Z');
    expect(old.signals).toEqual([expect.objectContaining({ dataRunId: 'signal-run', recordedAt: '2024-01-06T00:00:00Z' })]);
    expect(new Set([...old.prices, ...old.vix, ...old.cashRates].map(row => row.dataRunId))).toEqual(new Set(['run-a']));
    expect(old.prices.map(row => row.adjustedClose)).toEqual([100, 100]);

    const signalAtEqualCutoff = await loadEventBacktestInputs(db, '2024-01-06T00:00:00Z');
    expect(signalAtEqualCutoff.signals).toEqual([]);
    const signalJustAfter = await loadEventBacktestInputs(db, '2024-01-06T00:00:00.001Z');
    expect(signalJustAfter.signals).toHaveLength(1);
    const correctionAtEqualCutoff = await loadEventBacktestInputs(db, '2024-01-10T01:00:00Z');
    expect(correctionAtEqualCutoff.prices.map(row => row.adjustedClose)).toEqual([100, 100]);

    const corrected = await loadEventBacktestInputs(db, '2024-01-11T00:00:00Z');
    expect(new Set([...corrected.prices, ...corrected.vix, ...corrected.cashRates].map(row => row.dataRunId))).toEqual(new Set(['run-b']));
    expect(corrected.prices.map(row => row.adjustedClose)).toEqual([110, 110]);
    await expect(loadEventBacktestInputs(db, 'not-an-instant')).rejects.toThrow(/invalid.*as.of/i);
    await expect(loadEventBacktestInputs(db, '2999-01-01T00:00:00Z')).rejects.toThrow(/future.*as.of/i);
    await mf.dispose();
  }, 30_000);

  it('creates strict market and cash tables with auditable local backfill', async () => {
    const { mf, db } = await emptyDb();
    await apply(db, migrations.slice(0, 8));
    await db.batch([
      db.prepare("INSERT INTO observations VALUES ('SP500','2024-01-02',4000)"),
      db.prepare("INSERT INTO observations VALUES ('VIXCLS','2024-01-02',20)"),
      db.prepare("INSERT INTO observations VALUES ('SOFR','2024-01-02',5.25)"),
    ]);
    await apply(db, migrations.slice(8));

    expect(await db.prepare('SELECT symbol,date,close,adjusted_close,source,data_run_id FROM market_prices_daily ORDER BY symbol').all())
      .toMatchObject({ results: [
        { symbol: 'SPX', date: '2024-01-02', close: 4000, adjusted_close: 4000, source: 'FRED:SP500', data_run_id: 'MIGRATION_0009_BACKFILL' },
        { symbol: 'VIX', date: '2024-01-02', close: 20, adjusted_close: 20, source: 'FRED:VIXCLS', data_run_id: 'MIGRATION_0009_BACKFILL' },
      ] });
    await expect(db.prepare('SELECT rate_id,date,rate,source,data_run_id FROM cash_rates_daily').first())
      .resolves.toEqual({ rate_id: 'SOFR', date: '2024-01-02', rate: 5.25, source: 'FRED:SOFR', data_run_id: 'MIGRATION_0009_BACKFILL' });
    await expect(db.prepare("INSERT INTO market_prices_daily VALUES ('SPX','bad',1,1,'x','bad','x')").run()).rejects.toThrow();
    await mf.dispose();
  }, 30_000);

  it('materializes SPX, VIX and SOFR atomically, skips unchanged staging, and appends only corrections', async () => {
    const { mf, db } = await emptyDb();
    await apply(db);
    await seedActivation(db);
    await activateIngestRun(db, 'run-1', '2024-01-03T00:05:00Z');

    expect(await db.prepare('SELECT symbol,date,close,source,fetched_at,data_run_id,provenance_status FROM market_prices_daily ORDER BY symbol').all())
      .toMatchObject({ results: [
        { symbol: 'SPX', date: '2024-01-02', close: 4000, source: 'FRED:SP500', fetched_at: '2024-01-03T00:01:00Z', data_run_id: null, provenance_status: 'LEGACY_NO_PIT' },
        { symbol: 'VIX', date: '2024-01-02', close: 20, source: 'FRED:VIXCLS', fetched_at: '2024-01-03T00:01:00Z', data_run_id: null, provenance_status: 'LEGACY_NO_PIT' },
      ] });
    await expect(db.prepare('SELECT rate_id,date,rate,source,data_run_id,provenance_status FROM cash_rates_daily').first())
      .resolves.toEqual({ rate_id: 'SOFR', date: '2024-01-02', rate: 5.25, source: 'FRED:SOFR', data_run_id: null, provenance_status: 'LEGACY_NO_PIT' });

    await db.prepare("INSERT INTO ingest_runs (run_id,state,mode,started_at) VALUES ('run-2','RUNNING','INCREMENTAL','2024-01-04T00:00:00Z')").run();
    await db.prepare("UPDATE ingest_lock SET owner_run_id='run-2',expires_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','+60 seconds')").run();
    await db.prepare("INSERT INTO ingest_series_attempts (run_id,series_id,status,started_at,completed_at,row_count) VALUES ('run-2','SP500','SUCCEEDED','2024-01-04T00:00:00Z','2024-01-04T00:01:00Z',1)").run();
    await db.prepare("INSERT INTO staging_observations VALUES ('run-2','SP500','2024-01-02',4000)").run();
    await activateIngestRun(db, 'run-2', '2024-01-04T00:05:00Z');
    await expect(db.prepare("SELECT COUNT(*) AS n FROM market_prices_daily WHERE symbol='SPX'").first())
      .resolves.toEqual({ n: 1 });

    await db.prepare("INSERT INTO ingest_runs (run_id,state,mode,started_at) VALUES ('run-3','RUNNING','INCREMENTAL','2024-01-05T00:00:00Z')").run();
    await db.prepare("UPDATE ingest_lock SET owner_run_id='run-3',expires_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','+60 seconds')").run();
    await db.prepare("INSERT INTO ingest_series_attempts (run_id,series_id,status,started_at,completed_at,row_count) VALUES ('run-3','SP500','SUCCEEDED','2024-01-05T00:00:00Z','2024-01-05T00:01:00Z',1)").run();
    await db.prepare("INSERT INTO staging_observations VALUES ('run-3','SP500','2024-01-02',4100)").run();
    await activateIngestRun(db, 'run-3', '2024-01-05T00:05:00Z');
    await expect(db.prepare("SELECT COUNT(*) AS n FROM market_prices_daily WHERE symbol='SPX'").first())
      .resolves.toEqual({ n: 2 });
    await expect(db.prepare("SELECT close,fetched_at,data_run_id FROM market_prices_daily WHERE symbol='SPX' ORDER BY julianday(activated_at) DESC,activation_run_id DESC LIMIT 1").first())
      .resolves.toEqual({ close: 4100, fetched_at: '2024-01-05T00:01:00Z', data_run_id: null });
    await mf.dispose();
  }, 30_000);

  it('uses the latest PIT vintage source and real fetch time for new rows and corrections', async () => {
    const { mf, db } = await emptyDb();
    await apply(db);
    await db.batch([
      db.prepare(`INSERT INTO market_prices_daily
        (symbol,date,close,adjusted_close,source,fetched_at,data_run_id,activation_run_id,activated_at,provenance_status)
        VALUES ('SPX','2024-01-02',4000,4000,'FRED:SP500','2024-01-03T00:00:00Z','MIGRATION_0009_BACKFILL','MIGRATION_0009_BACKFILL','2024-01-03T00:00:00Z','SYNTHETIC_BACKFILL')`),
      db.prepare(`INSERT INTO cash_rates_daily
        (rate_id,date,rate,source,fetched_at,data_run_id,activation_run_id,activated_at,provenance_status)
        VALUES ('SOFR','2024-01-02',5.25,'FRED:SOFR','2024-01-03T00:00:00Z','MIGRATION_0009_BACKFILL','MIGRATION_0009_BACKFILL','2024-01-03T00:00:00Z','SYNTHETIC_BACKFILL')`),
    ]);
    await seedActivation(db, 'pit-inputs');
    await stagePitObservations(db, 'pit-inputs', [
      ['SP500', 4000, '2024-01-03T00:01:00Z'],
      ['VIXCLS', 20, '2024-01-03T00:02:00Z'],
      ['SOFR', 5.25, '2024-01-03T00:03:00Z'],
    ].map(([seriesId, value, fetchedAt]) => ({
      seriesId: String(seriesId), observationDate: '2024-01-02', vintageDate: '2024-01-03',
      releasedAt: '2024-01-02T23:59:59Z', fetchedAt: String(fetchedAt),
      tradableAt: '2024-01-03T14:30:00Z', source: 'ALFRED' as const,
      checksum: `${seriesId}-initial`, releaseTimeStatus: 'CONSERVATIVE_DATE_END' as const,
      value: Number(value),
    })));
    await activateIngestRun(db, 'pit-inputs', '2024-01-03T00:05:00Z');

    expect(await db.prepare("SELECT symbol,source,fetched_at FROM market_prices_daily WHERE activation_run_id='pit-inputs' ORDER BY symbol").all())
      .toMatchObject({ results: [
        { symbol: 'SPX', source: 'ALFRED', fetched_at: '2024-01-03T00:01:00Z' },
        { symbol: 'VIX', source: 'ALFRED', fetched_at: '2024-01-03T00:02:00Z' },
      ] });
    expect(await db.prepare("SELECT source,fetched_at FROM cash_rates_daily WHERE activation_run_id='pit-inputs'").first())
      .toEqual({ source: 'ALFRED', fetched_at: '2024-01-03T00:03:00Z' });

    await db.batch([
      db.prepare("INSERT INTO ingest_runs (run_id,state,mode,started_at) VALUES ('pit-correction','RUNNING','INCREMENTAL','2024-01-05T00:00:00Z')"),
      db.prepare("UPDATE ingest_lock SET owner_run_id='pit-correction',expires_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','+60 seconds')"),
      db.prepare("INSERT INTO ingest_series_attempts (run_id,series_id,status,started_at,completed_at,row_count) VALUES ('pit-correction','SP500','SUCCEEDED','2024-01-05T00:00:00Z','2024-01-05T00:01:00Z',1)"),
      db.prepare("INSERT INTO staging_observations VALUES ('pit-correction','SP500','2024-01-02',4100)"),
    ]);
    await stagePitObservations(db, 'pit-correction', [{
      seriesId: 'SP500', observationDate: '2024-01-02', vintageDate: '2024-01-05',
      releasedAt: '2024-01-04T23:59:59Z', fetchedAt: '2024-01-05T00:02:00Z',
      tradableAt: '2024-01-05T14:30:00Z', source: 'ALFRED',
      checksum: 'SP500-correction', releaseTimeStatus: 'CONSERVATIVE_DATE_END', value: 4100,
    }]);
    await activateIngestRun(db, 'pit-correction', '2024-01-05T00:05:00Z');
    expect(await db.prepare("SELECT close,source,fetched_at,data_run_id FROM market_prices_daily WHERE symbol='SPX' ORDER BY julianday(activated_at) DESC,activation_run_id DESC LIMIT 1").first())
      .toEqual({
        close: 4100, source: 'ALFRED', fetched_at: '2024-01-05T00:02:00Z',
        data_run_id: 'pit-correction',
      });
    await mf.dispose();
  }, 30_000);

  it('rolls market and cash rows back when a later activation fence fails', async () => {
    const { mf, db } = await emptyDb();
    await apply(db);
    await seedActivation(db, 'target');
    await db.prepare(`CREATE TRIGGER transfer_after_market AFTER INSERT ON market_prices_daily
      BEGIN UPDATE ingest_lock SET owner_run_id='replacement'; END`).run();

    await expect(activateIngestRun(db, 'target', '2024-01-03T00:05:00Z')).rejects.toThrow(/fence|lease|activation/i);
    expect(await db.prepare('SELECT COUNT(*) AS n FROM observations').first()).toEqual({ n: 0 });
    expect(await db.prepare('SELECT COUNT(*) AS n FROM market_prices_daily').first()).toEqual({ n: 0 });
    expect(await db.prepare('SELECT COUNT(*) AS n FROM cash_rates_daily').first()).toEqual({ n: 0 });
    expect(await db.prepare("SELECT state FROM ingest_runs WHERE run_id='target'").first()).toEqual({ state: 'RUNNING' });
    await mf.dispose();
  }, 30_000);

  it('rejects the whole activation when active value disagrees with the latest PIT vintage', async () => {
    const { mf, db } = await emptyDb();
    await apply(db);
    await db.batch([
      db.prepare("INSERT INTO observations VALUES ('SP500','2024-01-02',3900)"),
      db.prepare("INSERT INTO ingest_runs (run_id,state,mode,started_at) VALUES ('prior','ACTIVE','FULL','2024-01-01T00:00:00Z')"),
      db.prepare("INSERT INTO ingest_runs (run_id,state,mode,started_at) VALUES ('mismatch','RUNNING','INCREMENTAL','2024-01-03T00:00:00Z')"),
      db.prepare("INSERT INTO ingest_series_attempts (run_id,series_id,status,started_at,completed_at,row_count) VALUES ('mismatch','SP500','SUCCEEDED','2024-01-03T00:00:00Z','2024-01-03T00:01:00Z',1)"),
      db.prepare("INSERT INTO staging_observations VALUES ('mismatch','SP500','2024-01-02',4100)"),
      db.prepare("INSERT INTO ingest_lock VALUES ('fred_ingest','mismatch',strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now','+60 seconds'))"),
    ]);
    await stagePitObservations(db, 'mismatch', [{
      seriesId: 'SP500', observationDate: '2024-01-02', vintageDate: '2024-01-03',
      releasedAt: '2024-01-02T23:59:59Z', fetchedAt: '2024-01-03T00:02:00Z',
      tradableAt: '2024-01-03T14:30:00Z', source: 'ALFRED', checksum: 'mismatch-pit',
      releaseTimeStatus: 'CONSERVATIVE_DATE_END', value: 4000,
    }]);

    await expect(activateIngestRun(db, 'mismatch', '2024-01-03T00:05:00Z'))
      .rejects.toThrow(/PIT|mismatch|activation/i);
    expect(await db.prepare("SELECT value FROM observations WHERE series_id='SP500'").first()).toEqual({ value: 3900 });
    expect(await db.prepare("SELECT state FROM ingest_runs WHERE run_id='prior'").first()).toEqual({ state: 'ACTIVE' });
    expect(await db.prepare("SELECT state FROM ingest_runs WHERE run_id='mismatch'").first()).toEqual({ state: 'RUNNING' });
    expect(await db.prepare('SELECT COUNT(*) AS n FROM market_prices_daily').first()).toEqual({ n: 0 });
    expect(await db.prepare('SELECT COUNT(*) AS n FROM observations_pit').first()).toEqual({ n: 0 });
    await mf.dispose();
  }, 30_000);
});
