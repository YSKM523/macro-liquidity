import { describe, expect, it } from 'vitest';
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
      protocolDigest: '891f77f991ca40521639dee3ab50418999e4c3d9296e7bd675f693ee3801efa2',
      horizonsWeeks: [4, 8, 13], alpha: .05,
    });
    expect(SCORE_STRESS_PROTOCOL.events).toHaveLength(8);
    expect(SCORE_STRESS_PROTOCOL.events.at(-1)).toMatchObject({ id: '2025_2026_RESERVE_MGMT', from: '2025-01-01', to: '2027-01-01' });
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
    expect(buildFormalOutcomes(immature).map(row => row.status)).toEqual(['OK', 'PENDING_OUTCOME', 'PENDING_OUTCOME']);
    immature.prices[0] = { ...immature.prices[0], provenanceStatus: 'SYNTHETIC_BACKFILL' };
    expect(() => buildFormalOutcomes(immature)).toThrow(/PIT_RAW/);
  });
});

describe('score buckets', () => {
  const outcome = (score: number, totalReturn: number, entryDate: string, exitDate: string, worstDrawdown = -.1) => ({
    horizonWeeks: 4 as const, status: 'OK' as const, score, totalReturn, worstDrawdown,
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
    expect(buckets.find(row => row.bucketId === '0_20' && row.horizonWeeks === 4)).toMatchObject({
      n: 5, independentN: 5, mean: .04, median: 0, negativeProbability: .4, q10: -.22,
      worstEpisodeDrawdown: -.09, status: 'OK', probabilityStatus: 'OK', q10Status: 'OK',
    });
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
    expect(complete.expectedMaximumSharpe).toBeCloseTo(.76053, 4);
    expect(complete.value).toBeCloseTo(1, 6);
    expect(deflatedSharpeRatio({
      observedSharpe: 1.2, trialSharpes: [.2, null, .6], sampleT: 252, skewness: 0, kurtosis: 3,
    })).toEqual({ status: 'TRIAL_UNIVERSE_INCOMPLETE', value: null, expectedMaximumSharpe: null, trialCount: 3 });
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
    const atFrom = { ...base, entryDate: '2018-10-01', exitDate: '2018-10-29' };
    const atTo = { ...base, entryDate: '2019-01-01', exitDate: '2019-01-29' };
    expect(evaluateStressEvents([atFrom, atTo], '2027-01-02').find(event => event.id === '2018_Q4'))
      .toMatchObject({ status: 'OK', outcomeCount: 1 });
    expect(evaluateStressEvents([{ ...atFrom, status: 'PENDING_OUTCOME', totalReturn: null, worstDrawdown: null }], '2027-01-02')
      .find(event => event.id === '2018_Q4')).toMatchObject({ status: 'PENDING_OUTCOME' });
    expect(evaluateStressEvents([{ ...atFrom, priceProvenance: 'LEGACY_NO_PIT' as const }], '2027-01-02')
      .find(event => event.id === '2018_Q4')).toMatchObject({ status: 'NON_PIT_PRICE_COVERAGE' });
  });
});
