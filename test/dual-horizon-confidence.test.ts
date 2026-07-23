import { describe, expect, expectTypeOf, it } from 'vitest';
// @ts-ignore -- isolated Node research module
import { buildContinuousChallenger, buildWeeklyNetLiquidity } from '../scripts/netliq-challenger.mjs';
import { WEIGHTS } from '../src/config';
import {
  buildDualHorizonShadow,
  computeDualHorizonConfidence,
  mapShadowExposure,
  scoreFourWeekTacticalCohort,
  scoreTacticalCohort,
  type DualFactorStatus,
  type RawSmoothAgreement,
} from '../src/dual-horizon-confidence';
import type {
  DualHorizonSnapshotInputs,
  LiquidityStructureSeriesInputs,
} from '../src/db';

const factors = {
  netliqTrend: 10, impulse: 60, credit: 20, funding: 40,
  rates: 50, dollar: 70, reserveAdequacy: 60, curve: 90,
};

type ResearchSeries = Record<'WALCL' | 'WDTGAL' | 'WTREGEN' | 'RRPONTSYD', Array<{
  date: string;
  value: number;
}>>;

const DAY_MS = 86_400_000;

function isoDate(epochMs: number) {
  return new Date(epochMs).toISOString().slice(0, 10);
}

function syntheticResearchSeries(count: number): ResearchSeries {
  const start = Date.parse('2018-01-03T00:00:00Z');
  const WALCL = [];
  const WDTGAL = [];
  const WTREGEN = [];
  const RRPONTSYD = [];
  for (let index = 0; index < count; index++) {
    const epochMs = start + index * 7 * DAY_MS;
    const date = isoDate(epochMs);
    const wave = Math.sin(index * 0.41) * 40 + Math.cos(index * 0.13) * 25;
    WALCL.push({ date, value: 7_000_000 + index * 3_000 + wave * 1_000 });
    WDTGAL.push({ date, value: 500_000 });
    WTREGEN.push({ date, value: 500_000 });
    for (let offset = -4; offset <= 0; offset++) {
      RRPONTSYD.push({
        date: isoDate(epochMs + offset * DAY_MS),
        value: 1_000,
      });
    }
  }
  return { WALCL, WDTGAL, WTREGEN, RRPONTSYD };
}

function snapshotsAt(decisionDate: string): DualHorizonSnapshotInputs {
  const snapshotFactors = { ...factors };
  const factorResults = Object.fromEntries(
    Object.keys(snapshotFactors).map(key => [key, { status: 'OK' }]),
  );
  const snapshot = {
    date: decisionDate,
    decisionAt: `${decisionDate}T12:00:00Z`,
    recordedAt: `${decisionDate}T12:30:00Z`,
    score: 47.25,
    verdict: 'NEUTRAL',
    netliqDir: 'FLAT',
    snapshotVixEod: 20,
    qeQtRegime: 'QT',
    factors: snapshotFactors,
    factorResults,
    modelVersion: 'champion-v1.0.0',
    configHash: 'a'.repeat(64),
    codeCommitSha: 'b'.repeat(40),
    dataRunId: 'run-1',
    dataCutoff: `${decisionDate}T11:00:00Z`,
    createdAt: `${decisionDate}T12:30:00Z`,
  };
  return {
    asOfCutoff: `${decisionDate}T23:59:59Z`,
    snapshots: Array.from({ length: 53 }, (_, index) => ({
      ...snapshot,
      date: isoDate(Date.parse(`${decisionDate}T00:00:00Z`) - (52 - index) * 7 * DAY_MS),
    })),
    provenance: { methodology: 'GOVERNED_WEEKLY_AS_OF', rowCount: 53 },
  };
}

function dualInputFromRawUnits(rawUnits: ResearchSeries): {
  snapshots: DualHorizonSnapshotInputs;
  liquidity: LiquidityStructureSeriesInputs;
} {
  const latestObservation = rawUnits.WALCL.at(-1)?.date ?? '2018-01-03';
  const decisionDate = isoDate(Date.parse(`${latestObservation}T00:00:00Z`) + 7 * DAY_MS);
  const snapshots = snapshotsAt(decisionDate);
  const seriesMap = {
    WALCL: rawUnits.WALCL.map(row => ({ ...row, value: row.value / 1_000 })),
    WDTGAL: rawUnits.WDTGAL.map(row => ({ ...row, value: row.value / 1_000 })),
    WTREGEN: rawUnits.WTREGEN.map(row => ({ ...row, value: row.value / 1_000 })),
    RRPONTSYD: rawUnits.RRPONTSYD.map(row => ({ ...row })),
  };
  return {
    snapshots,
    liquidity: {
      asOfCutoff: snapshots.asOfCutoff,
      decisionDate,
      decisionAt: `${decisionDate}T23:59:58Z`,
      seriesMap,
      provenance: {
        methodology: 'APPEND_ONLY_AS_OF',
        rowCount: Object.values(seriesMap).reduce((sum, rows) => sum + rows.length, 0),
        dataRunCount: 1,
        maxFetchedAt: snapshots.asOfCutoff,
      },
    },
  };
}

