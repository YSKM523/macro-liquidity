import { describe, expect, it } from 'vitest';
import {
  HOLDOUT_REGISTRATION, buildForwardPairs, buildPurgedFolds, greedyIndependentPairs,
  buildFormalForwardPairs, purgeTrainingPairs, runFrozenHoldout, runPurgedValidation,
} from '../src/evaluation-protocol';
import type { ValidationSnap } from '../src/evaluation-protocol';
import { addDays } from '../src/backtest';
import { championConfigDigest, CHAMPION_MODEL_VERSION } from '../src/model-version';
import type { EventBacktestInputs } from '../src/event-backtest';

function snap(date: string, i: number, overrides: Partial<ValidationSnap> = {}): ValidationSnap {
  return {
    date, score: 40 + i % 20, spx: 100 + i, factors: { netliqTrend: i },
    verdict: i % 3 === 0 ? 'BEARISH' : 'BULLISH', targetExposure: i % 3 === 0 ? .25 : 1,
    pitStatus: 'PIT', provenanceStatus: 'GOVERNED', modelVersion: CHAMPION_MODEL_VERSION,
    configHash: championConfigDigest(), codeCommitSha: '0123456789abcdef0123456789abcdef01234567',
    dataRunId: `run-${i}`, ...overrides,
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
    expect(result).toMatchObject({ purgedOverlapN: 2, embargoedN: 0 });
  });

  it('applies the calendar embargo after outcome-overlap purging', () => {
    const overlap = buildForwardPairs([snap('2024-04-01', 0), snap('2024-07-01', 1)], 13)[0];
    const exactBoundary = buildForwardPairs([snap('2024-01-01', 0), snap('2024-04-01', 1)], 13)[0];
    const beforeBoundary = buildForwardPairs([snap('2023-12-31', 0), snap('2024-03-31', 1)], 13)[0];
    const result = purgeTrainingPairs([overlap, exactBoundary, beforeBoundary], '2024-07-01', 91);
    expect(result.pairs.map(pair => pair.outcomeDate)).toEqual(['2024-03-31']);
    expect(result).toMatchObject({ purgedOverlapN: 1, embargoedN: 1, embargoFrom: '2024-04-01' });
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

  it('uses earliest-exit greedy ordering for half-open return intervals', () => {
    const late = buildForwardPairs([snap('2024-01-01', 0), snap('2024-04-15', 1)], 13)[0];
    const early = buildForwardPairs([snap('2024-01-10', 0), snap('2024-04-10', 1)], 13)[0];
    const next = buildForwardPairs([snap('2024-04-10', 0), snap('2024-07-10', 1)], 13)[0];
    expect(greedyIndependentPairs([late, early, next]).map(pair => pair.signalDate))
      .toEqual(['2024-01-10', '2024-04-10']);
  });

  it('builds returns only from formal execution close and selects holdout by execution date', () => {
    const input: EventBacktestInputs = {
      asOfCutoff: '2026-12-01T00:00:00Z',
      signals: [{
        signalDate: '2026-07-22', decisionAt: '2026-07-23T18:00:00Z', tradableAt: '2026-07-23T18:00:00Z',
        score: 60, verdict: 'BULLISH', targetExposure: 1, factors: { netliqTrend: 60 },
        modelVersion: CHAMPION_MODEL_VERSION, configHash: championConfigDigest(),
        codeCommitSha: '0123456789abcdef0123456789abcdef01234567', dataRunId: 'run-formal',
      }],
      prices: [
        { date: '2026-07-22', adjustedClose: 50, source: 'PIT', provenanceStatus: 'PIT_RAW', fetchedAt: '2026-07-22T23:00:00Z', dataRunId: 'px-run', activationRunId: 'act-1', activatedAt: '2026-07-23T00:00:00Z' },
        { date: '2026-07-24', adjustedClose: 100, source: 'PIT', provenanceStatus: 'PIT_RAW', fetchedAt: '2026-07-24T23:00:00Z', dataRunId: 'px-run', activationRunId: 'act-2', activatedAt: '2026-07-25T00:00:00Z' },
        { date: '2026-10-23', adjustedClose: 110, source: 'PIT', provenanceStatus: 'PIT_RAW', fetchedAt: '2026-10-23T23:00:00Z', dataRunId: 'px-run', activationRunId: 'act-3', activatedAt: '2026-10-24T00:00:00Z' },
      ], vix: [], cashRates: [],
    };
    const [label] = buildFormalForwardPairs(input);
    expect(label).toMatchObject({ modelDate: '2026-07-22', signalDate: '2026-07-24', entryDate: '2026-07-24', outcomeDate: '2026-10-23' });
    expect(label.fwd).toBeCloseTo(.1);
  });

  it('fails formal labels closed for non-PIT daily prices', () => {
    const input: EventBacktestInputs = { asOfCutoff: '2026-12-01T00:00:00Z', signals: [], prices: [
      { date: '2026-07-24', adjustedClose: 100, source: 'synthetic', provenanceStatus: 'SYNTHETIC_BACKFILL' },
    ], vix: [], cashRates: [] };
    expect(() => buildFormalForwardPairs(input)).toThrow(/PIT_RAW/);
  });
});

