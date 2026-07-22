import { describe, expect, it } from 'vitest';
import {
  assertSnapshotVersionMetadata,
  parseDateRange,
  snapshotsToCsv,
  normalizeSnapshotProvenance,
  summarizeSnapshotProvenance,
} from '../src/api-schema';

describe('v1 API schema', () => {
  it('accepts only canonical ordered date ranges', () => {
    expect(parseDateRange(new URL('https://example.test?from=2024-01-01&to=2024-02-01')))
      .toEqual({ from: '2024-01-01', to: '2024-02-01' });
    expect(() => parseDateRange(new URL('https://example.test?from=01-01-2024'))).toThrow(/invalid from/i);
    expect(() => parseDateRange(new URL('https://example.test?from=2024-02-01&to=2024-01-01'))).toThrow(/range/i);
  });

  it('fails closed for unversioned or malformed snapshot metadata', () => {
    expect(() => assertSnapshotVersionMetadata({ model_version: 'LEGACY_UNVERSIONED' })).toThrow(/version/i);
    expect(() => assertSnapshotVersionMetadata({
      model_version: 'champion-v1.0.0', config_hash: 'x', code_commit_sha: 'LOCAL_UNCONFIGURED',
      data_run_id: 'run', data_cutoff: '2024-01-01T00:00:00Z', decision_at: '2024-01-01T00:00:00Z',
      created_at: '2024-01-01T00:00:00Z',
    })).toThrow(/config hash/i);
  });

  it('escapes spreadsheet formulas, quotes, commas, and newlines in CSV exports', () => {
    const csv = snapshotsToCsv([{
      date: '2024-01-01', score: -5, verdict: '=HYPERLINK("bad")', reason: 'a,"b"\nnext',
      model_version: 'champion-v1.0.0', config_hash: 'a'.repeat(64),
      code_commit_sha: 'LOCAL_UNCONFIGURED', data_run_id: 'run-1',
      data_cutoff: '2024-01-01T00:00:00Z', decision_at: '2024-01-01T00:00:00Z',
      created_at: '2024-01-01T00:00:00Z',
    }]);
    expect(csv).toContain("'=HYPERLINK");
    expect(csv).toContain('"a,""b""\nnext"');
    expect(csv).toContain('2024-01-01,-5,');
    expect(csv).not.toContain("'-5");
  });
});

describe('governed and legacy snapshot provenance', () => {
  const governed = {
    model_version: 'champion-v1.0.0', config_hash: 'a'.repeat(64),
    code_commit_sha: '0123456789abcdef0123456789abcdef01234567', data_run_id: 'run',
    data_cutoff: '2024-01-01T00:00:00Z', decision_at: '2024-01-01T00:00:00Z',
    created_at: '2024-01-01T00:00:01Z',
  };

  it('normalizes legacy unknown provenance to null without inventing identity', () => {
    expect(normalizeSnapshotProvenance({
      model_version: 'LEGACY_UNVERSIONED', config_hash: 'LEGACY_UNVERSIONED',
      code_commit_sha: 'LEGACY_UNVERSIONED', data_run_id: 'old-run', data_cutoff: '2020-01-01T00:00:00Z',
    })).toMatchObject({
      provenance_status: 'LEGACY', config_hash: null, code_commit_sha: null,
      data_run_id: null, data_cutoff: null, decision_at: null, created_at: null,
    });
  });

  it('reports joint completeness and rejects abnormal mixed identity states', () => {
    const rows = [normalizeSnapshotProvenance(governed), normalizeSnapshotProvenance({
      model_version: 'LEGACY_UNVERSIONED', config_hash: 'LEGACY_UNVERSIONED',
      code_commit_sha: 'LEGACY_UNVERSIONED',
    })];
    expect(summarizeSnapshotProvenance(rows)).toEqual({
      totalCount: 2, governedCount: 1, legacyCount: 1, completeness: 'PARTIAL_LEGACY',
    });
    expect(() => normalizeSnapshotProvenance({
      model_version: 'LEGACY_UNVERSIONED', config_hash: 'a'.repeat(64),
      code_commit_sha: 'LEGACY_UNVERSIONED',
    })).toThrow(/mixed/i);
  });
});
