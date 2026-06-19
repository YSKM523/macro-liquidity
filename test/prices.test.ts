import { describe, it, expect } from 'vitest';
import { normalizeTnx, parseYahooQuote, parseStooqCsv, parseYahooCloses, evaluateLiveStress } from '../src/prices';
import type { StressSeries } from '../src/prices';

describe('price parsing', () => {
  it('normalizeTnx handles both 43.0 and 4.30 conventions', () => {
    expect(normalizeTnx(43.0)).toBeCloseTo(4.30);
    expect(normalizeTnx(4.30)).toBeCloseTo(4.30);
  });
  it('parseYahooQuote reads regularMarketPrice', () => {
    const json = { chart: { result: [{ meta: { regularMarketPrice: 5123.45 } }] } };
    expect(parseYahooQuote(json)).toBeCloseTo(5123.45);
  });
  it('parseYahooQuote returns null on error shape', () => {
    expect(parseYahooQuote({ chart: { error: 'x', result: null } })).toBeNull();
  });
  it('parseStooqCsv reads close column', () => {
    const csv = 'Symbol,Date,Time,Open,High,Low,Close,Volume\n^SPX,2024-06-18,22:00:00,5100,5130,5090,5123.45,0\n';
    expect(parseStooqCsv(csv)).toBeCloseTo(5123.45);
  });
});

describe('parseYahooCloses', () => {
  it('extracts close array filtering out nulls', () => {
    const json = {
      chart: {
        result: [{
          indicators: { quote: [{ close: [100, null, 102, null, 105] }] },
        }],
      },
    };
    expect(parseYahooCloses(json)).toEqual([100, 102, 105]);
  });

  it('returns empty array on malformed shape', () => {
    expect(parseYahooCloses(null)).toEqual([]);
    expect(parseYahooCloses({})).toEqual([]);
    expect(parseYahooCloses({ chart: { result: null } })).toEqual([]);
  });

  it('filters out non-finite values', () => {
    const json = {
      chart: {
        result: [{
          indicators: { quote: [{ close: [1, Infinity, 2, NaN, 3] }] },
        }],
      },
    };
    expect(parseYahooCloses(json)).toEqual([1, 2, 3]);
  });
});

describe('evaluateLiveStress', () => {
  const calm: StressSeries = {
    spx: [5000, 5010, 5020, 5030, 5040, 5050],
    vix: [14, 15, 14, 15, 14, 15],
    us10y: [4.2, 4.2, 4.2, 4.2, 4.2, 4.2],
    dxy: [103, 103, 103, 103, 103, 103],
  };

  it('calm series → stressed===false, reasons empty', () => {
    const result = evaluateLiveStress(calm);
    expect(result.stressed).toBe(false);
    expect(result.reasons).toHaveLength(0);
  });

  it('VIX=35 → stressed, reasons contains VIX', () => {
    const s: StressSeries = { ...calm, vix: [14, 15, 14, 15, 14, 35] };
    const result = evaluateLiveStress(s);
    expect(result.stressed).toBe(true);
    expect(result.reasons.some(r => r.includes('VIX'))).toBe(true);
  });

  it('SPX -6% over 5 days → stressed, reasons contains SPX', () => {
    // 6 points: ago5=5000, last=4700 → -6%
    const s: StressSeries = { ...calm, spx: [5000, 4900, 4850, 4800, 4750, 4700] };
    const result = evaluateLiveStress(s);
    expect(result.stressed).toBe(true);
    expect(result.reasons.some(r => r.includes('SPX'))).toBe(true);
  });

  it('10Y up +0.30pp over 5 days → stressed, reasons contains 10Y', () => {
    const s: StressSeries = { ...calm, us10y: [4.0, 4.05, 4.1, 4.15, 4.2, 4.30] };
    const result = evaluateLiveStress(s);
    expect(result.stressed).toBe(true);
    expect(result.reasons.some(r => r.includes('10Y'))).toBe(true);
  });

  it('DXY up +3% over 5 days → stressed, reasons contains 美元', () => {
    const s: StressSeries = { ...calm, dxy: [100, 100.5, 101, 101.5, 102, 103] };
    const result = evaluateLiveStress(s);
    expect(result.stressed).toBe(true);
    expect(result.reasons.some(r => r.includes('美元'))).toBe(true);
  });

  it('empty arrays → not stressed, signals null, no crash', () => {
    const s: StressSeries = { spx: [], vix: [], us10y: [], dxy: [] };
    const result = evaluateLiveStress(s);
    expect(result.stressed).toBe(false);
    expect(result.signals.vix).toBeNull();
    expect(result.signals.spx5d).toBeNull();
    expect(result.signals.us10y5d).toBeNull();
    expect(result.signals.dxy5d).toBeNull();
  });
});
