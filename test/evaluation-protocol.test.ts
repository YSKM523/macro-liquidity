import { describe, expect, it } from 'vitest';
import {
  HOLDOUT_REGISTRATION, buildForwardPairs, buildPurgedFolds, greedyIndependentPairs,
  purgeTrainingPairs, runFrozenHoldout, runPurgedValidation,
} from '../src/evaluation-protocol';
import type { ValidationSnap } from '../src/evaluation-protocol';
import { addDays } from '../src/backtest';

function snap(date: string, i: number, overrides: Partial<ValidationSnap> = {}): ValidationSnap {
  return {
    date, score: 40 + i % 20, spx: 100 + i, factors: { netliqTrend: i },
    verdict: i % 3 === 0 ? 'BEARISH' : 'BULLISH', targetExposure: i % 3 === 0 ? .25 : 1,
    pitStatus: 'PIT', provenanceStatus: 'GOVERNED', ...overrides,
  };
}

describe('date interval labels', () => {
  it('rejects duplicate, unsorted, and invalid dates', () => {
    expect(() => buildForwardPairs([snap('2024-01-01', 0), snap('2024-01-01', 1)], 13)).toThrow(/strictly increasing/i);
    expect(() => buildForwardPairs([snap('2024-01-08', 0), snap('2024-01-01', 1)], 13)).toThrow(/strictly increasing/i);
    expect(() => buildForwardPairs([snap('bad', 0), snap('2024-01-01', 1)], 13)).toThrow(/date/i);
  });

  it('uses calendar horizons with irregular spacing and exposes both dates', () => {
    const rows = [snap('2024-01-01', 0), snap('2024-01-11', 1), snap('2024-04-02', 2), snap('2024-04-15', 3)];
    const pairs = buildForwardPairs(rows, 13);
    expect(pairs[0]).toMatchObject({ startIdx: 0, endIdx: 2, signalDate: '2024-01-01', outcomeDate: '2024-04-02' });
  });

  it('purges overlapping outcomes then applies an exact 91-calendar-day embargo', () => {
    const pairs = [
      { ...buildForwardPairs([snap('2023-09-30', 0), snap('2024-01-01', 1)], 13)[0] },
      { ...buildForwardPairs([snap('2023-10-02', 0), snap('2024-01-02', 1)], 13)[0] },
      { ...buildForwardPairs([snap('2023-07-01', 0), snap('2023-10-01', 1)], 13)[0] },
    ];
    const result = purgeTrainingPairs(pairs, '2024-01-01', 91);
    expect(result.pairs.map(pair => pair.signalDate)).toEqual(['2023-07-01']);
    expect(result).toMatchObject({ purgedOverlapN: 1, embargoedN: 1 });
  });

  it('greedily reports truly interval-non-overlapping labels', () => {
    const rows = Array.from({ length: 35 }, (_, i) => snap(addDays('2024-01-01', i * 7), i));
    const all = buildForwardPairs(rows, 13);
    const independent = greedyIndependentPairs(all);
    expect(independent.length).toBeLessThan(all.length);
    for (let i = 1; i < independent.length; i++) {
      expect(independent[i].signalDate >= independent[i - 1].outcomeDate).toBe(true);
    }
  });
});

describe('purged folds and frozen holdout', () => {
  const rows = Array.from({ length: 100 }, (_, i) => snap(addDays('2023-01-02', i * 7), i));

  it('never trains on a label before its outcome matures and reports overlap counts', () => {
    const folds = buildPurgedFolds(rows, { initialTrain: 40, testN: 10, horizonWeeks: 13, embargoDays: 91 });
    expect(folds.length).toBeGreaterThan(0);
    for (const fold of folds) {
      expect(fold.trainPairs.every(pair => pair.outcomeDate < fold.testFrom)).toBe(true);
      expect(fold.overlappingN).toBeGreaterThanOrEqual(fold.independentN);
      expect(fold.testLabelThrough >= fold.testTo).toBe(true);
    }
  });

  it('freezes the registered holdout date, protocol digest, weights, and q10 from pre-holdout rows', () => {
    expect(HOLDOUT_REGISTRATION.holdoutFrom).toBe('2026-07-23');
    expect(HOLDOUT_REGISTRATION.protocolDigest).toMatch(/^[a-f0-9]{64}$/);
    const before = runFrozenHoldout(rows);
    const later = runFrozenHoldout([...rows, snap('2026-07-23', 101), snap('2026-11-01', 102, { spx: 300 })]);
    expect(later.frozen).toEqual(before.frozen);
    expect(before.frozen.trainingOutcomeCutoffExclusive).toBe('2026-04-23');
    expect(later.status).toBe('PENDING_MATURITY');
    expect(later.metrics).toBeNull();
  });

  it('does not expose q10 before 20 pre-holdout calibration outcomes', () => {
    const short = Array.from({ length: 25 }, (_, i) => snap(addDays('2025-01-01', i * 7), i));
    const holdout = runFrozenHoldout(short);
    expect(holdout.frozen.trainingN).toBeLessThan(20);
    expect(holdout.frozen.q10).toBeNull();
  });

  it('labels fitted weights as diagnostic and never recalibrates aggregate tail with the last fold', () => {
    const result = runPurgedValidation(rows, { initialTrain: 40, testN: 10 });
    expect(result.folds[0]).toHaveProperty('diagnosticFittedWeights');
    expect(result.folds[0]).toHaveProperty('diagnosticFitted');
    expect(result.folds[0]).not.toHaveProperty('weights');
    expect(result.aggregateMetrics?.tail).toMatchObject({ threshold: null, thresholdSemantics: 'FOLD_SPECIFIC', method: 'TRAIN_ONLY_Q10' });
  });

  it('fails closed for non-PIT or ungoverned rows', () => {
    const bad = [...rows];
    bad[3] = { ...bad[3], pitStatus: 'LEGACY_NO_PIT' };
    const result = runPurgedValidation(bad, { initialTrain: 40, testN: 10 });
    expect(result.status).toBe('DATA_INCOMPLETE');
    expect(result.folds).toEqual([]);
    expect(result.aggregateMetrics).toBeNull();
  });
});
