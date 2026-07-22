import { describe, expect, it } from 'vitest';
import { evaluateValidationMetrics, quantile } from '../src/validation-metrics';
import type { ForwardPair } from '../src/evaluation-protocol';

function pair(index: number, score: number, fwd: number, verdict: ForwardPair['verdict'], targetExposure: number | null): ForwardPair {
  return {
    startIdx: index, endIdx: index + 1,
    signalDate: `2024-01-${String(index + 1).padStart(2, '0')}`,
    outcomeDate: `2024-05-${String(index + 1).padStart(2, '0')}`,
    score, fwd, verdict, targetExposure, factors: {},
  };
}

describe('validation metric taxonomy', () => {
  it('calculates direction and persisted-verdict rates with abstentions by hand', () => {
    const pairs = [
      pair(0, 60, .10, 'BULLISH', 1), pair(1, 40, -.10, 'BEARISH', .25),
      pair(2, 70, -.05, 'NEUTRAL', .75), pair(3, 30, .05, 'BULLISH', .5),
      pair(4, 50, .02, 'NEUTRAL', .75), pair(5, 55, 0, 'BEARISH', .25),
      pair(6, 80, .03, 'BULLISH', 1),
    ];
    const result = evaluateValidationMetrics(pairs, -.05);
    expect(result.direction).toMatchObject({ value: 3 / 5, hits: 3, n: 5, abstentions: 2, status: 'OK' });
    expect(result.formalVerdict).toMatchObject({ value: null, hits: 4, n: 4, abstentions: 3, status: 'INSUFFICIENT_SAMPLE' });
  });

  it('uses existing target exposure for risk precision and downside recall', () => {
    const pairs = [
      pair(0, 60, -.10, 'BULLISH', .5), pair(1, 60, -.08, 'BULLISH', 1),
      pair(2, 60, .04, 'BULLISH', .25), pair(3, 60, -.03, 'BULLISH', .5),
      pair(4, 60, .02, 'BULLISH', 1), pair(5, 60, .01, 'BULLISH', .75),
    ];
    const result = evaluateValidationMetrics(pairs, -.05);
    expect(result.risk.precision).toMatchObject({ value: null, hits: 2, n: 3, status: 'INSUFFICIENT_SAMPLE' });
    expect(result.risk.downsideRecall).toMatchObject({ value: null, hits: 2, n: 3, status: 'INSUFFICIENT_SAMPLE' });
  });

  it('returns Spearman IC and typed null for zero-variance outcomes', () => {
    const ok = evaluateValidationMetrics([
      pair(0, 10, -.2, 'BEARISH', .25), pair(1, 20, -.1, 'BEARISH', .25), pair(2, 30, .1, 'BULLISH', 1),
    ], -.15);
    expect(ok.ic).toMatchObject({ value: 1, n: 3, status: 'OK' });
    const empty = evaluateValidationMetrics([
      pair(0, 10, .1, 'BEARISH', .25), pair(1, 20, .1, 'BEARISH', .25), pair(2, 30, .1, 'BULLISH', 1),
    ], .1);
    expect(empty.ic).toEqual({ value: null, n: 3, status: 'ZERO_VARIANCE' });
    const constantScores = evaluateValidationMetrics([
      pair(0, 50, -.1, 'BEARISH', .25), pair(1, 50, .1, 'BULLISH', 1), pair(2, 50, .2, 'BULLISH', 1),
    ], -.05);
    expect(constantScores.ic).toEqual({ value: null, n: 3, status: 'ZERO_VARIANCE' });
  });

  it('calibrates q10 deterministically and types insufficient tail events as null', () => {
    expect(quantile(Array.from({ length: 20 }, (_, i) => i + 1), .1)).toBeCloseTo(2.9);
    const result = evaluateValidationMetrics([
      pair(0, 40, -.2, 'BEARISH', .25), pair(1, 60, -.1, 'BULLISH', 1),
      pair(2, 40, .1, 'BEARISH', .25), pair(3, 60, .2, 'BULLISH', 1), pair(4, 60, .3, 'BULLISH', 1),
    ], -.15, 20);
    expect(result.tail).toMatchObject({ threshold: -.15, calibrationN: 20, tailEvents: 1, caught: 1, riskCalls: 2, method: 'TRAIN_ONLY_Q10' });
    expect(result.tail.recall).toMatchObject({ value: null, status: 'INSUFFICIENT_SAMPLE' });
    expect(result.tail.precision).toMatchObject({ value: null, status: 'INSUFFICIENT_SAMPLE' });
  });

  it('returns typed null instead of zero or NaN when formal signals are missing', () => {
    const pairs = Array.from({ length: 5 }, (_, i) => pair(i, 50, i % 2 ? .1 : -.1, null, null));
    const result = evaluateValidationMetrics(pairs, null, 0);
    expect(result.direction).toMatchObject({ value: null, n: 0, status: 'NO_ELIGIBLE_OBSERVATIONS' });
    expect(result.formalVerdict).toMatchObject({ value: null, n: 0, status: 'MISSING_FORMAL_SIGNAL' });
    expect(result.risk.precision).toMatchObject({ value: null, status: 'MISSING_FORMAL_SIGNAL' });
    expect(result.tail.threshold).toBeNull();
    expect(JSON.stringify(result)).not.toMatch(/NaN|Infinity/);
  });

  it('fails the complete formal series closed when even one persisted signal is missing', () => {
    const pairs = Array.from({ length: 6 }, (_, i) => pair(i, 60, .1, 'BULLISH', 1));
    pairs[2] = { ...pairs[2], verdict: null };
    pairs[4] = { ...pairs[4], targetExposure: null };
    const result = evaluateValidationMetrics(pairs, -.1, 20);
    expect(result.formalVerdict).toMatchObject({ value: null, status: 'MISSING_FORMAL_SIGNAL' });
    expect(result.risk.precision).toMatchObject({ value: null, status: 'MISSING_FORMAL_SIGNAL' });
    expect(result.risk.downsideRecall).toMatchObject({ value: null, status: 'MISSING_FORMAL_SIGNAL' });
  });
});
