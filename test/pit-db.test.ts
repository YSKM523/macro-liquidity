import { describe, expect, it } from 'vitest';
// @ts-ignore Node-only migration fixture.
import { readFileSync } from 'node:fs';
import { Miniflare } from 'miniflare';
import { SERIES_IDS } from '../src/config';
import { activateIngestRun, officialPitDecisionEvents, stagePitObservations } from '../src/db';

async function migratedDb() {
  const mf = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response(); } }',
    d1Databases: ['DB'],
  });
  const db = await mf.getD1Database('DB') as unknown as D1Database;
  for (let i = 1; i <= 8; i++) {
    const name = String(i).padStart(4, '0');
    const file = ({
      '0001': '0001_init.sql', '0002': '0002_add_coverage.sql', '0003': '0003_meta.sql',
      '0004': '0004_snapshot_quality.sql', '0005': '0005_official_nowcast.sql',
      '0006': '0006_atomic_ingest.sql', '0007': '0007_ingest_snapshot_outcome.sql',
      '0008': '0008_point_in_time_observations.sql',
    } as Record<string, string>)[name];
    const sql = readFileSync(`migrations/${file}`, 'utf8')
      .replace(/^\s*--.*$/gm, '')
      .replace(/\s+/g, ' ');
    await db.exec(sql);
  }
  return { mf, db };
}

describe('point-in-time schema', () => {
  it('makes raw vintages and official manifests append-only and records revisions', async () => {
    const { mf, db } = await migratedDb();
    await db.prepare("INSERT INTO ingest_runs (run_id,state,mode,started_at) VALUES ('pit-run','RUNNING','FULL','2024-01-01T00:00:00Z')").run();
    const insert = `INSERT INTO observations_pit
      (series_id,observation_date,vintage_date,released_at,fetched_at,tradable_at,source,checksum,data_run_id,release_time_status,value)
      VALUES ('WALCL','2023-12-27',?,'2024-01-01T23:59:59Z','2024-01-02T00:00:00Z','2024-01-02T14:30:00Z','ALFRED',?,'pit-run','CONSERVATIVE_DATE_END',?)`;
    await db.prepare(insert).bind('2024-01-01', 'a', 1).run();
    await db.prepare(insert).bind('2024-01-08', 'b', 2).run();
    await expect(db.prepare("UPDATE observations_pit SET value=3 WHERE checksum='a'").run()).rejects.toThrow(/append-only/i);
    await expect(db.prepare("DELETE FROM observations_pit WHERE checksum='a'").run()).rejects.toThrow(/append-only/i);
    await expect(db.prepare(insert).bind('2024-01-01', 'other', 9).run()).rejects.toThrow();
    await expect(db.prepare("SELECT old_value,new_value,revision_delta FROM observation_revisions WHERE vintage_date='2024-01-08'").first())
      .resolves.toEqual({ old_value: 1, new_value: 2, revision_delta: 1 });

    await db.prepare(`INSERT INTO snapshot_inputs
      (snapshot_channel,decision_week,snapshot_date,data_run_id,series_id,input_status)
      VALUES ('OFFICIAL','2024-01-01','2024-01-03','pit-run','SP500','MISSING')`).run();
    await expect(db.prepare("UPDATE snapshot_inputs SET snapshot_date='2024-01-04'").run()).rejects.toThrow(/append-only/i);
    await expect(db.prepare('DELETE FROM snapshot_inputs').run()).rejects.toThrow(/append-only/i);

    const seeded = await db.prepare('SELECT series_id FROM release_calendar ORDER BY series_id').all<{series_id:string}>();
    expect(seeded.results?.map(row => row.series_id)).toEqual([...SERIES_IDS].sort());
    const columns = await db.prepare("PRAGMA table_info('model_snapshot_weekly')").all<{name:string}>();
    expect(columns.results?.map(row => row.name)).toEqual(expect.arrayContaining([
      'data_run_id', 'data_cutoff', 'decision_at', 'tradable_at', 'pit_status',
    ]));
    await mf.dispose();
  });
});

