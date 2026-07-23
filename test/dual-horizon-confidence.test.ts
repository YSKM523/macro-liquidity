import { describe, expect, expectTypeOf, it } from 'vitest';
// @ts-ignore -- isolated Node research module
import { buildContinuousChallenger, buildWeeklyNetLiquidity } from '../scripts/netliq-challenger.mjs';
import { WEIGHTS } from '../src/config';
import {
  DUAL_HORIZON_PROTOCOL,
  buildDualHorizonShadow,
  computeDualHorizonConfidence,
  mapShadowExposure,
  rawSmoothAtDecision,
  scoreFourWeekTacticalCohort,
  scoreTacticalCohort,
  type DualFactorStatus,
  type RawSmoothAgreement,
} from '../src/dual-horizon-confidence';
import { championConfigDigest, CHAMPION_MODEL_VERSION } from '../src/model-version';
import { mapPortfolioPolicy, snapshotVixStressStatus } from '../src/portfolio-policy';
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
    qeQtRegime: 'FLAT' as const,
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

function rawSmoothDirectionFixture(
  agreement: 'HIGH' | 'LOW' | 'TRANSITION',
): ResearchSeries {
  const fixture = syntheticResearchSeries(170);
  const lastFlatStart = fixture.WALCL.length - 14;
  fixture.WALCL.forEach((row, index) => {
    const oscillation = Math.sin(index * 0.37) * 20_000;
    row.value = 7_000_000;
    fixture.WDTGAL[index].value = 1_000_000 - index * 2_000 + oscillation;
    fixture.WTREGEN[index].value = agreement === 'HIGH'
      ? 1_000_000 - index * 2_000 + oscillation
      : agreement === 'LOW'
        ? 1_000_000 + index * 2_000 - oscillation
        : index >= lastFlatStart
          ? 1_000_000
          : 1_000_000 + oscillation;
  });
  return fixture;
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
    expect(result).toMatchObject({
      status: 'OK', score: expected, factors: { ...factors, netliqTrend: 80 },
      completenessEvidence: {
        validCount: 8,
        expectedCount: 8,
        invalidOrMissingKeys: [],
        score: 100,
        reason: 'FORMAL_FACTOR_COHORT_COMPLETE',
      },
    });
    expect(Object.values(WEIGHTS).reduce<number>((sum, weight) => sum + weight, 0)).toBe(1);
  });

  it('fails closed when any positive-weight factor is absent', () => {
    const { funding: _funding, ...incomplete } = factors;
    expect(scoreTacticalCohort(incomplete, 80)).toMatchObject({
      status: 'DATA_INCOMPLETE',
      reason: 'MISSING_FORMAL_FACTOR_COHORT',
      completenessEvidence: {
        validCount: 7,
        expectedCount: 8,
        validKeys: expect.not.arrayContaining(['funding']),
        invalidOrMissingKeys: ['funding'],
        score: 87.5,
        reason: 'FORMAL_FACTOR_COHORT_INCOMPLETE',
      },
    });
  });

  it.each([
    ['missing', undefined],
    ['non-finite', Number.NaN],
    ['below range', -1],
    ['above range', 101],
  ])('fails closed before replacement when persisted netliqTrend is %s', (_label, value) => {
    expect(scoreTacticalCohort({ ...factors, netliqTrend: value }, 80)).toMatchObject({
      status: 'DATA_INCOMPLETE',
      reason: 'MISSING_FORMAL_FACTOR_COHORT',
      completenessEvidence: {
        validCount: 7,
        expectedCount: 8,
        invalidOrMissingKeys: ['netliqTrend'],
        score: 87.5,
      },
    });
  });

  it('derives the tactical cohort net-liquidity score from five raw weekly levels using four weeks', () => {
    const rawLevels = [1000, 1100, 1200, 1300, 1400];
    expect(scoreFourWeekTacticalCohort(factors, rawLevels)).toMatchObject({
      status: 'OK',
      score: scoreTacticalCohort(factors, 80).status === 'OK'
        ? scoreTacticalCohort(factors, 80).score
        : Number.NaN,
    });
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
      formalFactors: factors,
      factorStatuses: {
        netliqTrend: 'OK', impulse: 'PARTIAL', credit: 'OK', funding: 'OK',
        rates: 'STALE', dollar: 'OK', reserveAdequacy: 'OK', curve: 'MISSING',
      },
      tacticalFactors: {
        netliqTrend: 70, impulse: 60, credit: 20, funding: 40,
        rates: 50, dollar: 70, reserveAdequacy: 60, curve: 40,
      },
      regimeSample: {
        count: 26,
        selectedRegime: 'FLAT',
        modelVersion: 'champion-v1.0.0',
        configHash: 'a'.repeat(64),
        codeCommitSha: 'b'.repeat(40),
      },
      rawSmooth: {
        agreement: 'HIGH',
        sampleCount: 170,
        observationDate: '2024-01-03',
        availableDate: '2024-01-10',
      },
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
      evidence: {
        completeness: {
          validCount: 8,
          expectedCount: 8,
          validKeys: Object.keys(factors),
          invalidOrMissingKeys: [],
          score: 100,
          reason: 'FORMAL_FACTOR_COHORT_COMPLETE',
        },
        freshness: {
          statuses: {
            netliqTrend: 'OK', impulse: 'PARTIAL', credit: 'OK', funding: 'OK',
            rates: 'STALE', dollar: 'OK', reserveAdequacy: 'OK', curve: 'MISSING',
          },
          counts: { OK: 5, PARTIAL: 1, STALE: 1, MISSING: 1 },
          score: 68.75,
          reason: 'PERSISTED_FACTOR_FRESHNESS',
        },
        regimeSample: {
          uncappedCount: 26,
          cap: 52,
          selectedRegime: 'FLAT',
          governedRevisionCohort: {
            modelVersion: 'champion-v1.0.0',
            configHash: 'a'.repeat(64),
            codeCommitSha: 'b'.repeat(40),
          },
          score: 50,
          reason: 'SAME_REGIME_GOVERNED_REVISION_SAMPLE',
        },
        majorFactorAgreement: {
          directions: {
            netliqTrend: 'UP',
            dollar: 'UP',
            reserveAdequacy: 'UP',
            curve: 'DOWN',
          },
          counts: { up: 3, down: 1, neutral: 0 },
          score: 75,
          reason: 'MAJOR_FACTOR_DIRECTION_AGREEMENT',
        },
        rawSmooth: {
          agreement: 'HIGH',
          sampleCount: 170,
          observationDate: '2024-01-03',
          availableDate: '2024-01-10',
          score: 100,
          reason: 'RAW_SMOOTH_HIGH',
        },
      },
    });
  });

  it('fails closed for an unknown factor status at runtime', () => {
    expect(computeDualHorizonConfidence({
      formalFactors: factors,
      factorStatuses: {
        netliqTrend: 'UNKNOWN' as unknown as DualFactorStatus, impulse: 'OK', credit: 'OK', funding: 'OK',
        rates: 'OK', dollar: 'OK', reserveAdequacy: 'OK', curve: 'OK',
      },
      tacticalFactors: factors,
      regimeSample: {
        count: 26, selectedRegime: 'FLAT', modelVersion: 'champion-v1.0.0',
        configHash: 'a'.repeat(64), codeCommitSha: 'b'.repeat(40),
      },
      rawSmooth: {
        agreement: 'HIGH', sampleCount: 170,
        observationDate: '2024-01-03', availableDate: '2024-01-10',
      },
    })).toMatchObject({
      status: 'DATA_INCOMPLETE', reason: 'CONFIDENCE_INPUT_INCOMPLETE',
    });
  });

  it('fails closed for an unknown raw/smooth agreement at runtime', () => {
    expect(computeDualHorizonConfidence({
      formalFactors: factors,
      factorStatuses: {
        netliqTrend: 'OK', impulse: 'OK', credit: 'OK', funding: 'OK',
        rates: 'OK', dollar: 'OK', reserveAdequacy: 'OK', curve: 'OK',
      },
      tacticalFactors: factors,
      regimeSample: {
        count: 26, selectedRegime: 'FLAT', modelVersion: 'champion-v1.0.0',
        configHash: 'a'.repeat(64), codeCommitSha: 'b'.repeat(40),
      },
      rawSmooth: {
        agreement: 'UNKNOWN' as unknown as RawSmoothAgreement,
        sampleCount: 170, observationDate: '2024-01-03', availableDate: '2024-01-10',
      },
    })).toMatchObject({
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
  it.each([
    ['HIGH', 'HIGH'],
    ['LOW', 'LOW'],
    ['TRANSITION', 'TRANSITION'],
  ] as const)('reconstructs a cadence-valid %s Raw/Smooth outcome', (label, expected) => {
    const input = dualInputFromRawUnits(rawSmoothDirectionFixture(label));
    const result = rawSmoothAtDecision(
      input.liquidity.seriesMap,
      input.liquidity.decisionDate,
    );
    expect(result).toMatchObject({
      status: 'OK',
      agreement: expected,
      sampleCount: 170,
      observationDate: input.liquidity.seriesMap.WALCL.at(-1)!.date,
      availableDate: input.liquidity.decisionDate,
      reason: `RAW_SMOOTH_${expected}`,
    });
  });

  it('keeps the frozen Champion identity and formal snapshot unchanged after a Shadow read', () => {
    const input = dualInputFromRawUnits(syntheticResearchSeries(220));
    const formalSnapshotBeforeShadowRead = structuredClone(input.snapshots.snapshots.at(-1)!);

    const result = buildDualHorizonShadow(input.snapshots, input.liquidity);
    const formalSnapshotAfterShadowRead = input.snapshots.snapshots.at(-1)!;

    expect(DUAL_HORIZON_PROTOCOL.championChanged).toBe(false);
    expect(championConfigDigest()).toBe('17ad1ca8854b0fbd8e56d6255b7ee2f4fe8a85ae1a95a328ade46ffdff02a0cf');
    expect(CHAMPION_MODEL_VERSION).toBe('champion-v1.0.0');
    expect(result.championChanged).toBe(false);
    expect(formalSnapshotAfterShadowRead).toEqual(formalSnapshotBeforeShadowRead);
  });

  it('maps baseExposure through the unchanged formal portfolio policy', () => {
    const input = dualInputFromRawUnits(syntheticResearchSeries(220));
    const selected = input.snapshots.snapshots.at(-1)!;
    const result = buildDualHorizonShadow(input.snapshots, input.liquidity);
    expect(result.status).toBe('OK');
    if (result.status !== 'OK') return;
    expect(result.baseExposure).toBe(mapPortfolioPolicy({
      score: selected.score,
      verdict: selected.verdict as 'BULLISH' | 'NEUTRAL' | 'BEARISH',
      netliqDir: selected.netliqDir as 'UP' | 'DOWN' | 'FLAT',
      stressStatus: snapshotVixStressStatus(selected.snapshotVixEod),
    }).targetExposure);
  });

  it('counts only the same regime and governed revision cohort, never dataRunId', () => {
    const input = dualInputFromRawUnits(syntheticResearchSeries(220));
    const selected = input.snapshots.snapshots.at(-1)!;
    const eligibleDifferentRun = {
      ...selected,
      date: isoDate(Date.parse(`${selected.date}T00:00:00Z`) - 7 * DAY_MS),
      dataRunId: 'different-formal-run',
    };
    input.snapshots.snapshots = [
      eligibleDifferentRun,
      { ...eligibleDifferentRun, dataRunId: 'wrong-regime', qeQtRegime: 'EXPANDING' },
      { ...eligibleDifferentRun, dataRunId: 'wrong-model', modelVersion: 'champion-v0.9.0' },
      { ...eligibleDifferentRun, dataRunId: 'wrong-config', configHash: 'c'.repeat(64) },
      { ...eligibleDifferentRun, dataRunId: 'wrong-code', codeCommitSha: 'd'.repeat(40) },
      selected,
    ];
    input.snapshots.provenance.rowCount = input.snapshots.snapshots.length;

    const result = buildDualHorizonShadow(input.snapshots, input.liquidity);
    expect(result.status).toBe('OK');
    if (result.status !== 'OK') return;
    expect(result.confidenceEvidence.regimeSample).toMatchObject({
      uncappedCount: 1,
      selectedRegime: 'FLAT',
      governedRevisionCohort: {
        modelVersion: selected.modelVersion,
        configHash: selected.configHash,
        codeCommitSha: selected.codeCommitSha,
      },
    });
  });

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
      sampleCount: 170,
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
      reasons: ['MISSING_RAW_SMOOTH_HISTORY'],
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

  it('fails closed when historical RRP is stale despite five fresh final anchors', () => {
    const input = dualInputFromRawUnits(syntheticResearchSeries(220));
    const rrp = input.liquidity.seriesMap.RRPONTSYD;
    input.liquidity.seriesMap.RRPONTSYD = [
      ...rrp.slice(0, 5),
      ...rrp.slice(-25),
    ];
    expect(rawSmoothAtDecision(
      input.liquidity.seriesMap,
      input.liquidity.decisionDate,
    )).toMatchObject({
      status: 'DATA_INCOMPLETE',
      reason: 'MISSING_RAW_SMOOTH_HISTORY',
    });
  });

  it('fails closed for an irregular weekly anchor inside the governed window', () => {
    const input = dualInputFromRawUnits(syntheticResearchSeries(220));
    input.liquidity.seriesMap.WALCL.splice(-20, 1);
    expect(rawSmoothAtDecision(
      input.liquidity.seriesMap,
      input.liquidity.decisionDate,
    )).toMatchObject({
      status: 'DATA_INCOMPLETE',
      reason: 'MISSING_RAW_SMOOTH_HISTORY',
    });
  });

  it('requires 66 aligned weekly points for 13-week features and 52 prior MAD values', () => {
    const insufficient = dualInputFromRawUnits(syntheticResearchSeries(65));
    expect(rawSmoothAtDecision(
      insufficient.liquidity.seriesMap,
      insufficient.liquidity.decisionDate,
    )).toMatchObject({
      status: 'DATA_INCOMPLETE',
      reason: 'MISSING_RAW_SMOOTH_HISTORY',
    });
    const minimum = dualInputFromRawUnits(syntheticResearchSeries(66));
    expect(rawSmoothAtDecision(
      minimum.liquidity.seriesMap,
      minimum.liquidity.decisionDate,
    )).toMatchObject({
      status: 'OK',
      sampleCount: 66,
    });
  });

  it.each([
    ['missing', undefined],
    ['non-finite', Number.NaN],
    ['out of range', 101],
  ])('fails closed with 7/8 diagnostics when persisted netliqTrend is %s', (_label, value) => {
    const input = dualInputFromRawUnits(syntheticResearchSeries(220));
    input.snapshots.snapshots.at(-1)!.factors.netliqTrend = value;
    expect(buildDualHorizonShadow(input.snapshots, input.liquidity)).toMatchObject({
      status: 'DATA_INCOMPLETE',
      reasons: ['MISSING_FORMAL_FACTOR_COHORT'],
      availableDiagnostics: {
        completeness: {
          validCount: 7,
          expectedCount: 8,
          invalidOrMissingKeys: ['netliqTrend'],
          score: 87.5,
          reason: 'FORMAL_FACTOR_COHORT_INCOMPLETE',
        },
      },
      championChanged: false,
    });
  });
});
