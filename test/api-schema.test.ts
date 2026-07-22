import { describe, expect, it } from 'vitest';
import {
  assertSnapshotVersionMetadata,
  parseDateRange,
  snapshotsToCsv,
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
      date: '2024-01-01', verdict: '=HYPERLINK("bad")', reason: 'a,"b"\nnext',
      model_version: 'champion-v1.0.0', config_hash: 'a'.repeat(64),
      code_commit_sha: 'LOCAL_UNCONFIGURED', data_run_id: 'run-1',
      data_cutoff: '2024-01-01T00:00:00Z', decision_at: '2024-01-01T00:00:00Z',
      created_at: '2024-01-01T00:00:00Z',
    }]);
    expect(csv).toContain("'=HYPERLINK");
    expect(csv).toContain('"a,""b""\nnext"');
  });
});
