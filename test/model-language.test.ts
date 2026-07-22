// @ts-ignore Node test runtime import.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  LEGACY_ZERO_WEIGHT_DIAGNOSTICS,
  LIVE_RISK_OVERLAY_INPUTS,
  SCORING_FACTOR_KEYS,
  WEIGHTS,
} from '../src/config';

const USER_FACING_MODEL_FILES = [
  'README.md',
  'docs/ALGORITHM.md',
  'docs/MODEL_CARD.md',
  'public/algorithm.md',
  'public/index.html',
  'docs/superpowers/plans/2026-07-05-command-center-redesign.md',
  'docs/superpowers/specs/2026-07-05-command-center-redesign-design.md',
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

  it('classifies eight scoring keys, vol as a legacy zero-weight diagnostic, and the live overlay independently', () => {
    expect(SCORING_FACTOR_KEYS).toEqual([
      'netliqTrend', 'impulse', 'credit', 'funding', 'rates', 'dollar', 'reserveAdequacy', 'curve',
    ]);
    expect(WEIGHTS.vol).toBe(0);
    expect(LEGACY_ZERO_WEIGHT_DIAGNOSTICS).toEqual({ vol: 'LEGACY_ZERO_WEIGHT_DIAGNOSTIC' });
    expect(LIVE_RISK_OVERLAY_INPUTS).toEqual(['vix', 'spx', 'us10y', 'dxy']);
    const content = USER_FACING_MODEL_FILES.map(file => readFileSync(file, 'utf8')).join('\n');
    expect(content).toMatch(/LEGACY_ZERO_WEIGHT_DIAGNOSTIC/);
    expect(content).not.toMatch(/vol[^\n]*(?:进入|belongs to|作为)[^\n]*(?:live-stress|live-risk|实时风控覆盖层)/i);
  });

  it('renders only the eight scoring keys in the Factor Wall', () => {
    const app = readFileSync('public/app.js', 'utf8');
    expect(app).toMatch(/const SCORING_FACTOR_KEYS\s*=\s*\[\s*'netliqTrend',\s*'impulse',\s*'credit',\s*'funding',\s*'rates',\s*'dollar',\s*'reserveAdequacy',\s*'curve'\s*\]/);
    expect(app).toMatch(/for \(const k of SCORING_FACTOR_KEYS\)/);
  });
});
