import { describe, expect, it, vi } from 'vitest';
// The project tsconfig intentionally only loads Workers types; this test runs in Vitest's Node runtime.
// @ts-ignore
import { existsSync, readFileSync } from 'node:fs';
import { Miniflare } from 'miniflare';
import * as ingestDb from '../src/db';

describe('ingest repository contracts', () => {
  it('exposes atomic lock and validation operations', () => {
    expect(typeof (ingestDb as any).acquireIngestLock).toBe('function');
    expect(typeof (ingestDb as any).releaseIngestLock).toBe('function');
    expect(typeof (ingestDb as any).renewIngestLock).toBe('function');
    expect(typeof (ingestDb as any).validateSeriesAttempts).toBe('function');
    expect(typeof (ingestDb as any).startSeriesAttempt).toBe('function');
    expect(typeof (ingestDb as any).failSeriesAttempt).toBe('function');
    expect(typeof (ingestDb as any).completeIngestSnapshots).toBe('function');
    expect(typeof (ingestDb as any).failIngestSnapshots).toBe('function');
    expect((ingestDb as any).upsertObservations).toBeUndefined();
  });

  it('distinguishes a successful zero-row existing series from an unattempted series', () => {
    const validate = (ingestDb as any).validateSeriesAttempts;
    expect(typeof validate).toBe('function');
    if (typeof validate !== 'function') return;

    expect(() => validate(
      ['CURRENT'],
      [{ seriesId: 'CURRENT', status: 'SUCCEEDED', rowCount: 0 }],
      new Set(['CURRENT']),
    )).not.toThrow();
    expect(() => validate(['MISSING'], [], new Set(['MISSING']))).toThrow(/MISSING.*attempt/i);
    expect(() => validate(
      ['NEW'],
      [{ seriesId: 'NEW', status: 'SUCCEEDED', rowCount: 0 }],
      new Set(),
    )).toThrow(/NEW.*empty/i);
  });

  it('uses one conditional statement for lock acquisition and owner-scoped release', async () => {
    expect(typeof (ingestDb as any).acquireIngestLock).toBe('function');
    if (typeof (ingestDb as any).acquireIngestLock !== 'function') return;
    const calls: Array<{ sql: string; binds: unknown[] }> = [];
    const db = {
      prepare(sql: string) {
        const entry = { sql, binds: [] as unknown[] };
        calls.push(entry);
        return {
          bind(...values: unknown[]) { entry.binds = values; return this; },
          run: vi.fn(async () => ({ meta: { changes: sql.startsWith('INSERT') ? 0 : 1 } })),
        };
      },
    } as unknown as D1Database;

    await expect((ingestDb as any).acquireIngestLock(db, 'run-2', '2024-01-01T00:00:00Z', '2024-01-01T00:05:00Z')).resolves.toBe(false);
    await expect((ingestDb as any).releaseIngestLock(db, 'run-2')).resolves.toBe(true);
    expect(calls[0].sql).toMatch(/ON CONFLICT[\s\S]*expires_at\s*<=/i);
    expect(calls[1].sql).toMatch(/DELETE[\s\S]*owner_run_id\s*=\s*\?/i);
  });

  it('allows an expired lease to be acquired while rejecting a second valid lease', async () => {
    expect(typeof (ingestDb as any).acquireIngestLock).toBe('function');
    if (typeof (ingestDb as any).acquireIngestLock !== 'function') return;
    const changes = [1, 0, 1];
    const db = {
      prepare: vi.fn(() => ({
        bind() { return this; },
        run: vi.fn(async () => ({ meta: { changes: changes.shift() } })),
      })),
    } as unknown as D1Database;

    await expect((ingestDb as any).acquireIngestLock(db, 'run-1', 't0', 't5')).resolves.toBe(true);
    await expect((ingestDb as any).acquireIngestLock(db, 'run-2', 't1', 't6')).resolves.toBe(false);
    await expect((ingestDb as any).acquireIngestLock(db, 'run-2', 't7', 't12')).resolves.toBe(true);
  });

  it('cannot release a lock owned by another run', async () => {
    const db = {
      prepare: vi.fn(() => ({
        bind() { return this; },
        run: vi.fn(async () => ({ meta: { changes: 0 } })),
      })),
    } as unknown as D1Database;

    await expect((ingestDb as any).releaseIngestLock(db, 'not-the-owner')).resolves.toBe(false);
  });

  it('renews only the owning run lease', async () => {
    expect(typeof (ingestDb as any).renewIngestLock).toBe('function');
    if (typeof (ingestDb as any).renewIngestLock !== 'function') return;
    const calls: Array<{ sql: string; binds: unknown[] }> = [];
    const db = {
      prepare(sql: string) {
        const call = { sql, binds: [] as unknown[] };
        calls.push(call);
        return {
          bind(...values: unknown[]) { call.binds = values; return this; },
          run: vi.fn(async () => ({ meta: { changes: 0 } })),
        };
      },
    } as unknown as D1Database;

    await expect((ingestDb as any).renewIngestLock(db, 'not-the-owner', 't1', 't6')).resolves.toBe(false);
    expect(calls[0].sql).toMatch(/UPDATE ingest_lock[\s\S]*owner_run_id\s*=\s*\?/i);
  });

  it('promotes observations and switches ACTIVE with exactly one D1 batch', async () => {
    const statements: Array<{ sql: string; binds: unknown[] }> = [];
    const batch = vi.fn(async (_statements: D1PreparedStatement[]) => [
      { meta: { changes: 1 } }, { meta: { changes: 1 } }, { meta: { changes: 1 } },
    ]);
    const db = {
      prepare(sql: string) {
        const statement = { sql, binds: [] as unknown[] };
        statements.push(statement);
        return { bind(...values: unknown[]) { statement.binds = values; return this; } };
      },
      batch,
    } as unknown as D1Database;

    await (ingestDb as any).activateIngestRun(db, 'run-1', '2024-01-01T00:05:00Z');

    expect(batch).toHaveBeenCalledTimes(1);
    expect(batch.mock.calls[0][0]).toHaveLength(3);
    expect(statements[0].sql).toMatch(/INSERT INTO observations[\s\S]*staging_observations/i);
    expect(statements[0].sql).toMatch(/EXISTS[\s\S]*state\s*=\s*'RUNNING'/i);
    expect(statements[1].sql).toMatch(/SUPERSEDED[\s\S]*ACTIVE/i);
    expect(statements[1].sql).toMatch(/EXISTS[\s\S]*state\s*=\s*'RUNNING'/i);
    expect(statements[2].sql).toMatch(/state = 'ACTIVE'/i);
  });

  it.each(['missing', 'FAILED'] as const)(
    'executes activation guards so a %s target cannot promote rows or demote ACTIVE',
    async targetState => {
      const mf = new Miniflare({
        modules: true,
        script: 'export default { fetch() { return new Response(); } }',
        d1Databases: ['DB'],
      });
      const db = await mf.getD1Database('DB') as unknown as D1Database;
      const setup = [
        'CREATE TABLE observations (series_id TEXT, date TEXT, value REAL, PRIMARY KEY(series_id, date))',
        `CREATE TABLE ingest_runs (
          run_id TEXT PRIMARY KEY, state TEXT, completed_at TEXT, row_count INTEGER DEFAULT 0,
          series_count INTEGER DEFAULT 0, snapshot_state TEXT DEFAULT 'PENDING',
          snapshot_completed_at TEXT, snapshot_error TEXT, snapshot_count INTEGER DEFAULT 0
        )`,
        'CREATE TABLE ingest_series_attempts (run_id TEXT, series_id TEXT, status TEXT)',
        'CREATE TABLE staging_observations (run_id TEXT, series_id TEXT, date TEXT, value REAL)',
        "INSERT INTO observations VALUES ('OLD', '2024-01-01', 1)",
        "INSERT INTO ingest_runs (run_id, state) VALUES ('old-active', 'ACTIVE')",
        "INSERT INTO staging_observations VALUES ('target', 'NEW', '2024-01-02', 2)",
        ...(targetState === 'FAILED'
          ? ["INSERT INTO ingest_runs (run_id, state) VALUES ('target', 'FAILED')"]
          : []),
      ];
      await db.batch(setup.map(sql => db.prepare(sql)));

      await expect((ingestDb as any).activateIngestRun(db, 'target', '2024-01-01T00:05:00Z'))
        .rejects.toThrow(/RUNNING/i);
      await expect(db.prepare('SELECT series_id FROM observations ORDER BY series_id').all())
        .resolves.toMatchObject({ results: [{ series_id: 'OLD' }] });
      await expect(db.prepare("SELECT state FROM ingest_runs WHERE run_id = 'old-active'").first())
        .resolves.toEqual({ state: 'ACTIVE' });
      await mf.dispose();
    },
  );

  it('persists terminal series-attempt and snapshot outcomes with supplied completion timestamps', async () => {
    const calls: Array<{ sql: string; binds: unknown[] }> = [];
    const db = {
      prepare(sql: string) {
        const call = { sql, binds: [] as unknown[] };
        calls.push(call);
        return {
          bind(...values: unknown[]) { call.binds = values; return this; },
          run: vi.fn(async () => ({ meta: { changes: 1 } })),
        };
      },
    } as unknown as D1Database;

    await (ingestDb as any).startSeriesAttempt(db, 'run-1', 'WALCL', '2024-01-01T00:01:00Z');
    await (ingestDb as any).failSeriesAttempt(db, 'run-1', 'WALCL', 'fetch failed', '2024-01-01T00:02:00Z');
    await (ingestDb as any).completeIngestSnapshots(db, 'run-1', 3, '2024-01-01T00:03:00Z');
    await (ingestDb as any).failIngestSnapshots(
      db, 'run-2', { step: 'metadata', error: 'meta failed', snapshotCount: 2 }, '2024-01-01T00:04:00Z',
    );

    expect(calls[0].sql).toMatch(/INSERT INTO ingest_series_attempts[\s\S]*RUNNING/i);
    expect(calls[0].binds).toContain('2024-01-01T00:01:00Z');
    expect(calls[1].sql).toMatch(/status\s*=\s*'FAILED'[\s\S]*completed_at/i);
    expect(calls[1].binds).toContain('2024-01-01T00:02:00Z');
    expect(calls[2].sql).toMatch(/snapshot_state\s*=\s*'SUCCEEDED'/i);
    expect(calls[2].binds).toContain('2024-01-01T00:03:00Z');
    expect(calls[3].sql).toMatch(/snapshot_state\s*=\s*'FAILED'/i);
    expect(calls[3].binds).toContain('2024-01-01T00:04:00Z');
    expect(calls[3].binds).toContain(2);
  });

  it('includes the durable snapshot outcome in ACTIVE and FAILED run summaries', async () => {
    const sql: string[] = [];
    const db = {
      prepare(query: string) {
        sql.push(query);
        return { first: vi.fn(async () => null) };
      },
    } as unknown as D1Database;

    await (ingestDb as any).ingestRunSummary(db);

    expect(sql).toHaveLength(2);
    for (const query of sql) {
      expect(query).toMatch(/snapshot_state/i);
      expect(query).toMatch(/snapshot_completed_at/i);
      expect(query).toMatch(/snapshot_error/i);
      expect(query).toMatch(/snapshot_count/i);
    }
  });
});

