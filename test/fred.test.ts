import { describe, it, expect, vi } from 'vitest';
// @ts-ignore Node test runtime Web Crypto shim.
import { webcrypto } from 'node:crypto';
import { fetchFredSeries, fetchFredSeriesPit, parseFredJson, parseFredPitJson } from '../src/fred';

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

describe('FRED bounded retries', () => {
  it('times out each hung FRED attempt without using wall-clock waits', async () => {
    const signals: AbortSignal[] = [];
    const fetchFn = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      signals.push(init!.signal as AbortSignal);
      return new Promise<Response>(() => {});
    });

    await expect(fetchFredSeries('WALCL', '2024-01-01', 'key', {
      fetchFn: fetchFn as any,
      maxAttempts: 3,
      attemptTimeoutMs: 100,
      sleep: async () => undefined,
      setTimeoutFn: ((callback: () => void) => { queueMicrotask(callback); return 1; }) as any,
      clearTimeoutFn: vi.fn(),
    })).rejects.toThrow(/timeout/i);

    expect(fetchFn).toHaveBeenCalledTimes(3);
    expect(new Set(signals).size).toBe(3);
    expect(signals.every(signal => signal.aborted)).toBe(true);
  });

  it('recovers from a transient FRED response before parsing', async () => {
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(new Response('', { status: 503 }))
      .mockResolvedValueOnce(Response.json({ observations: [{ date: '2024-01-03', value: '5800000' }] }));
    const sleep = vi.fn(async () => undefined);

    const rows = await fetchFredSeries('WALCL', '2024-01-01', 'key', { fetchFn: fetchFn as any, sleep });

    expect(rows).toEqual([{ date: '2024-01-03', value: 5800 }]);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it('surfaces the terminal FRED status after bounded exhaustion', async () => {
    const fetchFn = vi.fn(async () => new Response('', { status: 503 }));

    await expect(fetchFredSeries('WALCL', '2024-01-01', 'key', {
      fetchFn: fetchFn as any, sleep: async () => undefined,
    })).rejects.toThrow('FRED WALCL 503');
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });

  it('does not retry a non-transient FRED 4xx', async () => {
    const fetchFn = vi.fn(async () => new Response('', { status: 404 }));

    await expect(fetchFredSeries('WALCL', '2024-01-01', 'key', {
      fetchFn: fetchFn as any, sleep: async () => undefined,
    })).rejects.toThrow('FRED WALCL 404');
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('releases a terminal FRED error body before surfacing its status', async () => {
    const cancel = vi.fn(async () => undefined);
    const fetchFn = vi.fn(async () => new Response(new ReadableStream({ cancel }), { status: 503 }));

    await expect(fetchFredSeries('WALCL', '2024-01-01', 'key', {
      fetchFn: fetchFn as any, maxAttempts: 1,
    })).rejects.toThrow('FRED WALCL 503');
    expect(cancel).toHaveBeenCalledTimes(1);
  });
});

describe('ALFRED vintages', () => {
  it('allows each PIT page up to the provider policy maximum by default', async () => {
    const delays: number[] = [];
    const fetchFn = vi.fn(async () => new Promise<Response>(() => {}));

    await expect(fetchFredSeriesPit(
      'WALCL', '2003-01-01', '2024-01-04', '2024-01-10T18:00:00Z', 'key',
      { expectedReleaseTime: '23:59:59' }, new Map(), undefined,
      {
        fetchFn: fetchFn as any,
        maxAttempts: 1,
        sleep: async () => undefined,
        setTimeoutFn: ((callback: () => void, delay: number) => {
          delays.push(delay);
          queueMicrotask(callback);
          return 1;
        }) as any,
        clearTimeoutFn: vi.fn(),
      },
    )).rejects.toThrow(/timeout/i);

    expect(delays).toEqual([30_000]);
  });

  it('times out each hung ALFRED page attempt without using wall-clock waits', async () => {
    const fetchFn = vi.fn(async () => new Promise<Response>(() => {}));

    await expect(fetchFredSeriesPit(
      'WALCL', '2003-01-01', '2024-01-04', '2024-01-10T18:00:00Z', 'key',
      { expectedReleaseTime: '23:59:59' }, new Map(), undefined,
      {
        fetchFn: fetchFn as any,
        maxAttempts: 3,
        attemptTimeoutMs: 100,
        sleep: async () => undefined,
        setTimeoutFn: ((callback: () => void) => { queueMicrotask(callback); return 1; }) as any,
        clearTimeoutFn: vi.fn(),
      },
    )).rejects.toThrow(/timeout/i);
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });

  it('recovers from a transient ALFRED page response', async () => {
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(new Response('', { status: 429 }))
      .mockResolvedValueOnce(Response.json({
        count: 1, limit: 100000, offset: 0,
        observations: [{ date: '2024-01-03', realtime_start: '2024-01-04', value: '5800000' }],
      }));
    const result = await fetchFredSeriesPit(
      'WALCL', '2003-01-01', '2024-01-04', '2024-01-10T18:00:00Z', 'key',
      { expectedReleaseTime: '23:59:59' }, new Map(), undefined,
      { fetchFn: fetchFn as any, sleep: async () => undefined },
    );

    expect(result.latestRows).toEqual([{ date: '2024-01-03', value: 5800 }]);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('does not retry ALFRED parse failures after a successful HTTP response', async () => {
    const fetchFn = vi.fn(async () => new Response('{not-json', { status: 200 }));

    await expect(fetchFredSeriesPit(
      'WALCL', '2003-01-01', '2024-01-04', '2024-01-10T18:00:00Z', 'key',
      { expectedReleaseTime: '23:59:59' }, new Map(), undefined,
      { fetchFn: fetchFn as any, sleep: async () => undefined },
    )).rejects.toThrow();
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('surfaces the terminal ALFRED status after bounded exhaustion', async () => {
    const fetchFn = vi.fn(async () => new Response('', { status: 503 }));

    await expect(fetchFredSeriesPit(
      'WALCL', '2003-01-01', '2024-01-04', '2024-01-10T18:00:00Z', 'key',
      { expectedReleaseTime: '23:59:59' }, new Map(), undefined,
      { fetchFn: fetchFn as any, sleep: async () => undefined },
    )).rejects.toThrow('ALFRED WALCL 503');
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });

  it('does not retry a non-transient ALFRED 4xx', async () => {
    const fetchFn = vi.fn(async () => new Response('', { status: 404 }));

    await expect(fetchFredSeriesPit(
      'WALCL', '2003-01-01', '2024-01-04', '2024-01-10T18:00:00Z', 'key',
      { expectedReleaseTime: '23:59:59' }, new Map(), undefined,
      { fetchFn: fetchFn as any, sleep: async () => undefined },
    )).rejects.toThrow('ALFRED WALCL 404');
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
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

  it('parses output_type=3 wide JSON vintage fields', async () => {
    const result = await parseFredPitJson('WALCL', {
      output_type: 3,
      observations: [{
        date: '2024-01-03',
        WALCL_20240104: '5800000',
        WALCL_20240108: '5900000',
      }],
    }, '2024-01-10T18:00:00Z', { expectedReleaseTime: '23:59:59' }, new Map());

    expect(result.map(row => ({
      observationDate: row.observationDate,
      vintageDate: row.vintageDate,
      value: row.value,
    }))).toEqual([
      { observationDate: '2024-01-03', vintageDate: '2024-01-04', value: 5800 },
      { observationDate: '2024-01-03', vintageDate: '2024-01-08', value: 5900 },
    ]);
  });

  it('selects the unique release rule covering each vintage date', async () => {
    const result = await parseFredPitJson('WALCL', {
      observations: [
        { date: '2024-01-03', realtime_start: '2024-01-15', value: '5800000' },
        { date: '2024-02-07', realtime_start: '2024-02-15', value: '5900000' },
      ],
    }, '2024-03-01T18:00:00Z', [
      { expectedReleaseTime: '12:00:00', validFrom: '2024-01-01', validTo: '2024-01-31' },
      { expectedReleaseTime: '18:00:00', validFrom: '2024-02-01', validTo: '2024-12-31' },
    ], new Map());
    expect(result.map(row => row.releasedAt)).toEqual([
      '2024-01-15T12:00:00Z', '2024-02-15T18:00:00Z',
    ]);
  });

  it.each([
    [[{ expectedReleaseTime: '12:00:00', validFrom: '2024-02-01', validTo: '2024-12-31' }], 'missing'],
    [[
      { expectedReleaseTime: '12:00:00', validFrom: '2024-01-01', validTo: '2024-12-31' },
      { expectedReleaseTime: '18:00:00', validFrom: '2024-01-15', validTo: '2024-01-31' },
    ], 'overlap'],
  ] as const)('fails closed when release rules do not have a unique vintage match', async (rules, _kind) => {
    await expect(parseFredPitJson('WALCL', {
      observations: [{ date: '2024-01-03', realtime_start: '2024-01-15', value: '5800000' }],
    }, '2024-03-01T18:00:00Z', [...rules], new Map())).rejects.toThrow(/unique release rule/i);
  });

  it('rejects malformed or reversed release-rule validity bounds', async () => {
    const json = {
      observations: [{ date: '2024-01-03', realtime_start: '2024-01-15', value: '5800000' }],
    };
    await expect(parseFredPitJson('WALCL', json, '2024-03-01T18:00:00Z', [{
      expectedReleaseTime: '12:00:00', validFrom: 'not-a-date', validTo: '2024-12-31',
    }], new Map())).rejects.toThrow(/release rule/i);
    await expect(parseFredPitJson('WALCL', json, '2024-03-01T18:00:00Z', [{
      expectedReleaseTime: '12:00:00', validFrom: '2024-02-01', validTo: '2024-01-01',
    }], new Map())).rejects.toThrow(/release rule/i);
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

  it('splits the real-time range to stay within ALFREDs 2000-vintage limit', async () => {
    const requests: URL[] = [];
    const fetchFn = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      requests.push(url);
      const realtimeStart = url.searchParams.get('realtime_start')!;
      const realtimeEnd = url.searchParams.get('realtime_end')!;
      const rangeDays = (
        Date.parse(`${realtimeEnd}T00:00:00Z`) - Date.parse(`${realtimeStart}T00:00:00Z`)
      ) / 86_400_000 + 1;
      if (rangeDays > 2000) return new Response('too many vintage dates', { status: 400 });
      return Response.json({
        count: 1,
        limit: 100000,
        offset: 0,
        output_type: 3,
        observations: [{
          date: realtimeStart,
          [`RRPONTSYD_${realtimeStart.replaceAll('-', '')}`]: '1',
        }],
      });
    });

    const result = await fetchFredSeriesPit(
      'RRPONTSYD', '2016-01-01', '2016-01-01', '2026-07-23T18:00:00Z', 'key',
      { expectedReleaseTime: '23:59:59' }, new Map(), undefined,
      { fetchFn: fetchFn as any, maxAttempts: 1 },
    );

    expect(requests).toHaveLength(2);
    expect(requests.map(url => [
      url.searchParams.get('realtime_start'),
      url.searchParams.get('realtime_end'),
    ])).toEqual([
      ['2016-01-01', '2021-06-22'],
      ['2021-06-23', '2026-07-23'],
    ]);
    expect(result.vintages).toHaveLength(2);
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
