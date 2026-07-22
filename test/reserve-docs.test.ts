import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('PR-12 research documentation contract', () => {
  it('publishes identical algorithm docs and records the frozen shadow result everywhere', () => {
    const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
    const algorithm = read('docs/ALGORITHM.md');
    expect(read('public/algorithm.md')).toBe(algorithm);
    for (const path of ['README.md', 'CHANGELOG.md', 'docs/ALGORITHM.md', 'public/algorithm.md', 'public/md/CODEX_PROFESSIONAL_UPGRADE_PLAN.md']) {
      const content = read(path);
      for (const phrase of ['PR-12', 'DROP_RESEARCH', 'RESEARCH_CURRENT_VINTAGE', 'replacementEligible=false', 'Champion']) expect(content).toContain(phrase);
    }
    const report = read('docs/research/RESERVE_ADEQUACY_OOS_REPORT.md');
    for (const phrase of ['PR12_RESEARCH_V2_SRF_BOUNDARY', 'A-002', '2021-07-29', 'small-value exercises', 'DROP_RESEARCH']) expect(report).toContain(phrase);
    expect(read('public/md/CODEX_PROFESSIONAL_UPGRADE_PLAN.md')).toContain('PR-12 | 已完成（本地）');
  });
});
