import { describe, it, expect } from 'vitest';
import { assessHealth } from '../src/health';

const base = {
  dataDate: '2026-06-17',
  snapshots: 558,
  coverage: 1,
  decisionStatus: 'OK',
  lastIngestAt: '2026-06-20T18:00:00.000Z',
  lastStatus: 'ok',
  lastError: '',
  now: '2026-06-20T19:00:00.000Z',   // 1h after last ingest
  staleHours: 6,
};

describe('assessHealth', () => {
  it('fresh ingest + ok status + data → ok=true, not stale', () => {
    const h = assessHealth(base);
    expect(h.ok).toBe(true);
    expect(h.stale).toBe(false);
    expect(h.decision_status).toBe('OK');
    expect(h.ingest_age_hours).toBeCloseTo(1);
  });

  it('ingest older than staleHours → ok=false, stale=true', () => {
    const h = assessHealth({ ...base, lastIngestAt: '2026-06-20T10:00:00.000Z' }); // 9h ago
    expect(h.ok).toBe(false);
    expect(h.stale).toBe(true);
  });

  it('last_status=error → ok=false even if ingest is fresh', () => {
    const h = assessHealth({ ...base, lastStatus: 'error', lastError: 'FRED WALCL 503' });
    expect(h.ok).toBe(false);
    expect(h.ingest_error).toBe('FRED WALCL 503');
  });

  it('old data date but fresh ingest (weekly lag) → still ok (no false alarm)', () => {
    // data 10 days old, ingest ran 1h ago and succeeded
    const h = assessHealth({ ...base, dataDate: '2026-06-10' });
    expect(h.ok).toBe(true);
    expect(h.data_age_days).toBe(10);
  });

  it('empty DB (no snapshots / no data date) → ok=false', () => {
    const h = assessHealth({ ...base, snapshots: 0, dataDate: null });
    expect(h.ok).toBe(false);
  });

  it('no ingest recorded yet (lastIngestAt null) → ok=false', () => {
    const h = assessHealth({ ...base, lastIngestAt: null, lastStatus: null });
    expect(h.ok).toBe(false);
    expect(h.ingest_age_hours).toBeNull();
  });

  it.each(['DATA_INCOMPLETE', undefined] as const)('fresh successful ingest with latest decision %s is unhealthy', decisionStatus => {
    const h = assessHealth({ ...base, decisionStatus });
    expect(h.ok).toBe(false);
    expect(h.stale).toBe(true);
    expect(h.decision_status).toBe('DATA_INCOMPLETE');
  });
});
