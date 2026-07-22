import { describe, expect, it } from 'vitest';
// @ts-ignore Vitest executes in Node.
import { readFileSync } from 'node:fs';
// @ts-ignore Vitest executes in Node.
import { createHash } from 'node:crypto';
import { addDays } from '../src/backtest';
import { buildFormalForwardPairs } from '../src/evaluation-protocol';
import type { EventBacktestInputs } from '../src/event-backtest';
import { championConfigDigest, CHAMPION_MODEL_VERSION } from '../src/model-version';
import {
  SCORE_STRESS_PROTOCOL,
  benjaminiHochberg,
  buildFormalOutcomes,
  buildScoreBuckets,
  deflatedSharpeRatio,
  evaluateStressEvents,
  canonicalScoreStressProtocol,
  validateHypothesisLedger,
} from '../src/score-stress-diagnostics';

function formalInput(): EventBacktestInputs {
  const priceDates = Array.from({ length: 130 }, (_, index) => addDays('2024-01-05', index));
  return {
    asOfCutoff: '2025-01-01T00:00:00Z',
    signals: [{
      signalDate: '2024-01-03', decisionAt: '2024-01-04T18:00:00Z', tradableAt: '2024-01-04T18:00:00Z',
      score: 65, verdict: 'BULLISH', targetExposure: 1, factors: { netliqTrend: 65 },
      modelVersion: CHAMPION_MODEL_VERSION, configHash: championConfigDigest(),
      codeCommitSha: '0123456789abcdef0123456789abcdef01234567', dataRunId: 'signal-run',
      recordedAt: '2024-01-04T19:00:00Z', dataCutoff: '2024-01-04T17:00:00Z', createdAt: '2024-01-04T19:00:01Z',
    }],
    prices: priceDates.map((date, index) => ({
      date, adjustedClose: index === 20 ? 90 : 100 + index, source: 'PIT', provenanceStatus: 'PIT_RAW' as const,
      fetchedAt: `${date}T22:00:00Z`, dataRunId: 'price-run', activationRunId: `act-${index}`,
      activatedAt: `${date}T23:00:00Z`,
    })),
    vix: [], cashRates: [],
  };
}

describe('registered score/stress protocol', () => {
  it('freezes the result-before-code registration and all event boundaries', () => {
    expect(SCORE_STRESS_PROTOCOL).toMatchObject({
      protocol: 'SCORE_STRESS_DIAGNOSTICS_V1',
      registeredAt: '2026-07-22T20:36:03Z',
      registrationCommit: 'd7aba3c2b5bd79cfaf7847cdc82770abb499fdcd',
      protocolDigest: '3ea92b2fc2f11745ab8f4810d9bab940f4ce4bed7892a50229822524176f38b3',
      horizonsWeeks: [4, 8, 13], alpha: .05,
    });
    expect(SCORE_STRESS_PROTOCOL.events).toHaveLength(8);
    expect(SCORE_STRESS_PROTOCOL.events.at(-1)).toMatchObject({ id: '2025_2026_RESERVE_MGMT', from: '2025-01-01', to: '2027-01-01' });
    const artifact = JSON.parse(readFileSync('docs/research/SCORE_STRESS_DIAGNOSTICS_PROTOCOL.json', 'utf8'));
    expect(createHash('sha256').update(canonicalScoreStressProtocol(artifact)).digest('hex'))
      .toBe(SCORE_STRESS_PROTOCOL.protocolDigest);
  });
});

