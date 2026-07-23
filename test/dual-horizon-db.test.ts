import { describe, expect, it } from 'vitest';
// @ts-ignore Node-only migration fixture.
import { readFileSync } from 'node:fs';
import { Miniflare } from 'miniflare';
import {
  loadDualHorizonLiquiditySeries,
  loadDualHorizonSnapshotInputs,
  loadLiquidityStructureSeries,
} from '../src/db';
import {
  DualHorizonDomainError,
  DualHorizonRequestError,
} from '../src/dual-horizon-errors';

const MIGRATIONS = [
  '0001_init.sql', '0002_add_coverage.sql', '0003_meta.sql', '0004_snapshot_quality.sql',
  '0005_official_nowcast.sql', '0006_atomic_ingest.sql', '0007_ingest_snapshot_outcome.sql',
  '0008_point_in_time_observations.sql', '0009_event_time_backtest.sql',
  '0010_model_governance.sql', '0011_policy_regime_events.sql',
];

const FACTORS = {
  netliqTrend: 50, impulse: 50, credit: 50, funding: 50,
  rates: 50, dollar: 50, reserveAdequacy: 50, curve: 50,
};

const FACTOR_RESULTS = Object.fromEntries(
  Object.entries(FACTORS).map(([key, score]) => [
    key,
    { score, quality: 1, status: 'OK', asOf: '2024-01-03', components: {} },
  ]),
);

async function migratedDb() {
  const mf = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response(); } }',
    d1Databases: ['DB'],
  });
  const db = await mf.getD1Database('DB') as unknown as D1Database;
  for (const file of MIGRATIONS) {
    const sql = readFileSync(`migrations/${file}`, 'utf8')
      .replace(/^\s*--.*$/gm, '')
      .replace(/\s+/g, ' ');
    await db.exec(sql);
  }
  return { mf, db };
}

async function seedOfficialSnapshot(db: D1Database, input: {
  date: string;
  recordedAt: string;
  modelVersion: string;
  configHash: string;
  regime: string;
}) {
  const decisionWeek = input.date === '2024-01-03' ? '2024-01-01' : '2024-01-08';
  await db.prepare(
    `INSERT INTO model_snapshot_weekly
      (date,decision_week,score,verdict,netliq_dir,vix_eod,qe_qt_regime,
       factors_json,factor_quality_json,decision_status,pit_status,decision_at,recorded_at,
       model_version,config_hash,code_commit_sha,data_run_id,data_cutoff,created_at)
     VALUES (?,?,?,?,?,?,?,?,?,'OK','PIT',?,?,?,?,?,?,?,?)`,
  ).bind(
    input.date, decisionWeek, 50, 'NEUTRAL', 'FLAT', 15, input.regime,
    JSON.stringify(FACTORS), JSON.stringify(FACTOR_RESULTS),
    `${input.date}T12:00:00Z`, input.recordedAt,
    input.modelVersion, input.configHash, 'b'.repeat(40),
    `run-${input.date}`, `${input.date}T11:59:59Z`, input.recordedAt,
  ).run();
}

async function seedProvisionalSnapshot(db: D1Database, date: string) {
  await db.prepare(
    `INSERT INTO nowcast_snapshot_daily
      (date,score,verdict,netliq_dir,vix_eod,qe_qt_regime,factors_json,factor_quality_json,
       decision_status,pit_status,decision_at,model_version,config_hash,code_commit_sha,
       data_run_id,data_cutoff,created_at)
     VALUES (?,50,'NEUTRAL','FLAT',15,'FLAT',?,?,'OK','PIT',?,
             'champion-v1.0.0',?,?,?, ?,?)`,
  ).bind(
    date, JSON.stringify(FACTORS), JSON.stringify(FACTOR_RESULTS),
    `${date}T12:00:00Z`, 'a'.repeat(64), 'b'.repeat(40),
    `nowcast-${date}`, `${date}T11:59:59Z`, `${date}T12:00:00Z`,
  ).run();
}

