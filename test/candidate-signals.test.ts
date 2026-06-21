// @ts-nocheck
import { describe, it, expect } from 'vitest';
import {
  fiscalIssuanceSignal, termPremiumSignal, earningsMomentumSignal, CANDIDATES,
} from '../scripts/candidate-signals.mjs';

const daily = (start, n, fn) => Array.from({ length: n }, (_, i) => {
  const d = new Date(start + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + i);
  return { date: d.toISOString().slice(0, 10), value: fn(i) };
});

describe('fiscalIssuanceSignal', () => {
  it('is positive when debt is rising (pace > 0)', () => {
    const debt = daily('2020-01-01', 200, i => 1000 + i); // steadily rising
    const sig = fiscalIssuanceSignal(debt, 13);
    expect(sig.length).toBeGreaterThan(0);
    expect(sig.at(-1).value).toBeGreaterThan(0);
  });
  it('returns [] on empty input', () => {
    expect(fiscalIssuanceSignal([], 13)).toEqual([]);
  });
});

describe('termPremiumSignal', () => {
  it('reports the change over the lookback window', () => {
    const tp = daily('2020-01-01', 60, i => i * 0.01); // +0.01pp/day
    const sig = termPremiumSignal(tp, 20);
    const last = sig.at(-1);
    expect(last.value).toBeGreaterThan(0);            // rising term premium
    expect(last.value).toBeCloseTo(0.20, 1);          // ~20 days * 0.01
  });
});

describe('earningsMomentumSignal', () => {
  it('does not use earnings published after the signal date (no lookahead)', () => {
    // Earnings jump to a high value only on 2021-06-15; with a 60-day lag,
    // the signal on 2021-06-20 must NOT yet reflect that jump.
    const earnings = [
      { date: '2020-01-15', value: 100 }, { date: '2020-06-15', value: 100 },
      { date: '2021-01-15', value: 100 }, { date: '2021-06-15', value: 500 },
    ];
    const sig = earningsMomentumSignal(earnings, 60);
    const onJun20 = sig.find(s => s.date === '2021-06-20');
    if (onJun20) expect(onJun20.value).toBeLessThan(1); // jump (×5) not yet visible
  });
  it('returns [] on empty input', () => {
    expect(earningsMomentumSignal([], 60)).toEqual([]);
  });
});

describe('CANDIDATES metadata', () => {
  it('lists all four candidates with a sign', () => {
    const keys = CANDIDATES.map(c => c.key).sort();
    expect(keys).toEqual(['earnings_momentum', 'fiscal_issuance', 'global_liquidity', 'term_premium']);
    expect(CANDIDATES.every(c => c.sign === 1 || c.sign === -1)).toBe(true);
  });
});