describe('shared formal event-time outcomes', () => {
  it('builds 4/8/13 week outcomes with target-date first actual PIT closes and drawdown', () => {
    const outcomes = buildFormalOutcomes(formalInput());
    expect(outcomes.map(row => [row.horizonWeeks, row.entryDate, row.exitDate, row.status])).toEqual([
      [4, '2024-01-05', '2024-02-02', 'OK'],
      [8, '2024-01-05', '2024-03-01', 'OK'],
      [13, '2024-01-05', '2024-04-05', 'OK'],
    ]);
    expect(outcomes[0]).toMatchObject({
      modelDate: '2024-01-03', decisionAt: '2024-01-04T18:00:00Z', tradableAt: '2024-01-04T18:00:00Z',
      score: 65, totalReturn: expect.any(Number), worstDrawdown: expect.any(Number), priceProvenance: 'PIT_RAW',
    });
    expect(outcomes[0].worstDrawdown).toBeLessThan(0);
  });

  it('keeps the PR-15 13-week golden label exactly identical', () => {
    const input = formalInput();
    const old = buildFormalForwardPairs(input)[0];
    const current = buildFormalOutcomes(input).find(row => row.horizonWeeks === 13)!;
    expect({
      modelDate: current.modelDate, decisionAt: current.decisionAt, tradableAt: current.tradableAt,
      entryDate: current.entryDate, exitDate: current.exitDate, score: current.score, fwd: current.totalReturn,
    }).toEqual({
      modelDate: old.modelDate, decisionAt: old.decisionAt, tradableAt: old.tradableAt,
      entryDate: old.entryDate, exitDate: old.exitDate, score: old.score, fwd: old.fwd,
    });
  });

  it('returns typed pending outcomes and fails closed on non-PIT prices', () => {
    const immature = formalInput();
    immature.prices = immature.prices.slice(0, 40);
    immature.asOfCutoff = '2024-03-10T00:00:00Z';
    expect(buildFormalOutcomes(immature).map(row => row.status)).toEqual(['OK', 'PENDING_OUTCOME', 'PENDING_OUTCOME']);
    immature.prices[0] = { ...immature.prices[0], provenanceStatus: 'SYNTHETIC_BACKFILL' };
    expect(() => buildFormalOutcomes(immature)).toThrow(/PIT_RAW/);
  });

  it('distinguishes mature missing-price coverage and enforces the shared PR-15 signal gate', () => {
    const gap = formalInput();
    gap.prices = gap.prices.slice(0, 40);
    expect(buildFormalOutcomes(gap).map(row => row.status)).toEqual(['OK', 'MISSING_PRICE_COVERAGE', 'MISSING_PRICE_COVERAGE']);
    const missingFactors = formalInput();
    missingFactors.signals[0] = { ...missingFactors.signals[0], factors: undefined };
    expect(() => buildFormalOutcomes(missingFactors)).toThrow(/factors/i);
    const missingPolicy = formalInput();
    missingPolicy.signals[0] = { ...missingPolicy.signals[0], targetExposure: undefined };
    expect(() => buildFormalOutcomes(missingPolicy)).toThrow(/policy/i);
    const missingProvenance = formalInput();
    missingProvenance.signals[0] = { ...missingProvenance.signals[0], dataRunId: undefined };
    expect(() => buildFormalOutcomes(missingProvenance)).toThrow(/provenance/i);
  });
});

describe('score buckets', () => {
  const outcome = (score: number, totalReturn: number, entryDate: string, exitDate: string, worstDrawdown = -.1) => ({
    horizonWeeks: 4 as const, status: 'OK' as const, reason: null, score, totalReturn, worstDrawdown,
    modelDate: entryDate, decisionAt: `${entryDate}T00:00:00Z`, tradableAt: `${entryDate}T00:00:00Z`,
    entryDate, exitDate, targetDate: exitDate, verdict: 'NEUTRAL' as const, targetExposure: .75,
    priceProvenance: 'PIT_RAW' as const, modelVersion: CHAMPION_MODEL_VERSION,
    configHash: championConfigDigest(), codeCommitSha: '0123456789abcdef0123456789abcdef01234567', dataRunId: 'run',
  });

  it('uses every exact boundary once, including closed score 100', () => {
    const rows = [0, 20, 35, 45, 55, 65, 80, 100].map((score, index) =>
      outcome(score, index / 100, addDays('2020-01-01', index * 100), addDays('2020-01-29', index * 100)));
    const buckets = buildScoreBuckets(rows).filter(row => row.horizonWeeks === 4);
    expect(buckets.map(row => row.n)).toEqual([1, 1, 1, 1, 1, 1, 2]);
    expect(() => buildScoreBuckets([outcome(100.01, 0, '2020-01-01', '2020-01-29')])).toThrow(/score/i);
    expect(() => buildScoreBuckets([outcome(Number.NaN, 0, '2020-01-01', '2020-01-29')])).toThrow(/score/i);
  });

  it('always returns 7 x 3 typed rows and applies small-sample/q10/negative rules', () => {
    const returns = [-.3, -.1, 0, .1, .5];
    const rows = returns.map((value, index) =>
      outcome(10, value, addDays('2020-01-01', index * 35), addDays('2020-01-29', index * 35), -.05 - index / 100));
    const buckets = buildScoreBuckets(rows);
    expect(buckets).toHaveLength(21);
    const populated = buckets.find(row => row.bucketId === '0_20' && row.horizonWeeks === 4)!;
    expect(populated).toMatchObject({
      n: 5, independentN: 5, median: 0, negativeProbability: .4,
      worstEpisodeDrawdown: -.09, status: 'OK', probabilityStatus: 'OK', q10Status: 'OK',
    });
    expect(populated.mean).toBeCloseTo(.04);
    expect(populated.q10).toBeCloseTo(-.22);
    expect(buckets.find(row => row.bucketId === '20_35' && row.horizonWeeks === 4)).toMatchObject({
      n: 0, independentN: 0, mean: null, median: null, negativeProbability: null, q10: null,
      worstEpisodeDrawdown: null, status: 'NO_OBSERVATIONS',
    });
    expect(buildScoreBuckets(rows.slice(0, 4)).find(row => row.bucketId === '0_20' && row.horizonWeeks === 4))
      .toMatchObject({ negativeProbability: null, q10: null, probabilityStatus: 'INSUFFICIENT_SAMPLE', q10Status: 'INSUFFICIENT_SAMPLE' });
  });

  it('reports interval-non-overlapping counts independently per bucket and horizon', () => {
    const rows = [
      outcome(50, .1, '2020-01-01', '2020-02-01'),
      outcome(50, .2, '2020-01-15', '2020-02-15'),
      outcome(50, .3, '2020-02-01', '2020-03-01'),
    ];
    expect(buildScoreBuckets(rows).find(row => row.bucketId === '45_55' && row.horizonWeeks === 4))
      .toMatchObject({ n: 3, independentN: 2 });
  });
});

