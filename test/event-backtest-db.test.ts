import { describe, expect, it } from 'vitest';
// @ts-ignore Node-only migration fixture.
import { readFileSync } from 'node:fs';
import { Miniflare } from 'miniflare';
import { activateIngestRun } from '../src/db';

const migrations = [
  '0001_init.sql', '0002_add_coverage.sql', '0003_meta.sql',
  '0004_snapshot_quality.sql', '0005_official_nowcast.sql',
  '0006_atomic_ingest.sql', '0007_ingest_snapshot_outcome.sql',
  '0008_point_in_time_observations.sql', '0009_event_time_backtest.sql',
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

  it('materializes SPX, VIX and SOFR atomically and only rewrites corrections', async () => {
    const { mf, db } = await emptyDb();
    await apply(db);
    await seedActivation(db);
    await activateIngestRun(db, 'run-1', '2024-01-03T00:05:00Z');

    expect(await db.prepare('SELECT symbol,date,close,source,fetched_at,data_run_id FROM market_prices_daily ORDER BY symbol').all())
      .toMatchObject({ results: [
        { symbol: 'SPX', date: '2024-01-02', close: 4000, source: 'FRED:SP500', fetched_at: '2024-01-03T00:05:00Z', data_run_id: 'run-1' },
        { symbol: 'VIX', date: '2024-01-02', close: 20, source: 'FRED:VIXCLS', fetched_at: '2024-01-03T00:05:00Z', data_run_id: 'run-1' },
      ] });
    await expect(db.prepare('SELECT rate_id,date,rate,source,data_run_id FROM cash_rates_daily').first())
      .resolves.toEqual({ rate_id: 'SOFR', date: '2024-01-02', rate: 5.25, source: 'FRED:SOFR', data_run_id: 'run-1' });

    await db.prepare("INSERT INTO ingest_runs (run_id,state,mode,started_at) VALUES ('run-2','RUNNING','INCREMENTAL','2024-01-04T00:00:00Z')").run();
    await db.prepare("UPDATE ingest_lock SET owner_run_id='run-2',expires_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','+60 seconds')").run();
    await db.prepare("INSERT INTO ingest_series_attempts (run_id,series_id,status,started_at,completed_at,row_count) VALUES ('run-2','SP500','SUCCEEDED','2024-01-04T00:00:00Z','2024-01-04T00:01:00Z',1)").run();
    await db.prepare("INSERT INTO staging_observations VALUES ('run-2','SP500','2024-01-02',4000)").run();
    await activateIngestRun(db, 'run-2', '2024-01-04T00:05:00Z');
    await expect(db.prepare("SELECT fetched_at,data_run_id FROM market_prices_daily WHERE symbol='SPX'").first())
      .resolves.toEqual({ fetched_at: '2024-01-03T00:05:00Z', data_run_id: 'run-1' });

    await db.prepare("INSERT INTO ingest_runs (run_id,state,mode,started_at) VALUES ('run-3','RUNNING','INCREMENTAL','2024-01-05T00:00:00Z')").run();
    await db.prepare("UPDATE ingest_lock SET owner_run_id='run-3',expires_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','+60 seconds')").run();
    await db.prepare("INSERT INTO ingest_series_attempts (run_id,series_id,status,started_at,completed_at,row_count) VALUES ('run-3','SP500','SUCCEEDED','2024-01-05T00:00:00Z','2024-01-05T00:01:00Z',1)").run();
    await db.prepare("INSERT INTO staging_observations VALUES ('run-3','SP500','2024-01-02',4100)").run();
    await activateIngestRun(db, 'run-3', '2024-01-05T00:05:00Z');
    await expect(db.prepare("SELECT close,fetched_at,data_run_id FROM market_prices_daily WHERE symbol='SPX'").first())
      .resolves.toEqual({ close: 4100, fetched_at: '2024-01-05T00:05:00Z', data_run_id: 'run-3' });
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
});
