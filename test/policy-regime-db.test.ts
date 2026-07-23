import { describe, expect, it } from 'vitest';
// @ts-ignore Node-only migration fixture.
import { readFileSync } from 'node:fs';
import { Miniflare } from 'miniflare';
import { resolvePolicyRegime } from '../src/db';

const MIGRATIONS = [
  '0001_init.sql', '0002_add_coverage.sql', '0003_meta.sql', '0004_snapshot_quality.sql',
  '0005_official_nowcast.sql', '0006_atomic_ingest.sql', '0007_ingest_snapshot_outcome.sql',
  '0008_point_in_time_observations.sql', '0009_event_time_backtest.sql',
  '0010_model_governance.sql', '0011_policy_regime_events.sql',
];

async function migratedDb() {
  const mf = new Miniflare({
    modules: true, script: 'export default { fetch() { return new Response(); } }', d1Databases: ['DB'],
  });
  const db = await mf.getD1Database('DB') as unknown as D1Database;
  for (const file of MIGRATIONS) {
    const sql = readFileSync(`migrations/${file}`, 'utf8')
      .replace(/^\s*--.*$/gm, '').replace(/\s+/g, ' ');
    await db.exec(sql);
  }
  return { mf, db };
}

const insert = (db: D1Database, row: {
  id: string; key: string; revision: number; status?: 'ACTIVE' | 'RETRACTED'; supersedes?: string | null;
  from?: string; to?: string | null; regime?: string; published?: string; created?: string;
}) => db.prepare(`INSERT INTO policy_regime_events
  (event_id,event_key,revision,status,supersedes_event_id,effective_from,effective_to,regime,
   source_document,source_published_at,approved_by,created_at)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
  row.id, row.key, row.revision, row.status ?? 'ACTIVE', row.supersedes ?? null,
  row.from ?? '2024-01-01', row.to ?? '2025-01-01', row.regime ?? 'QE',
  'https://www.federalreserve.gov/example.htm', row.published ?? '2023-12-15T19:00:00Z',
  'research-governance', row.created ?? '2023-12-16T00:00:00Z',
).run();

describe('append-only policy regime events', () => {
  it('has no guessed seed rows and rejects mutation, deletion, and broken revision lineage', async () => {
    const { mf, db } = await migratedDb();
    expect(await db.prepare('SELECT COUNT(*) AS n FROM policy_regime_events').first()).toEqual({ n: 0 });
    await insert(db, { id: 'qe-v1', key: 'qe-cycle', revision: 1 });
    await expect(db.prepare("UPDATE policy_regime_events SET regime='QT'").run()).rejects.toThrow(/append-only/i);
    await expect(db.prepare('DELETE FROM policy_regime_events').run()).rejects.toThrow(/append-only/i);
    await expect(insert(db, { id: 'qe-v3', key: 'qe-cycle', revision: 3, supersedes: 'qe-v1' }))
      .rejects.toThrow(/revision|lineage/i);
    await expect(insert(db, { id: 'new-v2', key: 'new-cycle', revision: 2, supersedes: 'qe-v1' }))
      .rejects.toThrow(/revision|lineage/i);
    await mf.dispose();
  }, 30_000);

  it('resolves only the latest revision visible at both system and decision clocks', async () => {
    const { mf, db } = await migratedDb();
    await insert(db, { id: 'qe-v1', key: 'qe-cycle', revision: 1 });
    await insert(db, {
      id: 'qe-v2', key: 'qe-cycle', revision: 2, status: 'RETRACTED', supersedes: 'qe-v1',
      created: '2024-06-01T00:00:00Z', published: '2024-05-31T19:00:00Z',
    });
    await expect(resolvePolicyRegime(db, {
      decisionDate: '2024-03-01', decisionAt: '2024-03-01T20:00:00Z', asOfCutoff: '2024-03-02T00:00:00Z',
    })).resolves.toMatchObject({ status: 'OK', regime: 'QE', eventId: 'qe-v1' });
    await expect(resolvePolicyRegime(db, {
      decisionDate: '2024-07-01', decisionAt: '2024-07-01T20:00:00Z', asOfCutoff: '2024-07-02T00:00:00Z',
    })).resolves.toEqual({ status: 'POLICY_REGIME_UNAVAILABLE', reason: 'NO_VISIBLE_ACTIVE_EVENT' });
    await mf.dispose();
  }, 30_000);

  it('fails closed on overlapping visible active regimes and ignores future-created/source-late rows', async () => {
    const { mf, db } = await migratedDb();
    await insert(db, { id: 'qe-v1', key: 'qe-cycle', revision: 1 });
    await insert(db, { id: 'qt-v1', key: 'qt-cycle', revision: 1, regime: 'QT', from: '2024-06-01', to: null });
    await expect(resolvePolicyRegime(db, {
      decisionDate: '2024-07-01', decisionAt: '2024-07-01T20:00:00Z', asOfCutoff: '2024-07-02T00:00:00Z',
    })).rejects.toThrow(/overlap/i);

    const { mf: mf2, db: db2 } = await migratedDb();
    await insert(db2, { id: 'future-created', key: 'future', revision: 1, created: '2024-08-01T00:00:00Z' });
    await insert(db2, { id: 'source-late', key: 'late', revision: 1, published: '2024-07-02T20:00:00Z' });
    await expect(resolvePolicyRegime(db2, {
      decisionDate: '2024-07-01', decisionAt: '2024-07-01T20:00:00Z', asOfCutoff: '2024-07-02T00:00:00Z',
    })).resolves.toEqual({ status: 'POLICY_REGIME_UNAVAILABLE', reason: 'NO_VISIBLE_ACTIVE_EVENT' });
    await mf.dispose();
    await mf2.dispose();
  }, 30_000);
});
