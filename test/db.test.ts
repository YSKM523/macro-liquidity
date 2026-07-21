import { describe, expect, it, vi } from 'vitest';
import { snapshotBefore } from '../src/db';

describe('snapshotBefore', () => {
  it('loads the nearest snapshot strictly before the rebuild start date', async () => {
    const first = vi.fn(async () => ({ date: '2024-05-08', verdict: 'BULLISH' }));
    const bind = vi.fn(() => ({ first }));
    const prepare = vi.fn(() => ({ bind }));
    const db = { prepare } as unknown as D1Database;

    const row = await snapshotBefore(db, '2024-05-15');

    expect(prepare).toHaveBeenCalledWith(
      'SELECT * FROM daily_snapshot WHERE date < ? ORDER BY date DESC LIMIT 1',
    );
    expect(bind).toHaveBeenCalledWith('2024-05-15');
    expect(row).toEqual({ date: '2024-05-08', verdict: 'BULLISH' });
  });
});
