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
      'PR11_RESEARCH_V2_REVIEW_AMENDED', 'Wed+7', 'POST_FETCH_DATA_HYGIENE',
      'INVALIDATED_BY_REVIEW', '0.2655', '0.2201', '0.2959', '0.1559',
    ]) expect(algorithm).toContain(phrase);
  });

  it('records PR-11 as shadow-only in README, changelog, and the upgrade plan', () => {
    const files = ['README.md', 'CHANGELOG.md', 'public/md/CODEX_PROFESSIONAL_UPGRADE_PLAN.md']
      .map(path => readFileSync(path, 'utf8'));
    for (const content of files) {
      expect(content).toContain('PR-11');
      expect(content).toContain('DROP_RESEARCH');
      expect(content).toContain('RESEARCH_CURRENT_VINTAGE');
      expect(content).toContain('Wed+7');
      expect(content).toContain('schema-v2');
      expect(content).toContain('INVALIDATED_BY_REVIEW');
      expect(content).toContain('0.2655');
      expect(content).toContain('0.2959');
    }
    expect(files[2]).toContain('PR-11 | 已完成并部署');
  });
});
