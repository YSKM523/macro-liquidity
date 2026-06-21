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

import { globalLiquiditySeries, globalLiquidityLatest } from '../src/global';

const S = (date, value) => ({ date, value });
// Realistic magnitudes: WALCL ~6740 (billions USD), ECB ~6.5e6 (M EUR),
// BOJ ~7.5e6 (億円 = ¥750T), EUR/USD ~1.09, JPY/USD ~148.
function fakeMap() {
  return {
    WALCL:      [S('2024-01-05', 6740), S('2024-04-05', 6700)],
    ECBASSETSW: [S('2024-01-05', 6500000), S('2024-04-05', 6400000)],
    DEXUSEU:    [S('2024-01-05', 1.09), S('2024-04-05', 1.08)],
    JPNASSETS:  [S('2024-01-05', 7500000), S('2024-04-05', 7550000)],
    DEXJPUS:    [S('2024-01-05', 148), S('2024-04-05', 151)],
  };
}

describe('globalLiquidityLatest', () => {
  it('reconciles composition to the total (fed+ecb+boj===gl; pcts sum to 1)', () => {
    const r = globalLiquidityLatest(fakeMap(), '2024-04-05');
    expect(r).not.toBeNull();
    expect(r.fed + r.ecb + r.boj).toBeCloseTo(r.gl, 6);
    expect(r.fedPct + r.ecbPct + r.bojPct).toBeCloseTo(1, 6);
  });
  it('lands at a sane magnitude (~$18T = ~18000 billions)', () => {
    const r = globalLiquidityLatest(fakeMap(), '2024-04-05');
    expect(r.gl).toBeGreaterThan(12000);
    expect(r.gl).toBeLessThan(26000);
  });
  it('computes a known point by hand', () => {
    const r = globalLiquidityLatest(fakeMap(), '2024-01-05');
    expect(r.fed).toBeCloseTo(6740, 6);                          // WALCL already billions
    expect(r.ecb).toBeCloseTo(6500000 * 1.09 / 1000, 3);        // 7085
    expect(r.boj).toBeCloseTo(7500000 * 100 / 148 / 1000, 6);   // ~5067.6
  });
  it('returns null when ANY component is missing (no fabrication)', () => {
    const m = fakeMap(); m.DEXJPUS = [];                         // BOJ FX gone
    expect(globalLiquidityLatest(m, '2024-04-05')).toBeNull();
  });
});

describe('globalLiquiditySeries', () => {
  it('skips dates with a missing component (no forward-fill of fakes)', () => {
    const m = fakeMap(); m.ECBASSETSW = [S('2024-04-05', 6400000)]; // ECB only at the later date
    const s = globalLiquiditySeries(m, '2024-04-05');
    expect(s.find(p => p.date === '2024-01-05')).toBeUndefined();   // ECB missing → skipped
    expect(s.find(p => p.date === '2024-04-05')).toBeDefined();
  });
  it('returns [] when WALCL is empty', () => {
    expect(globalLiquiditySeries({}, '2024-04-05')).toEqual([]);
  });
});