function appendFutureLiquidity(
  seriesMap: LiquidityStructureSeriesInputs['seriesMap'],
  decisionDate: string,
): LiquidityStructureSeriesInputs['seriesMap'] {
  const futureWednesdays = [7, 14].map(offset =>
    isoDate(Date.parse(`${decisionDate}T00:00:00Z`) + offset * DAY_MS));
  return {
    WALCL: [
      ...(seriesMap.WALCL ?? []),
      ...futureWednesdays.map((date, index) => ({ date, value: 20_000 + index * 1_000 })),
    ],
    WDTGAL: [
      ...(seriesMap.WDTGAL ?? []),
      ...futureWednesdays.map((date, index) => ({ date, value: 2_000 + index * 100 })),
    ],
    WTREGEN: [
      ...(seriesMap.WTREGEN ?? []),
      ...futureWednesdays.map((date, index) => ({ date, value: 1_900 + index * 100 })),
    ],
    RRPONTSYD: [
      ...(seriesMap.RRPONTSYD ?? []),
      ...futureWednesdays.map((date, index) => ({ date, value: 5_000 + index * 500 })),
    ],
  };
}

function divergentFourAndThirteenWeekInput() {
  return dualInputFromRawUnits(syntheticResearchSeries(220));
}

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

describe('dual-horizon Shadow composition', () => {
  it('matches the frozen PR-11 Raw/Smooth direction from the same synthetic history', () => {
    const rawUnits = syntheticResearchSeries(220);
    const frozen = buildContinuousChallenger(buildWeeklyNetLiquidity(rawUnits)).at(-1)!;
    const input = dualInputFromRawUnits(rawUnits);
    const result = buildDualHorizonShadow(input.snapshots, input.liquidity);
    expect(result.status).toBe('OK');
    if (result.status !== 'OK') return;
    expect(result.rawSmooth).toMatchObject({
      agreement: frozen.agreement.confidence,
      rawLatent: frozen.raw.latent,
      smoothLatent: frozen.smooth.latent,
    });
  });

  it('does not change an old cutoff result when future observations are appended', () => {
    const rawUnits = syntheticResearchSeries(220);
    const base = dualInputFromRawUnits(rawUnits);
    const before = buildDualHorizonShadow(base.snapshots, base.liquidity);
    const after = buildDualHorizonShadow(base.snapshots, {
      ...base.liquidity,
      seriesMap: appendFutureLiquidity(base.liquidity.seriesMap, base.liquidity.decisionDate),
    });
    expect(after).toEqual(before);
  });

  it('allows the four-week tactical score to diverge while preserving the strategic score', () => {
    const input = divergentFourAndThirteenWeekInput();
    const result = buildDualHorizonShadow(input.snapshots, input.liquidity);
    expect(result).toMatchObject({
      status: 'OK',
      strategicScore: input.snapshots.snapshots.at(-1)!.score,
      championChanged: false,
    });
    if (result.status !== 'OK') return;
    expect(result.tacticalFactors.netliqTrend)
      .not.toBe(input.snapshots.snapshots.at(-1)!.factors.netliqTrend);
    expect(result.formalFactors).toEqual(input.snapshots.snapshots.at(-1)!.factors);
  });

  it('preserves extra formal diagnostics under an unknown-valued result contract', () => {
    const input = dualInputFromRawUnits(syntheticResearchSeries(220));
    const selected = input.snapshots.snapshots.at(-1)!;
    selected.factors = {
      ...selected.factors,
      diagnostic: { methodology: 'LEGACY_ZERO_WEIGHT_DIAGNOSTIC' },
    };
    const result = buildDualHorizonShadow(input.snapshots, input.liquidity);
    expect(result.status).toBe('OK');
    if (result.status !== 'OK') return;
    expectTypeOf(result.formalFactors).toEqualTypeOf<Record<string, unknown>>();
    expect(result.formalFactors).toEqual(selected.factors);
    expect(result.formalFactors.diagnostic).toEqual({
      methodology: 'LEGACY_ZERO_WEIGHT_DIAGNOSTIC',
    });
  });

  it('fails closed when the latest WALCL anchor is stale at the decision date', () => {
    const input = dualInputFromRawUnits(syntheticResearchSeries(220));
    const latestWalclDate = input.liquidity.seriesMap.WALCL.at(-1)!.date;
    const staleDecisionDate = isoDate(
      Date.parse(`${latestWalclDate}T00:00:00Z`) + 100 * DAY_MS,
    );
    const staleCutoff = `${staleDecisionDate}T23:59:59Z`;
    expect(buildDualHorizonShadow(
      { ...input.snapshots, asOfCutoff: staleCutoff },
      {
        ...input.liquidity,
        asOfCutoff: staleCutoff,
        decisionDate: staleDecisionDate,
        decisionAt: `${staleDecisionDate}T23:59:58Z`,
      },
    )).toMatchObject({
      status: 'DATA_INCOMPLETE',
      reasons: ['MISSING_TACTICAL_HISTORY'],
      championChanged: false,
    });
  });

  it('fails closed for insufficient Raw/Smooth history without inventing confidence', () => {
    const input = dualInputFromRawUnits(syntheticResearchSeries(20));
    expect(buildDualHorizonShadow(input.snapshots, input.liquidity)).toMatchObject({
      status: 'DATA_INCOMPLETE',
      reasons: expect.arrayContaining(['MISSING_RAW_SMOOTH_HISTORY']),
      championChanged: false,
    });
  });
});
