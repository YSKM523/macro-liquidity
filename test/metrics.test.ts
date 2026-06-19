import { describe, it, expect } from 'vitest';
import {
  clamp, linMap, sma, asOf, buildWeeklyNetliq, changeOverDays, balanceSheetImpulse, netliqDirection,
  percentileRank, scoreNetliqTrend, scoreImpulse, scoreCredit, scoreFunding,
  scoreRates, scoreVol, weightedScore,
} from '../src/metrics';
import { verdictFromScore, buildReason, computeSnapshot, policyRegime, downgradeVerdict } from '../src/metrics';

const obs = (pairs: [string, number][]) => pairs.map(([date, value]) => ({ date, value }));

describe('primitives', () => {
  it('clamp bounds to [0,100] by default', () => {
    expect(clamp(-5)).toBe(0); expect(clamp(150)).toBe(100); expect(clamp(42)).toBe(42);
  });
  it('linMap maps range to 0..100 and clamps', () => {
    expect(linMap(0, -100, 100)).toBeCloseTo(50);
    expect(linMap(100, -100, 100)).toBe(100);
    expect(linMap(-200, -100, 100)).toBe(0);
  });
  it('sma averages last n, null if short', () => {
    expect(sma([1,2,3,4], 2)).toBeCloseTo(3.5);
    expect(sma([1], 2)).toBeNull();
  });
  it('asOf forward-fills last value on/before date', () => {
    const s = obs([['2024-01-01', 10], ['2024-01-08', 20]]);
    expect(asOf(s, '2024-01-05')).toBe(10);
    expect(asOf(s, '2024-01-08')).toBe(20);
    expect(asOf(s, '2023-12-31')).toBeNull();
  });
  it('buildWeeklyNetliq = WALCL - TGA - RRP at WALCL weekly dates', () => {
    const m = {
      WALCL: obs([['2024-01-03', 6000], ['2024-01-10', 6100]]),
      WDTGAL: obs([['2024-01-03', 700], ['2024-01-10', 700]]),
      RRPONTSYD: obs([['2024-01-02', 500], ['2024-01-09', 400]]),
    };
    expect(buildWeeklyNetliq(m, '2024-01-10')).toEqual([4800, 5000]);
  });
  it('changeOverDays returns latest minus value ~days ago', () => {
    const s = obs([['2024-01-01', 4.0], ['2024-01-29', 4.5]]);
    expect(changeOverDays(s, '2024-01-29', 20)).toBeCloseTo(0.5);
  });
});

describe('balanceSheetImpulse + direction', () => {
  it('EXPANDING when WALCL rose >epsilon over 13 weeks', () => {
    const w = Array.from({ length: 14 }, (_, i) => 6000 + i * 20); // +260 over 13
    expect(balanceSheetImpulse(w)).toBe('EXPANDING');
  });
  it('CONTRACTING when WALCL fell >epsilon over 13 weeks', () => {
    const w = Array.from({ length: 14 }, (_, i) => 7000 - i * 20);
    expect(balanceSheetImpulse(w)).toBe('CONTRACTING');
  });
  it('FLAT inside dead-band', () => {
    const w = Array.from({ length: 14 }, () => 6000);
    expect(balanceSheetImpulse(w)).toBe('FLAT');
  });
  it('netliqDirection UP when latest above its SMA and rising', () => {
    const up = Array.from({ length: 20 }, (_, i) => 4000 + i * 30);
    expect(netliqDirection(up)).toBe('UP');
    const down = Array.from({ length: 20 }, (_, i) => 5000 - i * 30);
    expect(netliqDirection(down)).toBe('DOWN');
  });
});

describe('factor scores', () => {
  it('percentileRank ranks within history', () => {
    expect(percentileRank(5, [1,2,3,4,5,6,7,8,9,10])).toBeCloseTo(0.5, 1);
  });
  it('rising net liquidity scores higher than falling, all within [0,100]', () => {
    const rising = Array.from({ length: 20 }, (_, i) => 4000 + i * 30);
    const falling = Array.from({ length: 20 }, (_, i) => 5000 - i * 30);
    const r = scoreNetliqTrend(rising), f = scoreNetliqTrend(falling);
    expect(r).toBeGreaterThan(f);
    for (const s of [r, f]) { expect(s).toBeGreaterThanOrEqual(0); expect(s).toBeLessThanOrEqual(100); }
  });
  it('EXPANDING scores higher than CONTRACTING', () => {
    expect(scoreImpulse('EXPANDING')).toBeGreaterThan(scoreImpulse('CONTRACTING'));
  });
  it('tight credit (low OAS) scores higher than wide', () => {
    const hist = Array.from({ length: 50 }, (_, i) => 3 + i * 0.1); // 3..~8
    expect(scoreCredit(3.2, hist)).toBeGreaterThan(scoreCredit(7.5, hist));
  });
  it('funding stress (sofr-iorb>0) penalized', () => {
    expect(scoreFunding(-0.02)).toBeGreaterThan(scoreFunding(0.10));
  });
  it('fast-rising yields = headwind (lower score)', () => {
    expect(scoreRates(0.5)).toBeLessThan(scoreRates(-0.5));
  });
  it('low VIX scores higher than high VIX', () => {
    expect(scoreVol(14)).toBeGreaterThan(scoreVol(35));
  });
  it('weightedScore stays in [0,100]', () => {
    const f = { netliqTrend:80, impulse:70, credit:60, funding:90, rates:40, dollar:55, vol:75 };
    const s = weightedScore(f);
    expect(s).toBeGreaterThanOrEqual(0); expect(s).toBeLessThanOrEqual(100);
  });
});

