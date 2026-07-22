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

  it('generates the corrected report only from the canonical schema-v2 artifact', () => {
    const generator = readFileSync('scripts/generate-netliq-report.mjs', 'utf8');
    expect(generator).toContain("const snapshotId = 'netliq-current-vintage-2026-07-22-corrected-v2'");
    expect(generator).toContain("docs/research/NETLIQ_CHALLENGER_OOS_REPORT.json");
    expect(generator).toContain("docs/research/NETLIQ_CHALLENGER_OOS_REPORT.md");
    expect(generator).toContain("flag: 'wx'");

    const corrected = JSON.parse(readFileSync('docs/research/NETLIQ_CHALLENGER_OOS_REPORT.json', 'utf8'));
    expect(corrected).toMatchObject({
      schemaVersion: 2,
      snapshotId: 'netliq-current-vintage-2026-07-22-corrected-v2',
      methodologyVersion: 'PR11_RESEARCH_V2_REVIEW_AMENDED',
      decision: { evidenceConclusion: 'INCONCLUSIVE', decision: 'DROP_RESEARCH', replacementEligible: false },
    });
    expect(readFileSync('docs/research/NETLIQ_CHALLENGER_OOS_REPORT.md', 'utf8'))
      .toContain('Corrected OOS Research Report');
  });
});
