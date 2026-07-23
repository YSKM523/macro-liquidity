import { describe, expect, it } from 'vitest';
// @ts-ignore Vitest executes in Node.
import { createHash } from 'node:crypto';
// @ts-ignore Vitest executes in Node.
import { readFileSync } from 'node:fs';
import { addDays } from '../src/backtest';
import { WEIGHTS } from '../src/config';
import type { SeriesMap } from '../src/metrics';
import {
  LIQUIDITY_STRUCTURE_PROTOCOL,
  buildEightFactorBenchmarks,
  buildFundingCreditAblations,
  canonicalLiquidityStructureProtocol,
  evaluateFundingCreditAblation,
  evaluateTgaBuffer,
  scorePolicyAwareWalcl,
} from '../src/liquidity-structure-challenger';
import { championConfigDigest, CHAMPION_MODEL_VERSION } from '../src/model-version';
import type { EventBacktestInputs } from '../src/event-backtest';

function weeklySeries(count = 60): SeriesMap {
  const map: SeriesMap = { WDTGAL: [], RRPONTSYD: [] };
  for (let index = 0; index < count; index++) {
    const date = addDays('2020-01-01', index * 7);
    map.WDTGAL.push({ date, value: 1_000 + index * 10 });
    map.RRPONTSYD.push({ date, value: 100 + index });
  }
  return map;
}

describe('frozen liquidity-structure protocol', () => {
  it('matches both registered digests and keeps Champion promotion disabled', () => {
    const text = readFileSync('docs/research/LIQUIDITY_STRUCTURE_CHALLENGER_PROTOCOL.json', 'utf8');
    const artifact = JSON.parse(text);
    expect(createHash('sha256').update(text).digest('hex'))
      .toBe('946b95679e2bbacb618251969ebb7967d8a82541d277c72297b6b0a5023cbfa0');
    expect(createHash('sha256').update(canonicalLiquidityStructureProtocol(artifact)).digest('hex'))
      .toBe('b9560fe595969a7f6f8420d48cdaf8f2cfd3ad45f616974469d59115ea234c38');
    expect(LIQUIDITY_STRUCTURE_PROTOCOL).toMatchObject({
      protocol: 'LIQUIDITY_STRUCTURE_CHALLENGER_V1', mode: 'SHADOW_ONLY',
      championChange: false, canonicalDigest: 'b9560fe595969a7f6f8420d48cdaf8f2cfd3ad45f616974469d59115ea234c38',
    });
  });
});

describe('prior-only TGA shock and RRP buffer', () => {
  it('uses only RRP alignments before the current TGA row and applies the frozen multiplier', () => {
    const map = weeklySeries();
    const currentDate = map.WDTGAL.at(-1)!.date;
    map.RRPONTSYD.at(-1)!.value = 1_000_000; // same-date value must not affect the prior buffer.
    expect(evaluateTgaBuffer(map, currentDate)).toMatchObject({
      status: 'OK', tgaShock: 10, bufferState: 'SUFFICIENT', bufferMultiplier: .25,
      effectiveTgaShock: 2.5, thresholdSampleN: 58,
    });
  });

  it('classifies depleted/low/sufficient at exact Type-7 q20/q50 boundaries', () => {
    const map = weeklySeries();
    const currentDate = map.WDTGAL.at(-1)!.date;
    const priorDate = map.WDTGAL.at(-2)!.date;
    const priorRrp = map.RRPONTSYD.find(row => row.date === priorDate)!;
    const base = evaluateTgaBuffer(map, currentDate);
    expect(base.status).toBe('OK');
    priorRrp.value = base.q20!;
    expect(evaluateTgaBuffer(map, currentDate).bufferState).toBe('DEPLETED');
    priorRrp.value = base.q50!;
    expect(evaluateTgaBuffer(map, currentDate).bufferState).toBe('LOW');
    priorRrp.value = base.q50! + .0001;
    expect(evaluateTgaBuffer(map, currentDate).bufferState).toBe('SUFFICIENT');
  });

  it('fails typed on insufficient history, broken weekly cadence, and missing RRP alignment', () => {
    expect(evaluateTgaBuffer(weeklySeries(20), '2025-01-01')).toMatchObject({
      status: 'INSUFFICIENT_RRP_HISTORY', effectiveTgaShock: null,
    });
    const cadence = weeklySeries();
    cadence.WDTGAL.at(-1)!.date = addDays(cadence.WDTGAL.at(-2)!.date, 11);
    expect(evaluateTgaBuffer(cadence, cadence.WDTGAL.at(-1)!.date)).toMatchObject({
      status: 'INVALID_TGA_CADENCE', effectiveTgaShock: null,
    });
    const missing = weeklySeries();
    missing.RRPONTSYD = [];
    expect(evaluateTgaBuffer(missing, missing.WDTGAL.at(-1)!.date)).toMatchObject({
      status: 'MISSING_RRP_ALIGNMENT', effectiveTgaShock: null,
    });
  });
});

