import { describe, expect, it } from 'vitest';
// @ts-ignore -- isolated Node research module
import { buildContinuousChallenger, classifyAgreement, priorRollingMad, scoreLatent } from '../scripts/netliq-challenger.mjs';

function weeklyPoints(count: number) {
  const start = Date.parse('2018-01-03T00:00:00Z');
  return Array.from({ length: count }, (_, index) => {
    const date = new Date(start + index * 7 * 86_400_000).toISOString().slice(0, 10);
    const wave = ((index * 17) % 29) - 14;
    return {
      observationDate: date,
      availableDate: new Date(Date.parse(`${date}T00:00:00Z`) + 7 * 86_400_000).toISOString().slice(0, 10),
      rawLevel: 5_000 + index * 3 + wave * 4,
      smoothLevel: 4_990 + index * 2.7 + wave * 2,
    };
  });
}

describe('continuous net-liquidity challenger signal', () => {
  it('derives the documented level/change/impulse/trend/gap/acceleration dimensions', () => {
    const points = weeklyPoints(20);
    const result = buildContinuousChallenger(points);
    const at13 = result[13].raw;
    const levels = points.map(point => point.rawLevel);
    const sma13 = levels.slice(1, 14).reduce((sum, value) => sum + value, 0) / 13;
    expect(at13.level).toBe(levels[13]);
    expect(at13.change1w).toBeCloseTo(levels[13] - levels[12]);
    expect(at13.impulse4).toBeCloseTo(levels[13] - levels[9]);
    expect(at13.trend13).toBeCloseTo(levels[13] - levels[0]);
    expect(at13.gapToSma13Pct).toBeCloseTo((levels[13] - sma13) / Math.abs(sma13) * 100);
    expect(at13.acceleration).toBeCloseTo(
      (levels[13] - levels[9]) - (levels[12] - levels[8]),
    );
  });

  it('uses at most 156 strictly prior values and requires 52 finite prior values', () => {
    const values = Array.from({ length: 210 }, (_, index) => index % 11);
    expect(priorRollingMad(values, 51)).toBeNull();
    const expectedWindow = values.slice(53, 209);
    const median = [...expectedWindow].sort((a, b) => a - b)[Math.floor(expectedWindow.length / 2) - 1] / 2
      + [...expectedWindow].sort((a, b) => a - b)[Math.floor(expectedWindow.length / 2)] / 2;
    const deviations = expectedWindow.map(value => Math.abs(value - median)).sort((a, b) => a - b);
    const expectedMad = (deviations[77] + deviations[78]) / 2;
    expect(priorRollingMad(values, 209)).toBe(expectedMad);
  });

  it('applies exactly the preregistered weights and logistic transform', () => {
    const result = scoreLatent({ gap13: 2, impulse4: -1, impulse13: 0.5 });
    const latent = 0.45 * 2 + 0.35 * -1 + 0.20 * 0.5;
    expect(result.latent).toBeCloseTo(latent, 12);
    expect(result.score).toBeCloseTo(100 / (1 + Math.exp(-latent)), 12);
  });

  it('is prefix invariant when arbitrary future observations are appended', () => {
    const prefix = weeklyPoints(120);
    const future = weeklyPoints(150).slice(120).map((point, index) => ({
      ...point,
      rawLevel: 1_000_000 - index * 90_000,
      smoothLevel: -1_000_000 + index * 80_000,
    }));
    const before = buildContinuousChallenger(prefix);
    const after = buildContinuousChallenger([...prefix, ...future]);
    expect(after.slice(0, before.length)).toEqual(before);
  });

  it('fails closed on a zero or non-finite MAD instead of using an epsilon', () => {
    const flat = weeklyPoints(90).map(point => ({ ...point, rawLevel: 5_000, smoothLevel: 4_000 }));
    const result = buildContinuousChallenger(flat);
    expect(result.at(-1)?.raw).toMatchObject({ score: null, latent: null, direction: 'MISSING' });
    expect(result.at(-1)?.smooth).toMatchObject({ score: null, latent: null, direction: 'MISSING' });
  });

  it('classifies same non-flat direction HIGH, opposite LOW, and flat/missing TRANSITION', () => {
    expect(classifyAgreement(0.1, 2)).toEqual({ direction: 'UP', confidence: 'HIGH' });
    expect(classifyAgreement(-0.1, -2)).toEqual({ direction: 'DOWN', confidence: 'HIGH' });
    expect(classifyAgreement(0.1, -2)).toEqual({ direction: 'TRANSITION', confidence: 'LOW' });
    expect(classifyAgreement(0, 2)).toEqual({ direction: 'TRANSITION', confidence: 'TRANSITION' });
    expect(classifyAgreement(null, 2)).toEqual({ direction: 'TRANSITION', confidence: 'TRANSITION' });
  });
});
