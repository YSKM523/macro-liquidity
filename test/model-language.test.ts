import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const USER_FACING_MODEL_FILES = [
  'README.md',
  'docs/ALGORITHM.md',
  'docs/MODEL_CARD.md',
  'public/algorithm.md',
  'public/index.html',
];

describe('model factor language contract', () => {
  it('describes eight scoring factors plus one independent live-risk overlay', () => {
    const content = USER_FACING_MODEL_FILES.map(file => readFileSync(file, 'utf8')).join('\n');

    expect(content).toMatch(/8\s*(?:个\s*)?(?:宏观)?(?:计分|scoring)因子|8 scoring factors/i);
    expect(content).toMatch(/独立(?:的)?实时风控覆盖层|independent live-risk overlay/i);
  });

  it('forbids legacy weighted-factor counts in user-facing files', () => {
    const legacy = /(?:9\s*(?:个\s*)?(?:加权|计分|weighted|scoring)?\s*因子|9-factor|nine\s+weighted\s+factors|7\s*(?:个\s*)?因子(?:加权)?)/i;

    for (const file of USER_FACING_MODEL_FILES) {
      expect(readFileSync(file, 'utf8'), file).not.toMatch(legacy);
    }
  });
});
