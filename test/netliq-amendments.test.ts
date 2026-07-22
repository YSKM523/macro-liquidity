// @ts-ignore -- project tsconfig intentionally loads Workers rather than Node types
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('PR-11 amendment audit ledger', () => {
  it('preserves exact chronology and invalidates rather than silently replacing the initial report', () => {
    const ledger = readFileSync('docs/research/NETLIQ_CHALLENGER_AMENDMENTS.md', 'utf8');
    for (const phrase of [
      '0b120a4', '8180851', '47e2358', '4891ed0', '30f2ef9', '0fff138',
      'INVALIDATED_BY_REVIEW', 'POST_FETCH_DATA_HYGIENE', 'Wed+7',
      'schema-v2', 'REVIEW_TRUST_BOUNDARY', 'formula/weights/MAD/folds/gate unchanged',
    ]) expect(ledger).toContain(phrase);
    expect(existsSync('docs/research/NETLIQ_CHALLENGER_OOS_REPORT_INITIAL_INVALIDATED.json')).toBe(true);
    expect(existsSync('docs/research/NETLIQ_CHALLENGER_OOS_REPORT_INITIAL_INVALIDATED.md')).toBe(true);
  });
});
