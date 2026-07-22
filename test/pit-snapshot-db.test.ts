import { describe, expect, it } from 'vitest';
// @ts-ignore Node-only migration fixture.
import { readFileSync } from 'node:fs';
import { Miniflare } from 'miniflare';
import { SERIES_IDS } from '../src/config';
import { loadEventBacktestInputs, upsertNowcastSnapshot, upsertOfficialSnapshot } from '../src/db';
import type { SnapshotInput } from '../src/pit';

const snapshot = {
  date: '2024-01-03', walcl: 5800, tga: 700, rrp: 100, repo: 0, netliq: 5000,
  netliqTrend: 4900, sofrIorb: 0, hyOas: 3, dgs10: 4, dxy: 100, vix: 15,
  bsImpulse: 'FLAT', netliqDir: 'UP', verdict: 'BULLISH', score: 60,
  factors: {}, factorResults: {}, freshness: {}, decisionStatus: 'OK',
  p0: true, p1: true, p2: true, p3: true, reason: 'pit', coverage: 1,
} as any;

async function migratedDb() {
  const mf = new Miniflare({ modules: true, script: 'export default { fetch(){return new Response()} }', d1Databases: ['DB'] });
  const db = await mf.getD1Database('DB') as unknown as D1Database;
  const files = [
    '0001_init.sql', '0002_add_coverage.sql', '0003_meta.sql', '0004_snapshot_quality.sql',
    '0005_official_nowcast.sql', '0006_atomic_ingest.sql', '0007_ingest_snapshot_outcome.sql',
    '0008_point_in_time_observations.sql', '0009_event_time_backtest.sql',
    '0010_model_governance.sql',
  ];
  for (const file of files) {
    const sql = readFileSync(`migrations/${file}`, 'utf8').replace(/^\s*--.*$/gm, '').replace(/\s+/g, ' ');
    await db.exec(sql);
  }
  await db.batch([
    db.prepare("INSERT INTO ingest_runs (run_id,state,mode,started_at) VALUES ('run-1','ACTIVE','FULL','2024-01-10T00:00:00Z')"),
    db.prepare("INSERT INTO ingest_lock VALUES ('fred_ingest','run-1',strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now','+60 seconds'))"),
  ]);
  return { mf, db };
}

function manifest(): SnapshotInput[] {
  return SERIES_IDS.map(seriesId => seriesId === 'WALCL' ? {
    seriesId, inputStatus: 'AVAILABLE', observationDate: '2024-01-03', vintageDate: '2024-01-04',
    releasedAt: '2024-01-04T23:59:59Z', fetchedAt: '2024-01-10T00:00:00Z',
    tradableAt: '2024-01-05T14:30:00Z', source: 'ALFRED', checksum: 'walcl',
    releaseTimeStatus: 'CONSERVATIVE_DATE_END', value: 5800,
  } : {
    seriesId, inputStatus: 'MISSING', observationDate: null, vintageDate: null, releasedAt: null,
    fetchedAt: null, tradableAt: null, source: null, checksum: null, releaseTimeStatus: null, value: null,
  });
}

