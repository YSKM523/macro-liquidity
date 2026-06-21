// @ts-nocheck — imports prod modules; behavior tested, types not needed here
import { describe, it, expect } from 'vitest';
import { SERIES_IDS, UNIT_BY_ID } from '../src/config';
import { parseFredJson } from '../src/fred';

describe('global series registration', () => {
  it('registers the 4 global series for ingestion with raw (unit I) storage', () => {
    for (const id of ['ECBASSETSW', 'JPNASSETS', 'DEXUSEU', 'DEXJPUS']) {
      expect(SERIES_IDS).toContain(id);
      expect(UNIT_BY_ID[id]).toBe('I');
    }
  });
  it('stores ECB/BOJ/FX values RAW — never ÷1000 (anti-hallucination units)', () => {
    const ecb = parseFredJson('ECBASSETSW', { observations: [{ date: '2024-01-05', value: '6500000' }] });
    expect(ecb[0].value).toBe(6500000);     // raw millions EUR, NOT 6500
    const fx = parseFredJson('DEXUSEU', { observations: [{ date: '2024-01-05', value: '1.09' }] });
    expect(fx[0].value).toBeCloseTo(1.09);  // FX rate untouched
  });
});
