import { describe, expect, it, vi } from 'vitest';
// The project tsconfig intentionally only loads Workers types; this test runs in Vitest's Node runtime.
// @ts-ignore
import { existsSync, readFileSync } from 'node:fs';
import { snapshotBefore, upsertSnapshot } from '../src/db';

describe('snapshotBefore', () => {
  it('loads the nearest snapshot strictly before the rebuild start date', async () => {
    const first = vi.fn(async () => ({ date: '2024-05-08', verdict: 'BULLISH' }));
    const bind = vi.fn(() => ({ first }));
    const prepare = vi.fn(() => ({ bind }));
    const db = { prepare } as unknown as D1Database;

    const row = await snapshotBefore(db, '2024-05-15');

    expect(prepare).toHaveBeenCalledWith(
      'SELECT * FROM daily_snapshot WHERE date < ? AND verdict IS NOT NULL ORDER BY date DESC LIMIT 1',
    );
    expect(bind).toHaveBeenCalledWith('2024-05-15');
    expect(row).toEqual({ date: '2024-05-08', verdict: 'BULLISH' });
  });
});

describe('snapshot quality persistence', () => {
  it('serializes decision status, factor quality, and series freshness in the snapshot upsert', async () => {
    const run = vi.fn(async () => undefined);
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

    await upsertSnapshot(db, snapshot, 5000);

    const preparedSql = (prepare.mock.calls as unknown as [[string]])[0][0];
    expect(preparedSql).toContain('decision_status');
    expect(preparedSql).toContain('factor_quality_json');
    expect(preparedSql).toContain('freshness_json');
    expect(bind.mock.calls[0].slice(-3)).toEqual([
      'OK', JSON.stringify(factorResults), JSON.stringify(freshness),
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
