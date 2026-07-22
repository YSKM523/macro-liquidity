// @ts-ignore -- project tsconfig intentionally loads Workers rather than Node types
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('PR-11 research documentation contract', () => {
  it('keeps the public algorithm mirror exact and discloses the frozen negative gate outcome', () => {
    const algorithm = readFileSync('docs/ALGORITHM.md', 'utf8');
    expect(readFileSync('public/algorithm.md', 'utf8')).toBe(algorithm);
    for (const phrase of [
      '连续净流动性 Challenger', 'RESEARCH_CURRENT_VINTAGE', 'Raw', 'Smooth',
      '0.45', '0.35', '0.20', 'DROP_RESEARCH', 'replacementEligible=false',
    ]) expect(algorithm).toContain(phrase);
  });

  it('records PR-11 as shadow-only in README, changelog, and the upgrade plan', () => {
    const files = ['README.md', 'CHANGELOG.md', 'public/md/CODEX_PROFESSIONAL_UPGRADE_PLAN.md']
      .map(path => readFileSync(path, 'utf8'));
    for (const content of files) {
      expect(content).toContain('PR-11');
      expect(content).toContain('DROP_RESEARCH');
      expect(content).toContain('RESEARCH_CURRENT_VINTAGE');
    }
    expect(files[2]).toContain('PR-11 | 已完成（本地候选）');
  });
});
