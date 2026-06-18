import { describe, it, expect } from 'vitest';
import { normalizeTnx, parseYahooQuote, parseStooqCsv } from '../src/prices';

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