describe('PR-06 migration', () => {
  it('defines run, attempt, staging, ACTIVE-state, and lock structures without dropping production tables', () => {
    const path = 'migrations/0006_atomic_ingest.sql';
    expect(existsSync(path)).toBe(true);
    if (!existsSync(path)) return;
    const migration = readFileSync(path, 'utf8');
    expect(migration).toMatch(/CREATE TABLE IF NOT EXISTS ingest_runs/i);
    expect(migration).toMatch(/CREATE TABLE IF NOT EXISTS ingest_series_attempts/i);
    expect(migration).toMatch(/CREATE TABLE IF NOT EXISTS staging_observations/i);
    expect(migration).toMatch(/CREATE UNIQUE INDEX[\s\S]*ACTIVE/i);
    expect(migration).toMatch(/CREATE TABLE IF NOT EXISTS ingest_lock/i);
    expect(migration).not.toMatch(/DROP TABLE\s+(observations|model_snapshot_weekly|nowcast_snapshot_daily)/i);
  });

  it('adds durable snapshot outcome fields in an additive migration', () => {
    const path = 'migrations/0007_ingest_snapshot_outcome.sql';
    expect(existsSync(path)).toBe(true);
    if (!existsSync(path)) return;
    const migration = readFileSync(path, 'utf8');
    expect(migration).toMatch(/ALTER TABLE ingest_runs ADD COLUMN snapshot_state/i);
    expect(migration).toMatch(/snapshot_completed_at/i);
    expect(migration).toMatch(/snapshot_error/i);
    expect(migration).toMatch(/snapshot_count/i);
    expect(migration).not.toMatch(/DROP TABLE/i);
  });
});
