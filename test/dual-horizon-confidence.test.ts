import { describe, expect, it } from 'vitest';
import { WEIGHTS } from '../src/config';
import {
  computeDualHorizonConfidence,
  mapShadowExposure,
  scoreFourWeekTacticalCohort,
  scoreTacticalCohort,
  type DualFactorStatus,
  type RawSmoothAgreement,
} from '../src/dual-horizon-confidence';

const factors = {
  netliqTrend: 10, impulse: 60, credit: 20, funding: 40,
  rates: 50, dollar: 70, reserveAdequacy: 60, curve: 90,
};

describe('dual-horizon frozen arithmetic', () => {
  it('replaces only netliqTrend and applies the literal Champion weights without renormalizing', () => {
    expect(WEIGHTS).toEqual({
      netliqTrend: 0.35, impulse: 0.05, credit: 0.06, funding: 0.04,
      rates: 0.05, dollar: 0.18, vol: 0, reserveAdequacy: 0.12, curve: 0.15,
    });
    const result = scoreTacticalCohort(factors, 80);
    const expected = Object.entries({ ...factors, netliqTrend: 80 })
      .reduce((sum, [key, value]) => sum + value * WEIGHTS[key as keyof typeof WEIGHTS], 0);
    expect(result).toEqual({
      status: 'OK', score: expected, factors: { ...factors, netliqTrend: 80 },
    });
    expect(Object.values(WEIGHTS).reduce<number>((sum, weight) => sum + weight, 0)).toBe(1);
  });

  it('fails closed when any positive-weight factor is absent', () => {
    const { funding: _funding, ...incomplete } = factors;
    expect(scoreTacticalCohort(incomplete, 80)).toEqual({
      status: 'DATA_INCOMPLETE', reason: 'MISSING_FORMAL_FACTOR_COHORT',
    });
  });

  it('derives the tactical cohort net-liquidity score from five raw weekly levels using four weeks', () => {
    const rawLevels = [1000, 1100, 1200, 1300, 1400];
    expect(scoreFourWeekTacticalCohort(factors, rawLevels)).toEqual(
      scoreTacticalCohort(factors, 80),
    );
  });

  it('fails closed when tactical raw history is short or non-finite', () => {
    expect(scoreFourWeekTacticalCohort(factors, [1000, 1100, 1200, 1300])).toEqual({
      status: 'DATA_INCOMPLETE', reason: 'MISSING_TACTICAL_HISTORY',
    });
    expect(scoreFourWeekTacticalCohort(factors, [1000, 1100, Number.NaN, 1300, 1400])).toEqual({
      status: 'DATA_INCOMPLETE', reason: 'MISSING_TACTICAL_HISTORY',
    });
  });

  it('calculates the five equal confidence components exactly', () => {
    expect(computeDualHorizonConfidence({
      factorStatuses: {
        netliqTrend: 'OK', impulse: 'PARTIAL', credit: 'OK', funding: 'OK',
        rates: 'STALE', dollar: 'OK', reserveAdequacy: 'OK', curve: 'MISSING',
      },
      tacticalFactors: {
        netliqTrend: 70, impulse: 60, credit: 20, funding: 40,
        rates: 50, dollar: 70, reserveAdequacy: 60, curve: 40,
      },
      sameRegimeSampleCount: 26,
      rawSmooth: 'HIGH',
    })).toMatchObject({
      status: 'OK',
      components: {
        completeness: 100,
        freshness: 68.75,
        regimeSample: 50,
        majorFactorAgreement: 75,
        rawSmoothAgreement: 100,
      },
      confidence: 78.75,
    });
  });

  it('fails closed for an unknown factor status at runtime', () => {
    expect(computeDualHorizonConfidence({
      factorStatuses: {
        netliqTrend: 'UNKNOWN' as unknown as DualFactorStatus, impulse: 'OK', credit: 'OK', funding: 'OK',
        rates: 'OK', dollar: 'OK', reserveAdequacy: 'OK', curve: 'OK',
      },
      tacticalFactors: factors,
      sameRegimeSampleCount: 26,
      rawSmooth: 'HIGH',
    })).toEqual({
      status: 'DATA_INCOMPLETE', reason: 'CONFIDENCE_INPUT_INCOMPLETE',
    });
  });

  it('fails closed for an unknown raw/smooth agreement at runtime', () => {
    expect(computeDualHorizonConfidence({
      factorStatuses: {
        netliqTrend: 'OK', impulse: 'OK', credit: 'OK', funding: 'OK',
        rates: 'OK', dollar: 'OK', reserveAdequacy: 'OK', curve: 'OK',
      },
      tacticalFactors: factors,
      sameRegimeSampleCount: 26,
      rawSmooth: 'UNKNOWN' as unknown as RawSmoothAgreement,
    })).toEqual({
      status: 'DATA_INCOMPLETE', reason: 'CONFIDENCE_INPUT_INCOMPLETE',
    });
  });

  it('uses inclusive tactical boundaries and exact confidence guard boundaries', () => {
    expect(mapShadowExposure(0.75, 60, 60)).toMatchObject({
      unguardedAdjustment: 0.10, shadowAdjustment: 0.10, shadowTargetExposure: 0.85,
    });
    expect(mapShadowExposure(0.75, 60, 59.999)).toMatchObject({
      unguardedAdjustment: 0.10, shadowAdjustment: 0, shadowTargetExposure: 0.75,
    });
    expect(mapShadowExposure(1, 50, 40)).toMatchObject({
      unguardedAdjustment: 0, shadowTargetExposure: 1,
    });
    expect(mapShadowExposure(1, 50, 39.999)).toMatchObject({
      unguardedAdjustment: 0, shadowTargetExposure: 0.75,
    });
    expect(mapShadowExposure(0.75, 40, 80).shadowAdjustment).toBe(-0.10);
  });
});
