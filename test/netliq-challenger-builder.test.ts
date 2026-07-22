import { describe, expect, it } from 'vitest';
import { buildWeeklyNetLiquidity } from '../scripts/netliq-challenger.mjs';

const row = (date: string, value: number) => ({ date, value });

describe('continuous net-liquidity research builder', () => {
  it('builds Raw and Smooth in $B on WALCL Wednesdays using only observations visible by Wednesday', () => {
    const points = buildWeeklyNetLiquidity({
      WALCL: [row('2024-01-03', 8_000_000), row('2024-01-10', 8_100_000)],
      WDTGAL: [row('2024-01-03', 700_000), row('2024-01-10', 710_000)],
      WTREGEN: [
        row('2024-01-04', 620_000), row('2024-01-05', 630_000),
        row('2024-01-08', 640_000), row('2024-01-09', 650_000), row('2024-01-10', 660_000),
        row('2024-01-11', 9_999_000),
      ],
      RRPONTSYD: [
        row('2024-01-03', 500), row('2024-01-04', 490), row('2024-01-05', 480),
        row('2024-01-08', 470), row('2024-01-09', 460), row('2024-01-10', 450),
        row('2024-01-11', 9_999),
      ],
    });

    expect(points).toHaveLength(1);
    expect(points[0]).toMatchObject({
      observationDate: '2024-01-10',
      availableDate: '2024-01-12',
      rawLevel: 6_940,
      smoothLevel: 6_990,
    });
    expect(points[0].rawComponents).toEqual({ walclB: 8_100, tgaB: 710, rrpB: 450 });
    expect(points[0].smoothComponents).toEqual({ walclB: 8_100, tgaWeekAverageB: 640, rrpSma5B: 470 });
  });

  it('emits no point when a required as-of component or five RRP observations are missing', () => {
    const base = {
      WALCL: [row('2024-01-10', 8_100_000)],
      WDTGAL: [row('2024-01-10', 710_000)],
      WTREGEN: [row('2024-01-10', 660_000)],
      RRPONTSYD: [row('2024-01-08', 470), row('2024-01-09', 460), row('2024-01-10', 450)],
    };
    expect(buildWeeklyNetLiquidity(base)).toEqual([]);
    expect(buildWeeklyNetLiquidity({ ...base, WDTGAL: [] })).toEqual([]);
  });

  it('does not forward-fill a prior-week WDTGAL level into the WALCL Wednesday', () => {
    expect(buildWeeklyNetLiquidity({
      WALCL: [row('2024-01-10', 8_100_000)],
      WDTGAL: [row('2024-01-03', 710_000)],
      WTREGEN: [row('2024-01-10', 660_000)],
      RRPONTSYD: [
        row('2024-01-04', 490), row('2024-01-05', 480), row('2024-01-08', 470),
        row('2024-01-09', 460), row('2024-01-10', 450),
      ],
    })).toEqual([]);
  });

  it.each([
    ['unsorted', [row('2024-01-10', 2), row('2024-01-03', 1)]],
    ['duplicate', [row('2024-01-03', 1), row('2024-01-03', 2)]],
    ['non-finite', [row('2024-01-03', Number.NaN)]],
  ])('rejects %s source observations', (_label, WALCL) => {
    expect(() => buildWeeklyNetLiquidity({
      WALCL,
      WDTGAL: [row('2024-01-03', 1)],
      WTREGEN: [row('2024-01-03', 1)],
      RRPONTSYD: Array.from({ length: 5 }, (_, index) => row(`2023-12-${27 + index}`, 1)),
    })).toThrow();
  });

  it('requires WALCL anchor observations to be Wednesdays', () => {
    expect(() => buildWeeklyNetLiquidity({
      WALCL: [row('2024-01-04', 8_000_000)],
      WDTGAL: [row('2024-01-04', 700_000)],
      WTREGEN: [row('2024-01-04', 700_000)],
      RRPONTSYD: Array.from({ length: 5 }, (_, index) => row(`2024-01-0${index + 1}`, 1)),
    })).toThrow(/Wednesday/);
  });
});
