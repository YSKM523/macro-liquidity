import { describe, it, expect } from 'vitest';
import { parseFredJson } from '../src/fred';

describe('parseFredJson', () => {
  it('drops missing "." and sorts ascending', () => {
    const json = { observations: [
      { date: '2024-01-10', value: '.' },
      { date: '2024-01-03', value: '5800000' },  // WALCL millions
      { date: '2024-01-17', value: '5700000' },
    ]};
    const out = parseFredJson('WALCL', json);
    expect(out.map(o => o.date)).toEqual(['2024-01-03', '2024-01-17']);
  });

  it('converts WALCL millions to billions', () => {
    const json = { observations: [{ date: '2024-01-03', value: '5800000' }] };
    expect(parseFredJson('WALCL', json)[0].value).toBeCloseTo(5800);
  });

  it('leaves billions series unconverted', () => {
    const json = { observations: [{ date: '2024-01-03', value: '550.5' }] };
    expect(parseFredJson('RRPONTSYD', json)[0].value).toBeCloseTo(550.5);
  });

  it('converts WTREGEN (TGA) millions to billions', () => {
    // FRED reports WTREGEN in millions (H.4.1), like WALCL — e.g. 880713 → $880.7B
    const json = { observations: [{ date: '2024-01-03', value: '880713' }] };
    expect(parseFredJson('WTREGEN', json)[0].value).toBeCloseTo(880.713);
  });
});
