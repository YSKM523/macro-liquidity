import { describe, expect, it, vi } from 'vitest';
// The project tsconfig intentionally only loads Workers types; this test runs in Vitest's Node runtime.
// @ts-ignore
import { existsSync, readFileSync } from 'node:fs';
import * as ingestDb from '../src/db';

describe('ingest repository contracts', () => {
  it('exposes atomic lock and validation operations', () => {
    expect(typeof (ingestDb as any).acquireIngestLock).toBe('function');
    expect(typeof (ingestDb as any).releaseIngestLock).toBe('function');
    expect(typeof (ingestDb as any).renewIngestLock).toBe('function');
    expect(typeof (ingestDb as any).validateSeriesAttempts).toBe('function');
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
    const batch = vi.fn(async (_statements: D1PreparedStatement[]) => []);
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
    expect(statements[1].sql).toMatch(/SUPERSEDED[\s\S]*ACTIVE/i);
    expect(statements[2].sql).toMatch(/state = 'ACTIVE'/i);
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
});