describe('PIT activation repository', () => {
  it('stages and atomically promotes PIT rows while deriving WALCL decision events from the initial vintage', async () => {
    const { mf, db } = await migratedDb();
    await db.batch([
      db.prepare("INSERT INTO ingest_runs (run_id,state,mode,started_at) VALUES ('run-1','RUNNING','FULL','2024-01-01T00:00:00Z')"),
      db.prepare("INSERT INTO ingest_series_attempts (run_id,series_id,status,started_at,row_count) VALUES ('run-1','WALCL','SUCCEEDED','2024-01-01T00:00:00Z',1)"),
      db.prepare("INSERT INTO staging_observations VALUES ('run-1','WALCL','2023-12-27',5800)"),
      db.prepare("INSERT INTO ingest_lock VALUES ('fred_ingest','run-1',strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now','+60 seconds'))"),
    ]);
    const base = {
      seriesId: 'WALCL', observationDate: '2023-12-27', vintageDate: '2024-01-04',
      releasedAt: '2024-01-04T23:59:59Z', fetchedAt: '2024-01-10T12:00:00Z',
      tradableAt: '2024-01-05T14:30:00Z', source: 'ALFRED' as const, checksum: 'c1',
      releaseTimeStatus: 'CONSERVATIVE_DATE_END' as const, value: 5800,
    };
    await stagePitObservations(db, 'run-1', [base]);
    await activateIngestRun(db, 'run-1', '2024-01-10T12:01:00Z');
    expect(await db.prepare('SELECT value FROM observations_pit').first()).toEqual({ value: 5800 });
    expect(await officialPitDecisionEvents(db)).toEqual([{
      modelDate: '2023-12-27', decisionAt: base.releasedAt, tradableAt: base.tradableAt,
    }]);
    await mf.dispose();
  });

  it('replays identical vintages idempotently and rolls back a conflicting vintage without switching ACTIVE', async () => {
    const { mf, db } = await migratedDb();
    const row = {
      seriesId: 'WALCL', observationDate: '2023-12-27', vintageDate: '2024-01-04',
      releasedAt: '2024-01-04T23:59:59Z', fetchedAt: '2024-01-10T12:00:00Z',
      tradableAt: '2024-01-05T14:30:00Z', source: 'ALFRED' as const, checksum: 'same',
      releaseTimeStatus: 'CONSERVATIVE_DATE_END' as const, value: 5800,
    };
    for (const runId of ['run-1', 'run-2']) {
      await db.prepare('INSERT INTO ingest_runs (run_id,state,mode,started_at) VALUES (?,\'RUNNING\',\'FULL\',?)')
        .bind(runId, `2024-01-0${runId === 'run-1' ? '1' : '2'}T00:00:00Z`).run();
      await db.prepare(`INSERT INTO ingest_lock VALUES
        ('fred_ingest',?,strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now','+60 seconds'))
        ON CONFLICT(lock_name) DO UPDATE SET owner_run_id=excluded.owner_run_id,expires_at=excluded.expires_at`).bind(runId).run();
      await stagePitObservations(db, runId, [row]);
      await activateIngestRun(db, runId, '2024-01-10T12:01:00Z');
    }
    expect(await db.prepare('SELECT COUNT(*) AS n FROM observations_pit').first()).toEqual({ n: 1 });
    expect(await db.prepare("SELECT run_id FROM ingest_runs WHERE state='ACTIVE'").first()).toEqual({ run_id: 'run-2' });

    await db.prepare("INSERT INTO ingest_runs (run_id,state,mode,started_at) VALUES ('run-3','RUNNING','FULL','2024-01-03T00:00:00Z')").run();
    await db.prepare("UPDATE ingest_lock SET owner_run_id='run-3',expires_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','+60 seconds')").run();
    await stagePitObservations(db, 'run-3', [{ ...row, checksum: 'different', value: 9999 }]);
    await expect(activateIngestRun(db, 'run-3', '2024-01-10T12:02:00Z')).rejects.toThrow(/conflict|activation/i);
    expect(await db.prepare('SELECT value,checksum FROM observations_pit').first()).toEqual({ value: 5800, checksum: 'same' });
    expect(await db.prepare("SELECT run_id FROM ingest_runs WHERE state='ACTIVE'").first()).toEqual({ run_id: 'run-2' });
    expect(await db.prepare("SELECT state FROM ingest_runs WHERE run_id='run-3'").first()).toEqual({ state: 'RUNNING' });
    await mf.dispose();
  });

  it.each(['transferred', 'expired'] as const)('does not promote PIT staging under a %s lease', async leaseState => {
    const { mf, db } = await migratedDb();
    await db.prepare("INSERT INTO ingest_runs (run_id,state,mode,started_at) VALUES ('target','RUNNING','FULL','2024-01-01T00:00:00Z')").run();
    await db.prepare(`INSERT INTO ingest_lock VALUES
      ('fred_ingest',?,strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now',?))`)
      .bind(leaseState === 'transferred' ? 'replacement' : 'target', leaseState === 'expired' ? '-1 second' : '+60 seconds').run();
    await stagePitObservations(db, 'target', [{
      seriesId: 'WALCL', observationDate: '2023-12-27', vintageDate: '2024-01-04',
      releasedAt: '2024-01-04T23:59:59Z', fetchedAt: '2024-01-10T12:00:00Z',
      tradableAt: '2024-01-05T14:30:00Z', source: 'ALFRED', checksum: 'same',
      releaseTimeStatus: 'CONSERVATIVE_DATE_END', value: 5800,
    }]);
    await expect(activateIngestRun(db, 'target', '2024-01-10T12:01:00Z')).rejects.toThrow(/lease|fence|activation/i);
    expect(await db.prepare('SELECT COUNT(*) AS n FROM observations_pit').first()).toEqual({ n: 0 });
    await mf.dispose();
  });
});
