// @ts-nocheck — imports a .mjs file; logic is tested, types not needed here
import { describe, it, expect } from 'vitest';
import {
  mulberry32, addDays, forwardReturns, nonOverlappingIC, blockBootstrapIC, regimeBreakdown,
} from '../scripts/research-lib.mjs';

describe('mulberry32', () => {
  it('is reproducible for a fixed seed', () => {
    const a = mulberry32(12345); const b = mulberry32(12345);
    const seqA = [a(), a(), a()]; const seqB = [b(), b(), b()];
    expect(seqA).toEqual(seqB);
    expect(seqA[0]).toBeGreaterThanOrEqual(0);
    expect(seqA[0]).toBeLessThan(1);
  });
  it('differs across seeds', () => {
    const a = mulberry32(1); const b = mulberry32(2);
    expect(a()).not.toEqual(b());
  });
});

describe('addDays', () => {
  it('adds and subtracts calendar days (UTC)', () => {
    expect(addDays('2020-01-01', 31)).toBe('2020-02-01');
    expect(addDays('2020-03-01', -1)).toBe('2020-02-29');
  });
});

describe('forwardReturns', () => {
  const snaps = Array.from({ length: 20 }, (_, i) => ({
    date: addDays('2020-01-06', i * 7), spx: 100 + i, // weekly, strictly rising
  }));
  it('is positive for a rising market', () => {
    const fr = forwardReturns(snaps, 4);
    expect(fr.length).toBeGreaterThan(0);
    expect(fr.every(p => p.fwd > 0)).toBe(true);
  });
  it('drops snapshots with no forward target in tolerance', () => {
    const fr = forwardReturns(snaps, 4);
    expect(fr.length).toBeLessThan(snaps.length); // tail has no +4w target
    expect(Math.max(...fr.map(p => p.idx))).toBeLessThan(snaps.length - 1);
  });
});

describe('nonOverlappingIC', () => {
  it('returns fewer samples than the overlapping count and steps by >= horizon', () => {
    const pairs = Array.from({ length: 40 }, (_, i) => ({
      date: addDays('2020-01-06', i * 7), x: i % 5, fwd: (i % 5) / 100,
    }));
    const r = nonOverlappingIC(pairs, 13);
    expect(r.n).toBeLessThan(pairs.length);
    expect(r.n).toBeGreaterThan(0);
    expect(Math.abs(r.ic)).toBeLessThanOrEqual(1);
  });
});

describe('blockBootstrapIC', () => {
  const pairs = Array.from({ length: 120 }, (_, i) => ({ x: i, fwd: i + (i % 7) }));
  it('produces ordered CI, valid p, and is reproducible with a seeded rng', () => {
    const r1 = blockBootstrapIC(pairs, 13, 200, mulberry32(42));
    const r2 = blockBootstrapIC(pairs, 13, 200, mulberry32(42));
    expect(r1).toEqual(r2);                         // reproducible
    expect(r1.ci_lo).toBeLessThanOrEqual(r1.ci_hi); // ordered CI (NOT asserting it brackets point)
    expect(r1.p_value).toBeGreaterThanOrEqual(0);
    expect(r1.p_value).toBeLessThanOrEqual(1);
    expect(r1.iters).toBe(200);
  });
  it('degenerates safely when n is below the floor', () => {
    const few = [{ x: 1, fwd: 1 }, { x: 2, fwd: 2 }];
    const r = blockBootstrapIC(few, 13, 200, mulberry32(1));
    expect(r.iters).toBe(0);
    expect(r.ci_lo).toBe(r.point);
    expect(r.ci_hi).toBe(r.point);
  });
});

describe('regimeBreakdown', () => {
  it('groups by label, excludes null, and n sums to labelled pairs', () => {
    const pairs = Array.from({ length: 30 }, (_, i) => ({
      date: addDays('2020-01-06', i * 7), x: i, fwd: i % 3,
      grp: i < 10 ? 'a' : i < 20 ? 'b' : null,
    }));
    const out = regimeBreakdown(pairs, p => p.grp);
    expect(out.a.n).toBe(10);
    expect(out.b.n).toBe(10);
    expect(out).not.toHaveProperty('null');
    expect(Math.abs(out.a.ic)).toBeLessThanOrEqual(1);
  });
});