async function seedPitRow(
  db: D1Database,
  seriesId: string,
  observationDate: string,
  vintageDate: string,
  fetchedAt: string,
  value: number,
) {
  await db.prepare(
    `INSERT OR IGNORE INTO ingest_runs (run_id,state,mode,started_at)
     VALUES ('dual-horizon-pit','ACTIVE','FULL','2024-01-01T00:00:00Z')`,
  ).run();
  await db.prepare(
    `INSERT INTO observations_pit
      (series_id,observation_date,vintage_date,released_at,fetched_at,tradable_at,
       source,checksum,data_run_id,release_time_status,value)
     VALUES (?,?,?,?,?,?,'ALFRED',?,'dual-horizon-pit','OBSERVED_AT_FETCH',?)`,
  ).bind(
    seriesId, observationDate, vintageDate, fetchedAt, fetchedAt, fetchedAt,
    `${seriesId}-${vintageDate}`, value,
  ).run();
}

describe('dual-horizon PIT inputs', () => {
  it('selects only governed weekly snapshots strictly visible at one cutoff', async () => {
    const { mf, db } = await migratedDb();
    await seedOfficialSnapshot(db, {
      date: '2024-01-03', recordedAt: '2024-01-05T00:00:00Z',
      modelVersion: 'champion-v1.0.0', configHash: 'a'.repeat(64), regime: 'FLAT',
    });
    await seedOfficialSnapshot(db, {
      date: '2024-01-10', recordedAt: '2024-01-12T00:00:00Z',
      modelVersion: 'champion-v1.0.0', configHash: 'a'.repeat(64), regime: 'FLAT',
    });
    await seedProvisionalSnapshot(db, '2024-01-11');

    const atEquality = await loadDualHorizonSnapshotInputs(db, '2024-01-12T00:00:00Z');
    expect(atEquality.snapshots.map(row => row.date)).toEqual(['2024-01-03']);
    const after = await loadDualHorizonSnapshotInputs(db, '2024-01-12T00:00:00.001Z');
    expect(after.snapshots.map(row => row.date)).toEqual(['2024-01-03', '2024-01-10']);
    expect(JSON.stringify(after)).not.toContain('2024-01-11');
    expect(await db.prepare('SELECT COUNT(*) AS n FROM nowcast_snapshot_daily').first())
      .toEqual({ n: 1 });
    await mf.dispose();
  });

  it('returns WTREGEN and hides late vintages and post-cutoff overrides', async () => {
    const { mf, db } = await migratedDb();
    await seedPitRow(db, 'WTREGEN', '2024-01-03', '2024-01-04', '2024-01-05T00:00:00Z', 700);
    await seedPitRow(db, 'WTREGEN', '2024-01-03', '2024-01-11', '2024-01-12T00:00:00Z', 710);
    const old = await loadLiquidityStructureSeries(db, '2024-01-12T00:00:00Z');
    const bounded = await loadDualHorizonLiquiditySeries(db, '2024-01-12T00:00:00Z');
    expect(bounded.seriesMap).toEqual(old.seriesMap);
    expect(old.seriesMap.WTREGEN).toEqual([{ date: '2024-01-03', value: 700 }]);
    const revised = await loadLiquidityStructureSeries(db, '2024-01-12T00:00:00.001Z');
    expect(revised.seriesMap.WTREGEN).toEqual([{ date: '2024-01-03', value: 710 }]);
    await mf.dispose();
  });

  it('fails closed before dual-horizon raw revision work exceeds its sentinel', async () => {
    const { mf, db } = await migratedDb();
    await seedPitRow(db, 'WALCL', '2024-01-03', '2024-01-04', '2024-01-05T00:00:00Z', 7_000);
    await seedPitRow(db, 'WALCL', '2024-01-03', '2024-01-05', '2024-01-06T00:00:00Z', 7_010);
    await seedPitRow(db, 'WALCL', '2024-01-03', '2024-01-06', '2024-01-07T00:00:00Z', 7_020);

    await expect(loadDualHorizonLiquiditySeries(
      db,
      '2024-01-10T00:00:00Z',
      { rawRevisionLimit: 2, selectedRowLimit: 10 },
    )).rejects.toMatchObject({
      name: DualHorizonDomainError.name,
      reason: 'LIQUIDITY_WORK_LIMIT_EXCEEDED',
      asOf: '2024-01-10T00:00:00Z',
      availableDiagnostics: {
        work: 'RAW_REVISIONS',
        limit: 2,
        observedAtLeast: 3,
      },
    });
    await mf.dispose();
  });

  it('replays the complete old-cutoff result after later malformed raw rows and overrides arrive', async () => {
    const { mf, db } = await migratedDb();
    const oldCutoff = '2024-01-10T00:00:00Z';
    await seedPitRow(db, 'WALCL', '2024-01-03', '2024-01-04', '2024-01-05T00:00:00Z', 7_000);

    const resultBeforeLateRevision = await loadDualHorizonLiquiditySeries(db, oldCutoff);

    await seedPitRow(db, 'WALCL', '2024-01-03', '2024-01-11', '2024-01-12T00:00:00Z', 7_100);
    await db.prepare(
      `INSERT INTO release_calendar_overrides
        (series_id,vintage_date,released_at,tradable_at,reason,created_at)
       VALUES ('WALCL','2024-01-04','malformed-late-release','malformed-late-tradable',
               'late malformed correction','2024-01-12T00:00:00Z')`,
    ).run();
    await db.prepare(
      `INSERT INTO observations_pit
        (series_id,observation_date,vintage_date,released_at,fetched_at,tradable_at,
         source,checksum,data_run_id,release_time_status,value)
       VALUES ('SP500','2024-01-03','2024-01-04','malformed-unrelated-release',
               '2024-01-12T00:00:00Z','malformed-unrelated-tradable','ALFRED',
               'unrelated-late','dual-horizon-pit','OBSERVED_AT_FETCH',5000)`,
    ).run();

    const resultAfterLateRevisionAtOldCutoff = await loadDualHorizonLiquiditySeries(db, oldCutoff);
    expect(JSON.stringify(resultAfterLateRevisionAtOldCutoff))
      .toBe(JSON.stringify(resultBeforeLateRevision));
    expect(resultAfterLateRevisionAtOldCutoff).toEqual(resultBeforeLateRevision);
    await mf.dispose();
  });

  it('rejects malformed and future as_of values', async () => {
    const { mf, db } = await migratedDb();
    await expect(loadDualHorizonSnapshotInputs(db, 'bad'))
      .rejects.toBeInstanceOf(DualHorizonRequestError);
    await expect(loadDualHorizonSnapshotInputs(db, '2999-01-01T00:00:00Z'))
      .rejects.toBeInstanceOf(DualHorizonRequestError);
    await mf.dispose();
  });

  it('returns malformed governed snapshot input as a typed domain failure', async () => {
    const { mf, db } = await migratedDb();
    await seedOfficialSnapshot(db, {
      date: '2024-01-03', recordedAt: '2024-01-05T00:00:00Z',
      modelVersion: 'champion-v1.0.0', configHash: 'a'.repeat(64), regime: 'FLAT',
    });
    await db.prepare(
      `UPDATE model_snapshot_weekly
       SET factors_json='{"netliqTrend":'
       WHERE date='2024-01-03'`,
    ).run();

    await expect(loadDualHorizonSnapshotInputs(db, '2024-01-06T00:00:00Z'))
      .rejects.toMatchObject({
        name: DualHorizonDomainError.name,
        reason: 'FORMAL_SNAPSHOT_INVALID',
        asOf: '2024-01-06T00:00:00Z',
      });
    await mf.dispose();
  });
});