describe('multiplicity', () => {
  it('validates the append-only ledger full schema, canonical hashes, and supersession graph', () => {
    const ledger = JSON.parse(readFileSync('docs/research/SCORE_STRESS_HYPOTHESIS_LEDGER.json', 'utf8'));
    const validated = validateHypothesisLedger(ledger);
    expect(validated.entries).toHaveLength(4);
    expect(validated.entries[0]).toEqual(expect.objectContaining({
      hypothesisId: expect.any(String), candidateId: expect.any(String), evidenceClass: expect.any(String),
      direction: expect.any(String), windows: expect.any(Array), canonicalParameters: expect.any(Object),
      parameterHash: expect.stringMatching(/^[a-f0-9]{64}$/), primaryMetric: expect.any(String),
      pValue: null, pValueSource: 'NOT_AVAILABLE', formalDailySharpe: null,
      preregisteredThreshold: expect.any(Object), registeredAt: expect.any(String),
      registrationCommit: expect.stringMatching(/^[a-f0-9]{40}$/), status: expect.any(String), supersedes: null,
    }));
    expect(validated.entries[1].supersedes).toBe(validated.entries[0].hypothesisId);
  });

  it('rejects duplicate IDs, duplicate parameter hashes in a family, bad hashes, and dangling supersession', () => {
    const ledger = validateHypothesisLedger(JSON.parse(readFileSync('docs/research/SCORE_STRESS_HYPOTHESIS_LEDGER.json', 'utf8')));
    const clone = () => structuredClone(ledger);
    const duplicateId = clone();
    duplicateId.entries[1].hypothesisId = duplicateId.entries[0].hypothesisId;
    expect(() => validateHypothesisLedger(duplicateId)).toThrow(/duplicate hypothesis/i);
    const duplicateHash = clone();
    duplicateHash.entries[1].parameterHash = duplicateHash.entries[0].parameterHash;
    duplicateHash.entries[1].canonicalParameters = duplicateHash.entries[0].canonicalParameters;
    expect(() => validateHypothesisLedger(duplicateHash)).toThrow(/duplicate parameter hash/i);
    const badHash = clone();
    badHash.entries[0].parameterHash = '0'.repeat(64);
    expect(() => validateHypothesisLedger(badHash)).toThrow(/parameter hash/i);
    const dangling = clone();
    dangling.entries[1].supersedes = 'ABSENT';
    expect(() => validateHypothesisLedger(dangling)).toThrow(/supersedes/i);
  });

  it('runs BH independently by family, stably breaks ties, treats missing p as one, and rejects duplicate ids', () => {
    const result = benjaminiHochberg([
      { hypothesisId: 'b', family: 'F1', pValue: .01 },
      { hypothesisId: 'a', family: 'F1', pValue: .01 },
      { hypothesisId: 'c', family: 'F1', pValue: null },
      { hypothesisId: 'z', family: 'F2', pValue: .04 },
    ]);
    expect(result.map(row => [row.hypothesisId, row.rank, row.adjustedP, row.rejected])).toEqual([
      ['a', 1, .015, true], ['b', 2, .015, true], ['c', 3, 1, false], ['z', 1, .04, true],
    ]);
    expect(() => benjaminiHochberg([
      { hypothesisId: 'a', family: 'F', pValue: .1 }, { hypothesisId: 'a', family: 'F', pValue: .2 },
    ])).toThrow(/duplicate/i);
  });

  it('computes the registered Bailey-Lopez de Prado DSR and returns null for an incomplete trial universe', () => {
    const complete = deflatedSharpeRatio({
      observedSharpe: 1.2, trialSharpes: [.2, .4, .6, .8], sampleT: 252, skewness: -.2, kurtosis: 3.5,
    });
    expect(complete.status).toBe('OK');
    // Hand check: sample variance=1/15 and the registered Euler–Mascheroni interpolation gives 0.271656945.
    expect(complete.expectedMaximumSharpe).toBeCloseTo(.271656945, 8);
    expect(complete.value).toBeCloseTo(1, 6);
    expect(deflatedSharpeRatio({
      observedSharpe: 1.2, trialSharpes: [.2, null, .6], sampleT: 252, skewness: 0, kurtosis: 3,
    })).toEqual({ status: 'TRIAL_UNIVERSE_INCOMPLETE', value: null, expectedMaximumSharpe: null, trialCount: 3 });
    expect(deflatedSharpeRatio({ observedSharpe: .2, trialSharpes: [.1, .1], sampleT: 252, skewness: 0, kurtosis: 3 }))
      .toMatchObject({ status: 'ZERO_TRIAL_VARIANCE', value: null, expectedMaximumSharpe: null });
    expect(deflatedSharpeRatio({ observedSharpe: .2, trialSharpes: [.1], sampleT: 252, skewness: 0, kurtosis: 3 }))
      .toMatchObject({ status: 'INSUFFICIENT_TRIALS', value: null });
    expect(deflatedSharpeRatio({ observedSharpe: .2, trialSharpes: [.1, .2], sampleT: 1, skewness: 0, kurtosis: 3 }))
      .toMatchObject({ status: 'INSUFFICIENT_SAMPLE', value: null });
    expect(deflatedSharpeRatio({ observedSharpe: Number.NaN, trialSharpes: [.1, .2], sampleT: 252, skewness: 0, kurtosis: 3 }))
      .toMatchObject({ status: 'INVALID_INPUT', value: null });
  });
});