describe('verdict + snapshot', () => {
  it('verdict bands with dead-zone hysteresis', () => {
    expect(verdictFromScore(60)).toBe('BULLISH');
    expect(verdictFromScore(40)).toBe('BEARISH');
    expect(verdictFromScore(50)).toBe('NEUTRAL');
    // inside dead-zone, keep previous
    expect(verdictFromScore(50, 'BULLISH')).toBe('BULLISH');
  });
  it('buildReason surfaces the CONTRACTING-but-liquidity-up divergence', () => {
    const r = buildReason('CONTRACTING', 'UP', 'BULLISH');
    expect(r).toContain('缩表');
    expect(r).toContain('净流动性');
  });
  it('computeSnapshot produces a full snapshot from a SeriesMap', () => {
    const wk = (start: number, step: number) =>
      Array.from({ length: 30 }, (_, i) => ({
        date: new Date(Date.UTC(2024, 0, 3 + i * 7)).toISOString().slice(0, 10),
        value: start + i * step,
      }));
    const daily = (v: number) => [{ date: '2024-01-01', value: v }, { date: '2024-07-31', value: v }];
    const m = {
      WALCL: wk(6000, 15), WDTGAL: wk(700, 0), RRPONTSYD: wk(500, -5),
      RPONTSYD: daily(0), SOFR: daily(5.3), IORB: daily(5.4),
      BAMLH0A0HYM2: daily(3.5), DGS10: daily(4.2), VIXCLS: daily(14),
      DTWEXBGS: Array.from({ length: 250 }, (_, i) => ({ date: new Date(Date.UTC(2024,0,1+i)).toISOString().slice(0,10), value: 120 })),
      SP500: daily(5000),
    };
    const snap = computeSnapshot(m, '2024-07-31');
    expect(snap.score).toBeGreaterThanOrEqual(0);
    expect(snap.score).toBeLessThanOrEqual(100);
    expect(['EXPANDING','CONTRACTING','FLAT']).toContain(snap.bsImpulse);
    expect(snap.netliq).toBeCloseTo(snap.walcl! - snap.tga! - snap.rrp!);
    expect(typeof snap.reason).toBe('string');
  });
});

describe('computeSnapshot coverage', () => {
  const wk = (start: number, step: number) =>
    Array.from({ length: 30 }, (_, i) => ({
      date: new Date(Date.UTC(2024, 0, 3 + i * 7)).toISOString().slice(0, 10),
      value: start + i * step,
    }));
  const daily = (v: number) => [{ date: '2024-01-01', value: v }, { date: '2024-07-31', value: v }];
  const fullMap = {
    WALCL: wk(6000, 15), WDTGAL: wk(700, 0), RRPONTSYD: wk(500, -5),
    RPONTSYD: daily(0), SOFR: daily(5.3), IORB: daily(5.4),
    BAMLH0A0HYM2: daily(3.5), DGS10: daily(4.2), VIXCLS: daily(14),
    DTWEXBGS: Array.from({ length: 250 }, (_, i) => ({ date: new Date(Date.UTC(2024,0,1+i)).toISOString().slice(0,10), value: 120 })),
    SP500: daily(5000),
  };

  it('coverage === 1 when all 7 series have real data', () => {
    const snap = computeSnapshot(fullMap, '2024-07-31');
    expect(snap.coverage).toBeCloseTo(1);
  });

  it('coverage ≈ 5/7 when VIXCLS and BAMLH0A0HYM2 are missing', () => {
    const partialMap = { ...fullMap, VIXCLS: [], BAMLH0A0HYM2: [] };
    const snap = computeSnapshot(partialMap, '2024-07-31');
    expect(snap.coverage).toBeCloseTo(5 / 7);
  });
});

describe('downgradeVerdict', () => {
  it('BULLISH → NEUTRAL', () => {
    expect(downgradeVerdict('BULLISH')).toBe('NEUTRAL');
  });
  it('NEUTRAL → BEARISH', () => {
    expect(downgradeVerdict('NEUTRAL')).toBe('BEARISH');
  });
  it('BEARISH stays BEARISH', () => {
    expect(downgradeVerdict('BEARISH')).toBe('BEARISH');
  });
});

describe('policyRegime', () => {
  it('returns RESERVE_MGMT for any date >= QT_END_DATE', () => {
    expect(policyRegime('EXPANDING', '2026-06-17')).toBe('RESERVE_MGMT');
    expect(policyRegime('CONTRACTING', '2025-12-01')).toBe('RESERVE_MGMT');
    expect(policyRegime('FLAT', '2025-12-15')).toBe('RESERVE_MGMT');
  });
  it('returns QE for EXPANDING before QT_END_DATE', () => {
    expect(policyRegime('EXPANDING', '2021-01-01')).toBe('QE');
  });
  it('returns QT for CONTRACTING before QT_END_DATE', () => {
    expect(policyRegime('CONTRACTING', '2023-01-01')).toBe('QT');
  });
  it('returns NEUTRAL for FLAT before QT_END_DATE', () => {
    expect(policyRegime('FLAT', '2024-06-01')).toBe('NEUTRAL');
  });
});
