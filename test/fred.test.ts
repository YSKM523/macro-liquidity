import { describe, it, expect, vi } from 'vitest';
// @ts-ignore Node test runtime Web Crypto shim.
import { webcrypto } from 'node:crypto';
import { fetchFredSeriesPit, parseFredJson, parseFredPitJson } from '../src/fred';

Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });

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

describe('ALFRED vintages', () => {
  it('parses revisions, preserves units, and skips missing values', async () => {
    const result = await parseFredPitJson('WALCL', {
      observations: [
        { date: '2024-01-03', realtime_start: '2024-01-04', value: '5800000' },
        { date: '2024-01-03', realtime_start: '2024-01-08', value: '5900000' },
        { date: '2024-01-10', realtime_start: '2024-01-10', value: '.' },
      ],
    }, '2024-01-10T18:00:00Z', { expectedReleaseTime: '23:59:59' }, new Map());
    expect(result.map(row => row.value)).toEqual([5800, 5900]);
    expect(result[0]).toMatchObject({ observationDate: '2024-01-03', vintageDate: '2024-01-04' });
  });

  it('fetches output_type=3 with an inclusive checkpoint and paginates', async () => {
    const requests: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      requests.push(String(url));
      const offset = new URL(String(url)).searchParams.get('offset');
      return new Response(JSON.stringify({
        count: 100001, limit: 100000, offset: Number(offset),
        observations: offset === '0'
          ? [{ date: '2024-01-03', realtime_start: '2024-01-04', value: '5800000' }]
          : [{ date: '2024-01-10', realtime_start: '2024-01-10', value: '5900000' }],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }));
    const result = await fetchFredSeriesPit(
      'WALCL', '2003-01-01', '2024-01-04', '2024-01-10T18:00:00Z', 'key',
      { expectedReleaseTime: '23:59:59' }, new Map(),
    );
    expect(requests).toHaveLength(2);
    const url = new URL(requests[0]);
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      output_type: '3', realtime_start: '2024-01-04', realtime_end: '2024-01-10',
      observation_start: '2003-01-01', file_type: 'json', limit: '100000', offset: '0',
    });
    expect(result.latestRows.map(row => row.date)).toEqual(['2024-01-03', '2024-01-10']);
    vi.unstubAllGlobals();
  });

  it('timestamps a same-day vintage after the successful response rather than at run start', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      count: 1, limit: 100000, offset: 0,
      observations: [{ date: '2024-01-10', realtime_start: '2024-01-10', value: '5800000' }],
    }), { status: 200 })));
    const result = await fetchFredSeriesPit(
      'WALCL', '2003-01-01', '2024-01-10', '2024-01-10T18:00:00Z', 'key',
      { expectedReleaseTime: '23:59:59' }, new Map(), () => '2024-01-10T18:00:05Z',
    );
    expect(result.vintages[0]).toMatchObject({
      fetchedAt: '2024-01-10T18:00:05Z', releasedAt: '2024-01-10T18:00:05Z',
      releaseTimeStatus: 'OBSERVED_AT_FETCH',
    });
    vi.unstubAllGlobals();
  });
});
