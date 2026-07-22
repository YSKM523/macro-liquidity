import { describe, expect, it } from 'vitest';
import { buildGuidance } from '../src/metrics';
import { mapPortfolioPolicy, snapshotVixStressStatus } from '../src/portfolio-policy';

describe('dashboard portfolio exposure policy', () => {
  it.each([
    ['strong tailwind', { score: 60, verdict: 'BULLISH', netliqDir: 'UP', stressStatus: 'NORMAL' }, 1, 'STRONG_TAILWIND'],
    ['ordinary tailwind', { score: 60, verdict: 'BULLISH', netliqDir: 'DOWN', stressStatus: 'NORMAL' }, 0.9, 'ORDINARY_TAILWIND'],
    ['neutral', { score: 52, verdict: 'NEUTRAL', netliqDir: 'FLAT', stressStatus: 'NORMAL' }, 0.75, 'NEUTRAL'],
    ['cautious', { score: 48, verdict: 'NEUTRAL', netliqDir: 'FLAT', stressStatus: 'NORMAL' }, 0.5, 'CAUTIOUS'],
    ['headwind', { score: 40, verdict: 'BEARISH', netliqDir: 'DOWN', stressStatus: 'NORMAL' }, 0.25, 'HEADWIND'],
  ] as const)('maps %s to its frozen long/cash target', (_label, input, targetExposure, tier) => {
    expect(mapPortfolioPolicy(input)).toMatchObject({ targetExposure, tier, methodology: 'DASHBOARD_EXPOSURE_TIERS_V1' });
  });

  it('applies the 25% stress brake below 65 and preserves the existing exemption at 65', () => {
    expect(mapPortfolioPolicy({ score: 64.9, verdict: 'BULLISH', netliqDir: 'UP', stressStatus: 'STRESSED' }))
      .toMatchObject({ targetExposure: 0.25, tier: 'STRESS_BRAKE', stressApplied: true });
    expect(mapPortfolioPolicy({ score: 65, verdict: 'BULLISH', netliqDir: 'UP', stressStatus: 'STRESSED' }))
      .toMatchObject({ targetExposure: 1, tier: 'STRONG_TAILWIND', stressApplied: false });
  });

  it('caps the otherwise applicable target at 75% when stress state is unknown', () => {
    expect(mapPortfolioPolicy({ score: 60, verdict: 'BULLISH', netliqDir: 'UP', stressStatus: 'UNKNOWN' }))
      .toMatchObject({ targetExposure: 0.75, tier: 'UNKNOWN_CAPPED' });
    expect(mapPortfolioPolicy({ score: 40, verdict: 'BEARISH', netliqDir: 'DOWN', stressStatus: 'UNKNOWN' }))
      .toMatchObject({ targetExposure: 0.25, tier: 'HEADWIND' });
  });

  it('derives only the disclosed frozen snapshot VIX proxy for historical stress', () => {
    expect(snapshotVixStressStatus(null)).toBe('UNKNOWN');
    expect(snapshotVixStressStatus(27.99)).toBe('NORMAL');
    expect(snapshotVixStressStatus(28)).toBe('STRESSED');
  });

  it('exposes the exact same numeric policy on live guidance', () => {
    const guidance = buildGuidance({
      score: 60, verdict: 'BULLISH', netliqDir: 'DOWN', qeQtRegime: 'FLAT', stressStatus: 'NORMAL',
    });
    expect(guidance.portfolioPolicy).toEqual(mapPortfolioPolicy({
      score: 60, verdict: 'BULLISH', netliqDir: 'DOWN', stressStatus: 'NORMAL',
    }));
  });
});