describe('purged folds and frozen holdout', () => {
  const rows = Array.from({ length: 300 }, (_, i) => snap(addDays('2018-01-01', i * 7), i));

  it('never trains on a label before its outcome matures and reports overlap counts', () => {
    const folds = buildPurgedFolds(rows, { initialTrain: 40, testN: 10, horizonWeeks: 13, embargoDays: 91 });
    expect(folds.length).toBeGreaterThan(0);
    for (const fold of folds) {
      expect(fold.trainPairs.every(pair => pair.outcomeDate < fold.testFrom)).toBe(true);
      expect(fold.overlappingN).toBeGreaterThanOrEqual(fold.independentN);
      expect(fold.testLabelThrough >= fold.testTo).toBe(true);
    }
  });

  it('freezes the registered Champion identity without a mutable pre-period artifact', () => {
    expect(HOLDOUT_REGISTRATION.holdoutFrom).toBe('2026-07-23');
    expect(HOLDOUT_REGISTRATION.registeredAt).toBe('2026-07-22T19:37:28Z');
    expect(HOLDOUT_REGISTRATION.registrationCommit).toBe('75c93d526bf6073440335d3c90a7d5c0b90ea58b');
    expect(HOLDOUT_REGISTRATION.modelVersion).toBe(CHAMPION_MODEL_VERSION);
    expect(HOLDOUT_REGISTRATION.configHash).toBe(championConfigDigest());
    expect(HOLDOUT_REGISTRATION.protocolDigest).toMatch(/^[a-f0-9]{64}$/);
    const before = runFrozenHoldout(rows);
    const mutated = rows.map((row, index) => index === 20 ? { ...row, score: 99, spx: 999 } : row);
    const after = runFrozenHoldout(mutated);
    expect(after.registration).toEqual(before.registration);
    expect(after).not.toHaveProperty('frozen');
    expect(after.tailStatus).toBe('UNAVAILABLE_AT_REGISTRATION');
  });

  it('labels fitted weights as diagnostic and never recalibrates aggregate tail with the last fold', () => {
    const result = runPurgedValidation(rows);
    expect(result.folds[0]).toHaveProperty('diagnosticFittedWeights');
    expect(result.folds[0]).toHaveProperty('diagnosticFitted');
    expect(result.folds[0]).not.toHaveProperty('weights');
    expect(result.aggregateMetrics?.tail).toMatchObject({ threshold: null, thresholdSemantics: 'FOLD_SPECIFIC', method: 'TRAIN_ONLY_Q10' });
  });

  it('fails closed for non-PIT or ungoverned rows', () => {
    const bad = [...rows];
    bad[3] = { ...bad[3], pitStatus: 'LEGACY_NO_PIT' };
    const result = runPurgedValidation(bad);
    expect(result.status).toBe('DATA_INCOMPLETE');
    expect(result.folds).toEqual([]);
    expect(result.aggregateMetrics).toBeNull();
  });

  it('computes retrospective metrics honestly across legacy PIT history', () => {
    const legacy = rows.map(row => ({ ...row, provenanceStatus: 'LEGACY' }));
    const result = runPurgedValidation(legacy);
    expect(result.status).toBe('PARTIAL_LEGACY');
    expect(result.provenance).toMatchObject({ totalCount: 300, governedCount: 0, legacyCount: 300, completeness: 'PARTIAL_LEGACY' });
    expect(result.folds.length).toBeGreaterThan(0);
    expect(result.aggregateMetrics?.direction.n).toBeGreaterThan(0);
    expect(result.aggregateMetrics?.tail.recall).toMatchObject({ value: null, status: 'PARTIAL_LEGACY_CALIBRATION' });
  });

  it('allows a governed/legacy PIT cohort but rejects malformed provenance', () => {
    const mixed = rows.map((row, index) => ({ ...row, provenanceStatus: index < 50 ? 'LEGACY' : 'GOVERNED' }));
    expect(runPurgedValidation(mixed).status).toBe('PARTIAL_LEGACY');
    const invalid = [...rows];
    invalid[5] = { ...invalid[5], provenanceStatus: 'INVALID' };
    expect(runPurgedValidation(invalid).status).toBe('DATA_INCOMPLETE');
  });

  it('requires every post-registration holdout signal to be governed', () => {
    const postLegacy = [...rows, snap('2026-07-23', 101, { provenanceStatus: 'LEGACY' })];
    expect(runFrozenHoldout(postLegacy).status).toBe('DATA_INCOMPLETE');
  });

  it('propagates missing formal risk signals into aggregate tail metrics', () => {
    const missing = rows.map((row, index) => index === 45 ? { ...row, targetExposure: null } : row);
    const result = runPurgedValidation(missing);
    expect(result.aggregateMetrics?.tail.recall.status).toBe('MISSING_FORMAL_SIGNAL');
    expect(result.aggregateMetrics?.tail.precision.status).toBe('MISSING_FORMAL_SIGNAL');
  });

  it('keeps prospective holdout tail permanently unavailable and rejects a model mismatch', () => {
    const legacyPre = rows.map(row => ({ ...row, provenanceStatus: 'LEGACY' }));
    const governedPost = Array.from({ length: 20 }, (_, index) =>
      snap(addDays('2026-07-23', index * 7), 200 + index, { provenanceStatus: 'GOVERNED' }));
    const result = runFrozenHoldout([...legacyPre, ...governedPost]);
    expect(result.status).toBe('OK');
    expect(result.tailStatus).toBe('UNAVAILABLE_AT_REGISTRATION');
    expect(result.metrics?.tail.recall).toMatchObject({ value: null, status: 'UNAVAILABLE_AT_REGISTRATION' });
    governedPost[0] = { ...governedPost[0], configHash: 'b'.repeat(64) };
    expect(runFrozenHoldout([...legacyPre, ...governedPost]).status).toBe('DATA_INCOMPLETE');
  });

  it('does not allow formal protocol overrides to masquerade under the registered digest', () => {
    // @ts-expect-error formal API intentionally has no fold override
    expect(() => runPurgedValidation(rows, { initialTrain: 40, testN: 10 })).toThrow(/override/i);
  });
});