describe('policy-aware WALCL interpretation', () => {
  it('uses the frozen regime/impulse matrix and fails closed for crisis or unknown', () => {
    expect(scorePolicyAwareWalcl('QE', 'EXPANDING')).toEqual({ status: 'OK', score: 80 });
    expect(scorePolicyAwareWalcl('QT', 'CONTRACTING')).toEqual({ status: 'OK', score: 30 });
    expect(scorePolicyAwareWalcl('RESERVE_MANAGEMENT', 'FLAT')).toEqual({ status: 'OK', score: 52.5 });
    expect(scorePolicyAwareWalcl('REINVESTMENT_ONLY', 'EXPANDING')).toEqual({ status: 'OK', score: 52.5 });
    expect(scorePolicyAwareWalcl('NEUTRAL', 'CONTRACTING')).toEqual({ status: 'OK', score: 45 });
    expect(scorePolicyAwareWalcl('CRISIS_LIQUIDITY', 'EXPANDING')).toEqual({
      status: 'CRISIS_POLICY_SEPARATE', score: null,
    });
    expect(scorePolicyAwareWalcl('UNKNOWN', 'FLAT')).toEqual({ status: 'POLICY_UNAVAILABLE', score: null });
  });
});

describe('eight-factor weight and funding/credit ablations', () => {
  const factors = {
    netliqTrend: 80, impulse: 60, credit: 20, funding: 40,
    rates: 50, dollar: 70, reserveAdequacy: 60, curve: 90, vol: 100,
  };

  it('uses exactly eight positive-weight factors and excludes vol from every benchmark', () => {
    const expectedCurrent = Object.entries(WEIGHTS)
      .filter(([key]) => key !== 'vol')
      .reduce((sum, [key, weight]) => sum + factors[key as keyof typeof factors] * weight, 0);
    const expectedEqual = ['netliqTrend', 'impulse', 'credit', 'funding', 'rates', 'dollar', 'reserveAdequacy', 'curve']
      .reduce((sum, key) => sum + factors[key as keyof typeof factors], 0) / 8;
    const result = buildEightFactorBenchmarks(factors);
    expect(result).toMatchObject({ status: 'OK', factorCount: 8, current8: expectedCurrent, equal8: expectedEqual });
    expect(result.blend8).toBeCloseTo((expectedCurrent + expectedEqual) / 2);
    expect(buildEightFactorBenchmarks({ ...factors, vol: 0 })).toEqual(result);
    expect(buildEightFactorBenchmarks({ ...factors, curve: undefined })).toMatchObject({
      status: 'INCOMPLETE_FACTOR_COHORT', equal8: null, current8: null, blend8: null,
    });
  });

  it('renormalizes remaining weights for all four preregistered ablation arms', () => {
    const result = buildFundingCreditAblations(factors);
    expect(result.status).toBe('OK');
    if (result.status !== 'OK') throw new Error('expected complete ablation cohort');
    expect(result.arms.A_CURRENT_8.score).toBeCloseTo(buildEightFactorBenchmarks(factors).current8!);
    expect(result.arms.B_WITHOUT_CREDIT.score).toBeCloseTo(
      (result.arms.A_CURRENT_8.score! - factors.credit * WEIGHTS.credit) / (1 - WEIGHTS.credit),
    );
    expect(result.arms.C_WITHOUT_FUNDING.score).toBeCloseTo(
      (result.arms.A_CURRENT_8.score! - factors.funding * WEIGHTS.funding) / (1 - WEIGHTS.funding),
    );
    expect(result.arms.D_WITHOUT_CREDIT_FUNDING.score).toBeCloseTo(
      (result.arms.A_CURRENT_8.score! - factors.credit * WEIGHTS.credit - factors.funding * WEIGHTS.funding)
        / (1 - WEIGHTS.credit - WEIGHTS.funding),
    );
    expect(result.fragilitySidecar).toEqual({ credit: 20, funding: 40 });
  });
});