describe('stress events', () => {
  it('always returns all eight, honors half-open boundaries, keeps 2025-26 open, and types absent candidate', () => {
    const rows = buildFormalOutcomes(formalInput());
    const events = evaluateStressEvents(rows, '2026-07-22');
    expect(events).toHaveLength(8);
    expect(events.find(event => event.id === '2018_Q4')).toMatchObject({ status: 'NO_FORMAL_SIGNAL_COVERAGE', candidateComparison: { status: 'CANDIDATE_NOT_PROVIDED' } });
    expect(events.find(event => event.id === '2025_2026_RESERVE_MGMT')).toMatchObject({ status: 'OPEN_EVENT_WINDOW' });
  });

  it('includes from and excludes to, distinguishes pending and non-PIT coverage', () => {
    const base = buildFormalOutcomes(formalInput())[0];
    const atFrom = { ...base, entryDate: '2018-10-01', exitDate: '2018-10-29', verdict: 'BEARISH' as const, targetExposure: .25 };
    const atTo = { ...base, entryDate: '2019-01-01', exitDate: '2019-01-29' };
    const eventPrices = [100, 110, 80, 90].map((adjustedClose, index) => ({
      date: addDays('2018-10-01', index), adjustedClose, source: 'PIT', provenanceStatus: 'PIT_RAW' as const,
    }));
    expect(evaluateStressEvents([
      atFrom,
      { ...atFrom, horizonWeeks: 8 as const },
      { ...atFrom, horizonWeeks: 13 as const },
      atTo,
    ], '2027-01-02', eventPrices).find(event => event.id === '2018_Q4')).toMatchObject({
      status: 'OK', outcomeCount: 3, spxDrawdown: -0.2727272727272727,
      horizons: [
        { horizonWeeks: 4, n: 1, bearishN: 1, averageExposure: .25 },
        { horizonWeeks: 8, n: 1, bearishN: 1, averageExposure: .25 },
        { horizonWeeks: 13, n: 1, bearishN: 1, averageExposure: .25 },
      ],
    });
    expect(evaluateStressEvents([{ ...atFrom, status: 'PENDING_OUTCOME', totalReturn: null, worstDrawdown: null }], '2027-01-02')
      .find(event => event.id === '2018_Q4')).toMatchObject({ status: 'PENDING_OUTCOME' });
    expect(evaluateStressEvents([{ ...atFrom, priceProvenance: 'LEGACY_NO_PIT' as const }], '2027-01-02')
      .find(event => event.id === '2018_Q4')).toMatchObject({ status: 'NON_PIT_PRICE_COVERAGE' });
    expect(evaluateStressEvents([atFrom], '2027-01-02', eventPrices).find(event => event.id === '2018_Q4'))
      .toMatchObject({ status: 'PARTIAL_COVERAGE' });
  });
});