describe('official PIT snapshot persistence', () => {
  it('freezes a PIT row against a legacy no-provenance write and preserves its as-of replay', async () => {
    const { mf, db } = await migratedDb();
    const provenance = {
      dataRunId: 'run-1', dataCutoff: '2024-01-04T23:59:59Z',
      decisionAt: '2024-01-05T00:00:00Z', tradableAt: '2024-01-05T14:30:00Z',
      releaseResolutionAt: '2024-01-10T00:00:00Z', inputs: manifest(),
    };
    await upsertOfficialSnapshot(db, 'run-1', snapshot, 4700, provenance);

    let beforeReplay = await loadEventBacktestInputs(db);
    for (let attempt = 0; beforeReplay.signals.length === 0 && attempt < 50; attempt += 1) {
      beforeReplay = await loadEventBacktestInputs(db);
    }
    expect(beforeReplay.signals).toHaveLength(1);
    const cutoff = beforeReplay.asOfCutoff;
    const beforeRow = await db.prepare(`SELECT date,decision_week,score,pit_status,data_run_id,recorded_at
      FROM model_snapshot_weekly WHERE decision_week='2024-01-01'`).first();

    const outcome = await upsertOfficialSnapshot(db, 'run-1', { ...snapshot, score: 1 }, 1);

    expect(await db.prepare(`SELECT date,decision_week,score,pit_status,data_run_id,recorded_at
      FROM model_snapshot_weekly WHERE decision_week='2024-01-01'`).first()).toEqual(beforeRow);
    expect(await loadEventBacktestInputs(db, cutoff)).toEqual(beforeReplay);
    expect(outcome).toBe('FROZEN');
    await mf.dispose();
  }, 15000);

  it('atomically stores a complete manifest, freezes it, and gives nowcasts provenance without a manifest', async () => {
    const { mf, db } = await migratedDb();
    const provenance = {
      dataRunId: 'run-1', dataCutoff: '2024-01-04T23:59:59Z',
      decisionAt: '2024-01-05T00:00:00Z', tradableAt: '2024-01-05T14:30:00Z',
      releaseResolutionAt: '2024-01-10T00:00:00Z', inputs: manifest(),
    };
    await expect(upsertOfficialSnapshot(db, 'run-1', snapshot, 4700, provenance)).resolves.toBe('INSERTED');
    expect(await db.prepare('SELECT COUNT(*) AS n FROM snapshot_inputs').first()).toEqual({ n: SERIES_IDS.length });
    const stored = await db.prepare('SELECT data_run_id,data_cutoff,decision_at,tradable_at,release_resolution_at,pit_status,recorded_at FROM model_snapshot_weekly').first<any>();
    expect(stored).toMatchObject({ data_run_id: 'run-1', data_cutoff: provenance.dataCutoff, decision_at: provenance.decisionAt,
      tradable_at: provenance.tradableAt, release_resolution_at: provenance.releaseResolutionAt, pit_status: 'PIT' });
    expect(stored.recorded_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/);

    await expect(upsertOfficialSnapshot(db, 'run-1', { ...snapshot, score: 1 }, 1, {
      ...provenance, dataCutoff: '2024-01-09T00:00:00Z',
    })).resolves.toBe('FROZEN');
    expect(await db.prepare('SELECT score FROM model_snapshot_weekly').first()).toEqual({ score: 60 });

    await upsertNowcastSnapshot(db, 'run-1', { ...snapshot, date: '2024-01-10' }, 4800, {
      dataRunId: 'run-1', dataCutoff: provenance.dataCutoff,
      decisionAt: '2024-01-10T12:00:00Z', tradableAt: '2024-01-10T12:00:00Z',
      releaseResolutionAt: '2024-01-10T00:00:00Z',
    });
    expect(await db.prepare('SELECT data_run_id,release_resolution_at,pit_status FROM nowcast_snapshot_daily').first())
      .toEqual({
        data_run_id: 'run-1', release_resolution_at: provenance.releaseResolutionAt, pit_status: 'PIT',
      });
    expect(await db.prepare('SELECT COUNT(*) AS n FROM snapshot_inputs').first()).toEqual({ n: SERIES_IDS.length });
    await mf.dispose();
  }, 15000);

  it('rejects a future vintage before writing any official row', async () => {
    const { mf, db } = await migratedDb();
    const inputs = manifest();
    const walcl = inputs[0];
    if (walcl.inputStatus === 'AVAILABLE') walcl.releasedAt = '2024-01-06T00:00:00Z';
    await expect(upsertOfficialSnapshot(db, 'run-1', snapshot, 4700, {
      dataRunId: 'run-1', dataCutoff: null, decisionAt: '2024-01-05T00:00:00Z',
      tradableAt: '2024-01-05T14:30:00Z', releaseResolutionAt: '2024-01-10T00:00:00Z', inputs,
    })).rejects.toThrow(/future/i);
    expect(await db.prepare('SELECT COUNT(*) AS n FROM model_snapshot_weekly').first()).toEqual({ n: 0 });
    await mf.dispose();
  }, 15000);

  it('rejects run provenance mismatches and future observation dates', async () => {
    const { mf, db } = await migratedDb();
    const inputs = manifest();
    const walcl = inputs[0];
    if (walcl.inputStatus === 'AVAILABLE') walcl.observationDate = '2024-01-04';
    await expect(upsertOfficialSnapshot(db, 'run-1', snapshot, 4700, {
      dataRunId: 'another-run', dataCutoff: null, decisionAt: '2024-01-05T00:00:00Z',
      tradableAt: '2024-01-05T14:30:00Z', releaseResolutionAt: '2024-01-10T00:00:00Z', inputs,
    })).rejects.toThrow(/run/i);
    await expect(upsertOfficialSnapshot(db, 'run-1', snapshot, 4700, {
      dataRunId: 'run-1', dataCutoff: null, decisionAt: '2024-01-05T00:00:00Z',
      tradableAt: '2024-01-05T14:30:00Z', releaseResolutionAt: '2024-01-10T00:00:00Z', inputs,
    })).rejects.toThrow(/observation/i);
    await expect(upsertNowcastSnapshot(db, 'run-1', snapshot, 4700, {
      dataRunId: 'another-run', dataCutoff: null, decisionAt: '2024-01-05T00:00:00Z',
      tradableAt: '2024-01-05T14:30:00Z', releaseResolutionAt: '2024-01-10T00:00:00Z',
    })).rejects.toThrow(/run/i);
    await mf.dispose();
  }, 15000);

  it('rejects an official manifest input that is not tradable by the declared snapshot time', async () => {
    const { mf, db } = await migratedDb();
    const inputs = manifest();
    const walcl = inputs[0];
    if (walcl.inputStatus === 'AVAILABLE') walcl.tradableAt = '2024-01-08T14:30:00Z';
    await expect(upsertOfficialSnapshot(db, 'run-1', snapshot, 4700, {
      dataRunId: 'run-1', dataCutoff: null, decisionAt: '2024-01-05T00:00:00Z',
      tradableAt: '2024-01-05T14:30:00Z', releaseResolutionAt: '2024-01-10T00:00:00Z', inputs,
    })).rejects.toThrow(/tradable/i);
    expect(await db.prepare('SELECT COUNT(*) AS n FROM model_snapshot_weekly').first()).toEqual({ n: 0 });
    await mf.dispose();
  }, 15000);

  it('upgrades a legacy row once and rolls the snapshot update back when its manifest insert fails', async () => {
    const { mf, db } = await migratedDb();
    await db.prepare("INSERT INTO model_snapshot_weekly (date,decision_week,score,pit_status) VALUES ('2024-01-03','2024-01-01',50,'LEGACY_NON_PIT')").run();
    await db.prepare(`INSERT INTO snapshot_inputs
      (snapshot_channel,decision_week,snapshot_date,data_run_id,series_id,input_status)
      VALUES ('OFFICIAL','2024-01-01','2024-01-03','run-1','WALCL','MISSING')`).run();
    const provenance = {
      dataRunId: 'run-1', dataCutoff: '2024-01-04T23:59:59Z',
      decisionAt: '2024-01-05T00:00:00Z', tradableAt: '2024-01-05T14:30:00Z',
      releaseResolutionAt: '2024-01-10T00:00:00Z', inputs: manifest(),
    };
    await expect(upsertOfficialSnapshot(db, 'run-1', snapshot, 4700, provenance)).rejects.toThrow(/atomic/i);
    expect(await db.prepare("SELECT score,pit_status FROM model_snapshot_weekly WHERE decision_week='2024-01-01'").first())
      .toEqual({ score: 50, pit_status: 'LEGACY_NON_PIT' });

    const next = { ...snapshot, date: '2024-01-10' };
    await db.prepare("INSERT INTO model_snapshot_weekly (date,decision_week,score,pit_status) VALUES ('2024-01-10','2024-01-08',50,'LEGACY_NON_PIT')").run();
    await expect(upsertOfficialSnapshot(db, 'run-1', next, 4750, {
      ...provenance, decisionAt: '2024-01-11T00:00:00Z', tradableAt: '2024-01-11T14:30:00Z',
    })).resolves.toBe('UPGRADED_LEGACY');
    expect(await db.prepare("SELECT pit_status FROM model_snapshot_weekly WHERE decision_week='2024-01-08'").first())
      .toEqual({ pit_status: 'PIT' });
    await mf.dispose();
  }, 15000);

  it('freezes an existing PIT row even when its data_run_id is abnormally null', async () => {
    const { mf, db } = await migratedDb();
    await db.prepare(`INSERT INTO model_snapshot_weekly
      (date,decision_week,score,pit_status,data_run_id)
      VALUES ('2024-01-03','2024-01-01',50,'PIT',NULL)`).run();
    const provenance = {
      dataRunId: 'run-1', dataCutoff: '2024-01-04T23:59:59Z',
      decisionAt: '2024-01-05T00:00:00Z', tradableAt: '2024-01-05T14:30:00Z',
      releaseResolutionAt: '2024-01-10T00:00:00Z', inputs: manifest(),
    };
    await expect(upsertOfficialSnapshot(db, 'run-1', { ...snapshot, score: 99 }, 4700, provenance))
      .resolves.toBe('FROZEN');
    expect(await db.prepare('SELECT score,data_run_id FROM model_snapshot_weekly').first())
      .toEqual({ score: 50, data_run_id: null });
    await mf.dispose();
  }, 15000);
});