function formalAblationInputs(): EventBacktestInputs {
  const start = Date.parse('2023-01-02T00:00:00Z');
  const date = (days: number) => new Date(start + days * 86_400_000).toISOString().slice(0, 10);
  const timestamp = (days: number, time = '12:00:00') => `${date(days)}T${time}Z`;
  const scores = [60, 50, 40, 50, 62, 48, 38, 52, 65, 50, 35, 50, 61, 47, 39, 53, 64, 49, 37, 51];
  const factorKeys = ['netliqTrend', 'impulse', 'credit', 'funding', 'rates', 'dollar', 'reserveAdequacy', 'curve'];
  const asOfCutoff = '2024-01-01T00:00:00Z';
  return {
    asOfCutoff,
    signals: scores.map((score, index) => ({
      signalDate: date(index * 7), decisionAt: timestamp(index * 7), tradableAt: timestamp(index * 7),
      score, verdict: score > 55 ? 'BULLISH' : score < 45 ? 'BEARISH' : 'NEUTRAL',
      netliqDir: index % 3 === 0 ? 'DOWN' : 'UP', snapshotVixEod: 20,
      targetExposure: score > 55 ? 1 : score < 45 ? .25 : .75,
      portfolioTier: score > 55 ? 'STRONG_TAILWIND' : score < 45 ? 'HEADWIND' : 'NEUTRAL',
      portfolioMethodology: 'DASHBOARD_EXPOSURE_TIERS_V1', stressMethodology: 'PIT_SNAPSHOT_VIX_PROXY',
      factors: Object.fromEntries(factorKeys.map(key => [key, score])),
      recordedAt: timestamp(index * 7, '12:00:01'), createdAt: timestamp(index * 7, '12:00:01'),
      dataCutoff: timestamp(index * 7, '11:59:59'), dataRunId: `signal-${index}`,
      modelVersion: CHAMPION_MODEL_VERSION, configHash: championConfigDigest(),
      codeCommitSha: '0123456789abcdef0123456789abcdef01234567',
    })),
    prices: Array.from({ length: 260 }, (_, index) => ({
      date: date(index), adjustedClose: 100 + index * .2 + Math.sin(index / 5) * 2,
      source: 'FRED:SP500', fetchedAt: '2023-12-01T00:00:00Z', dataRunId: 'price-run',
      activationRunId: `price-activation-${index}`, activatedAt: '2023-12-02T00:00:00Z',
      provenanceStatus: 'PIT_RAW' as const,
    })),
    vix: Array.from({ length: 260 }, (_, index) => ({
      date: date(index), value: 20, source: 'FRED:VIXCLS', fetchedAt: '2023-12-01T00:00:00Z',
      dataRunId: 'vix-run', activationRunId: `vix-activation-${index}`,
      activatedAt: '2023-12-02T00:00:00Z', provenanceStatus: 'PIT_RAW' as const,
    })),
    cashRates: Array.from({ length: 261 }, (_, index) => ({
      date: date(index - 1), rate: 5, source: 'FRED:SOFR', fetchedAt: '2023-12-01T00:00:00Z',
      dataRunId: 'cash-run', activationRunId: `cash-activation-${index}`,
      activatedAt: '2023-12-02T00:00:00Z', provenanceStatus: 'PIT_RAW' as const,
    })),
  };
}

describe('formal funding/credit ablation evaluation', () => {
  it('runs one hysteresis path per arm on one complete governed cohort and reports every frozen metric', () => {
    const result = evaluateFundingCreditAblation(formalAblationInputs());
    expect(result).toMatchObject({
      status: 'OK', reason: null,
      cohort: { signalCount: 20, completeFactorCount: 20, provenance: 'GOVERNED_PIT' },
      primaryHorizonWeeks: 13, secondaryHorizonWeeks: [4, 8], championChange: false,
    });
    expect(Object.keys(result.arms)).toEqual([
      'A_CURRENT_8', 'B_WITHOUT_CREDIT', 'C_WITHOUT_FUNDING', 'D_WITHOUT_CREDIT_FUNDING',
    ]);
    for (const arm of Object.values(result.arms)) {
      expect(arm.verdictTrace.slice(0, 4)).toEqual(['BULLISH', 'BULLISH', 'BEARISH', 'BEARISH']);
      expect(Object.keys(arm.horizons)).toEqual(['4', '8', '13']);
      expect(arm.horizons[13]).toMatchObject({ overlapping: { n: expect.any(Number) }, independent: { n: expect.any(Number) } });
      expect(arm.horizons[13].independent.n).toBeLessThan(arm.horizons[13].overlapping.n);
      expect(arm.portfolio).toMatchObject({
        strategySharpe: expect.any(Number), betaMatchedSharpe: expect.any(Number),
        betaMatchedSharpeDelta: expect.any(Number), maxDrawdown: expect.any(Number),
      });
      expect(arm.horizons[13].tailLossQ10).toEqual(expect.any(Number));
    }
  });

  it('fails closed for a mixed or incomplete cohort instead of changing the sample by arm', () => {
    const incomplete = formalAblationInputs();
    delete incomplete.signals[3].factors!.credit;
    expect(evaluateFundingCreditAblation(incomplete)).toMatchObject({
      status: 'DATA_INCOMPLETE', reason: 'INCOMPLETE_FACTOR_COHORT', arms: {},
    });
    const legacy = formalAblationInputs();
    legacy.signals[0].modelVersion = 'LEGACY_UNVERSIONED';
    legacy.signals[0].configHash = 'LEGACY_UNVERSIONED';
    legacy.signals[0].codeCommitSha = 'LEGACY_UNVERSIONED';
    expect(evaluateFundingCreditAblation(legacy)).toMatchObject({
      status: 'DATA_INCOMPLETE', reason: 'NON_GOVERNED_SIGNAL_COHORT', arms: {},
    });
  });
});
