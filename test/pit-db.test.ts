import { describe, expect, it } from 'vitest';
// @ts-ignore Node-only migration fixture.
import { readFileSync } from 'node:fs';
import { Miniflare } from 'miniflare';
import { SERIES_IDS } from '../src/config';

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
