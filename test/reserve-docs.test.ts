// @ts-ignore -- project tsconfig intentionally loads Workers rather than Node types
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('PR-12 research documentation contract', () => {
  it('publishes identical algorithm docs and records the frozen shadow result everywhere', () => {
    const read = (path: string) => readFileSync(path, 'utf8');
    const algorithm = read('docs/ALGORITHM.md');
    expect(read('public/algorithm.md')).toBe(algorithm);
    expect(algorithm).toContain('current-vintage retrospective pseudo-OOS');
    expect(algorithm).toContain('GDP observation-date alignment is not release-aware');
    for (const path of ['README.md', 'CHANGELOG.md', 'docs/ALGORITHM.md', 'public/algorithm.md', 'public/md/CODEX_PROFESSIONAL_UPGRADE_PLAN.md']) {
      const content = read(path);
      for (const phrase of ['PR-12', 'DROP_RESEARCH', 'RESEARCH_CURRENT_VINTAGE', 'replacementEligible=false', 'Champion']) expect(content).toContain(phrase);
    }
    const report = read('docs/research/RESERVE_ADEQUACY_OOS_REPORT.md');
    for (const phrase of ['PR12_RESEARCH_V2_SRF_BOUNDARY', 'A-002', '2021-07-29', 'small-value exercises', 'DROP_RESEARCH']) expect(report).toContain(phrase);
    expect(read('public/md/CODEX_PROFESSIONAL_UPGRADE_PLAN.md')).toContain('PR-12 | 已完成并部署');
  });
});
