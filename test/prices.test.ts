import { afterEach, describe, it, expect, vi } from 'vitest';
import { normalizeTnx, parseYahooQuote, parseStooqCsv, parseYahooCloses, parseYahooDailyObs, spliceSeries, evaluateLiveStress, fetchLivePrices, fetchStressSeries, fetchDxyDaily, YahooMarketDataProvider, StooqMarketDataProvider, FredMarketDataProvider } from '../src/prices';
import type { StressSeries } from '../src/prices';

describe('price parsing', () => {
  it('Yahoo quote preserves provider market time separately from fetch time', () => {
    const fetchedAt = '2026-07-19T12:00:00.000Z';
    const json = {
      chart: {
        result: [{
          meta: {
            regularMarketPrice: 5123.45,
            regularMarketTime: 1784318400,
            marketState: 'CLOSED',
            exchangeDataDelayedBy: 15,
          },
        }],
      },
    };

    expect((parseYahooQuote as any)(json, fetchedAt)).toEqual({
      value: 5123.45,
      sourceTimestamp: '2026-07-17T20:00:00.000Z',
      fetchedAt,
      marketState: 'CLOSED',
      isDelayed: true,
      sourceName: 'Yahoo Finance',
    });
  });

  it('normalizeTnx handles both 43.0 and 4.30 conventions', () => {
    expect(normalizeTnx(43.0)).toBeCloseTo(4.30);
    expect(normalizeTnx(4.30)).toBeCloseTo(4.30);
  });
  it('parseYahooQuote reads regularMarketPrice', () => {
    const json = { chart: { result: [{ meta: { regularMarketPrice: 5123.45, regularMarketTime: 1784318400 } }] } };
    expect(parseYahooQuote(json, '2026-07-19T12:00:00.000Z')?.value).toBeCloseTo(5123.45);
  });
  it('parseYahooQuote returns null on error shape', () => {
    expect(parseYahooQuote({ chart: { error: 'x', result: null } }, '2026-07-19T12:00:00.000Z')).toBeNull();
  });
  it('normalizes an untrusted Yahoo market state to UNKNOWN', () => {
    const json = { chart: { result: [{ meta: {
      regularMarketPrice: 5123.45,
      regularMarketTime: 1784318400,
      marketState: '<img src=x onerror=alert(1)>',
    } }] } };

    expect(parseYahooQuote(json, '2026-07-19T12:00:00.000Z')?.marketState).toBe('UNKNOWN');
  });
  it('parseStooqCsv reads close column', () => {
    const csv = 'Symbol,Date,Time,Open,High,Low,Close,Volume\n^SPX,2024-06-18,22:00:00,5100,5130,5090,5123.45,0\n';
    expect((parseStooqCsv as any)(csv, '2024-06-19T01:00:00.000Z')).toEqual({
      value: 5123.45,
      sourceTimestamp: '2024-06-18T22:00:00.000Z',
      fetchedAt: '2024-06-19T01:00:00.000Z',
      marketState: 'UNKNOWN',
      isDelayed: true,
      sourceName: 'Stooq',
    });
  });
});

function yahooChart(
  value: number,
  sourceSeconds: number,
  closes = [100, 101, 102, 103, 104, 105],
) {
  return {
    chart: {
      result: [{
        meta: {
          regularMarketPrice: value,
          regularMarketTime: sourceSeconds,
          marketState: 'CLOSED',
          exchangeDataDelayedBy: 0,
        },
        timestamp: closes.map((_, i) => sourceSeconds - (closes.length - 1 - i) * 86400),
        indicators: { quote: [{ close: closes }] },
      }],
    },
  };
}

function stooqQuote(symbol: string, date: string, time: string, value: number) {
  return `Symbol,Date,Time,Open,High,Low,Close,Volume\n${symbol},${date},${time},${value},${value},${value},${value},0\n`;
}

function stooqHistory(rows: Array<[string, number]>) {
  return 'Date,Open,High,Low,Close,Volume\n'
    + rows.map(([date, value]) => `${date},${value},${value},${value},${value},0`).join('\n')
    + '\n';
}

afterEach(() => vi.unstubAllGlobals());

describe('provider fallback and provenance', () => {
  it('retries a transient provider response before returning failure for fallback selection', async () => {
    const fetchedAt = '2026-07-17T22:00:00.000Z';
    const friday = Date.parse('2026-07-17T20:00:00.000Z') / 1000;
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(new Response('', { status: 503 }))
      .mockResolvedValueOnce(Response.json(yahooChart(5000, friday)));
    const provider = new YahooMarketDataProvider(fetchFn as any, { sleep: async () => undefined });

    const result = await provider.fetchQuote({ symbol: '^GSPC', fetchedAt });

    expect(result).toMatchObject({ status: 'OK', sourceName: 'Yahoo Finance', fallbackUsed: false });
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('does not retry a successful HTTP response with an invalid provider payload', async () => {
    const fetchFn = vi.fn(async () => Response.json({ chart: { result: null } }));
    const provider = new YahooMarketDataProvider(fetchFn as any, { sleep: async () => undefined });

    const result = await provider.fetchQuote({
      symbol: '^GSPC', fetchedAt: '2026-07-17T22:00:00.000Z',
    });

    expect(result).toMatchObject({ status: 'FAILED', reasonCode: 'INVALID_TIMESTAMP' });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
  it('uses the timestamp paired with the last valid Yahoo history close', async () => {
    const fetchFn = vi.fn(async () => Response.json({ chart: { result: [{
      timestamp: [1784232000, 1784318400],
      indicators: { quote: [{ close: [100, null] }] },
      meta: { marketState: 'CLOSED' },
    }] } }));
    const provider = new YahooMarketDataProvider(fetchFn as any);

    const result = await provider.fetchHistory({
      symbol: '^GSPC', fetchedAt: '2026-07-17T22:00:00.000Z',
    });

    expect(result.sourceTimestamp).toBe('2026-07-16T20:00:00.000Z');
    expect(result.points).toEqual([{ date: '2026-07-16', value: 100 }]);
  });

  it('rejects an out-of-order Yahoo history containing any future observation', async () => {
    const fetchFn = vi.fn(async () => Response.json({ chart: { result: [{
      timestamp: [1784404800, 1784318400], // future 2026-07-18 first, valid 2026-07-17 last
      indicators: { quote: [{ close: [999, 100] }] },
      meta: { marketState: 'CLOSED' },
    }] } }));
    const provider = new YahooMarketDataProvider(fetchFn as any);

    const result = await provider.fetchHistory({
      symbol: '^GSPC', fetchedAt: '2026-07-17T22:00:00.000Z',
    });

    expect(result).toMatchObject({ status: 'FAILED', reasonCode: 'FUTURE_TIMESTAMP', points: [] });
  });

  it('does not compare quote levels from different market dates', async () => {
    const fetchedAt = '2026-07-20T12:00:00.000Z';
    const yahooFriday = Date.parse('2026-07-17T20:00:00.000Z') / 1000;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('%5EGSPC') || url.includes('^GSPC')) return Response.json(yahooChart(6000, yahooFriday));
      if (url.includes('stooq.com') && url.includes('%5Espx')) {
        return new Response(stooqQuote('^SPX', '2026-07-16', '20:00:00', 5000));
      }
      if (url.includes('stooq.com')) return new Response('', { status: 503 });
      return Response.json(yahooChart(url.includes('TNX') ? 43 : 100, yahooFriday));
    }));

    const result = await fetchLivePrices(fetchedAt);

    expect(result.quotes.spx.status).toBe('OK');
    expect(result.spx).toBe(6000);
  });

  it('keeps a Friday market timestamp when fetched on Sunday', async () => {
    const fetchedAt = '2026-07-19T12:00:00.000Z';
    const friday = Date.parse('2026-07-17T20:00:00.000Z') / 1000;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('stooq.com')) return new Response('', { status: 503 });
      return Response.json(yahooChart(url.includes('TNX') ? 43 : 100, friday));
    }));

    const result = await fetchLivePrices(fetchedAt);

    expect((result as any).fetchedAt).toBe(fetchedAt);
    expect((result as any).asofSemantics).toBe('FETCH_TIME');
    expect((result as any).quotes.spx.sourceTimestamp).toBe('2026-07-17T20:00:00.000Z');
    expect((result as any).quotes.spx.status).toBe('OK');
  });

  it('uses named fallbacks for both DXY and 10Y when Yahoo fails', async () => {
    const fetchedAt = '2026-07-17T22:00:00.000Z';
    const friday = Date.parse('2026-07-17T20:00:00.000Z') / 1000;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('DX-Y.NYB') || url.includes('%5ETNX') || url.includes('^TNX')) {
        return new Response('', { status: 503 });
      }
      if (url.includes('stooq.com') && url.includes('dx.f')) {
        return new Response(stooqQuote('DX.F', '2026-07-17', '20:00:00', 98.2));
      }
      if (url.includes('api.stlouisfed.org') && url.includes('DGS10')) {
        return Response.json({ observations: [{ date: '2026-07-17', value: '4.25' }] });
      }
      if (url.includes('stooq.com')) return new Response('', { status: 503 });
      return Response.json(yahooChart(100, friday));
    }));

    const result = await (fetchLivePrices as any)(fetchedAt, { fredApiKey: 'test' });

    expect(result.dxy).toBeCloseTo(98.2);
    expect(result.us10y).toBeCloseTo(4.25);
    expect(result.quotes.dxy).toMatchObject({ status: 'OK', sourceName: 'Stooq', fallbackUsed: true });
    expect(result.quotes.us10y).toMatchObject({ status: 'OK', sourceName: 'FRED', fallbackUsed: true });
  });

  it('marks a comparable primary/secondary quote disagreement as SOURCE_DIVERGENCE', async () => {
    const fetchedAt = '2026-07-17T22:00:00.000Z';
    const friday = Date.parse('2026-07-17T20:00:00.000Z') / 1000;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('%5EGSPC') || url.includes('^GSPC')) return Response.json(yahooChart(6000, friday));
      if (url.includes('stooq.com') && url.includes('%5Espx')) {
        return new Response(stooqQuote('^SPX', '2026-07-17', '20:00:00', 5000));
      }
      if (url.includes('stooq.com')) return new Response('', { status: 503 });
      return Response.json(yahooChart(url.includes('TNX') ? 43 : 100, friday));
    }));

    const result = await fetchLivePrices(fetchedAt);

    expect((result as any).quotes.spx).toMatchObject({
      status: 'DIVERGENT', reasonCode: 'SOURCE_DIVERGENCE', fallbackUsed: false,
    });
    expect(result.spx).toBeNull();
  });

  it('uses history fallbacks and keeps live stress available', async () => {
    const fetchedAt = '2026-07-17T22:00:00.000Z';
    const friday = Date.parse('2026-07-17T20:00:00.000Z') / 1000;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('query1.finance.yahoo.com')) return new Response('', { status: 503 });
      if (url.includes('api.stlouisfed.org') && url.includes('DGS10')) {
        return Response.json({ observations: [
          { date: '2026-07-10', value: '4.00' }, { date: '2026-07-11', value: '4.02' },
          { date: '2026-07-12', value: '4.04' }, { date: '2026-07-13', value: '4.06' },
          { date: '2026-07-16', value: '4.08' }, { date: '2026-07-17', value: '4.10' },
        ] });
      }
      if (url.includes('api.stlouisfed.org')) return new Response('', { status: 503 });
      if (url.includes('stooq.com') && url.includes('10usy.b')) return new Response('', { status: 404 });
      if (url.includes('stooq.com')) {
        const base = url.includes('vix') ? 15 : url.includes('dx.f') ? 98 : 5000;
        return new Response(stooqHistory(Array.from({ length: 6 }, (_, i) => [
          `2026-07-${String(10 + i).padStart(2, '0')}`, base + i,
        ])));
      }
      return Response.json(yahooChart(100, friday));
    }));

    const series = await (fetchStressSeries as any)({ fetchedAt, fredApiKey: 'test' });
    const stress = evaluateLiveStress(series);

    expect(stress.status).not.toBe('UNKNOWN');
    expect((series as any).inputs.spx).toMatchObject({ sourceName: 'Stooq', fallbackUsed: true, status: 'OK' });
    expect((series as any).inputs.vix).toMatchObject({ sourceName: 'Stooq', fallbackUsed: true, status: 'OK' });
    expect((series as any).inputs.dxy).toMatchObject({ sourceName: 'Stooq', fallbackUsed: true, status: 'OK' });
    expect((series as any).inputs.us10y).toMatchObject({ sourceName: 'FRED', fallbackUsed: true, status: 'OK' });
  });

  it('compares histories only on their shared dates rather than unrelated provider ranges', async () => {
    const fetchedAt = '2026-07-17T22:00:00.000Z';
    const end = Date.parse('2026-07-17T20:00:00.000Z') / 1000;
    const closes = [100, 101, 102, 103, 104, 105];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('api.stlouisfed.org')) return new Response('', { status: 503 });
      if (url.includes('query1.finance.yahoo.com')) return Response.json(yahooChart(105, end, closes));
      return new Response(stooqHistory([
        ['2020-01-02', 1],
        ...closes.map((value, i): [string, number] => [`2026-07-${String(12 + i).padStart(2, '0')}`, value]),
      ]));
    }));

    const series = await (fetchStressSeries as any)({ fetchedAt });

    expect(series.inputs.spx.status).toBe('OK');
    expect(series.inputs.dxy.status).toBe('OK');
    expect(series.spx.at(-1)).toBe(105);
  });

  it.each(['FAILED', 'STALE', 'DIVERGENT'] as const)('fails stress closed when a required history is %s', (status) => {
    const complete: any = {
      spx: [5000, 5010, 5020, 5030, 5040, 5050],
      vix: [14, 15, 14, 15, 14, 15],
      us10y: [4.2, 4.2, 4.2, 4.2, 4.2, 4.2],
      dxy: [103, 103, 103, 103, 103, 103],
      inputs: {
        spx: { status: 'OK' }, vix: { status: 'OK' }, us10y: { status: 'OK' },
        dxy: { status, reasonCode: status === 'DIVERGENT' ? 'SOURCE_DIVERGENCE' : undefined },
      },
    };

    const result = evaluateLiveStress(complete);

    expect(result.status).toBe('UNKNOWN');
    expect(result.unavailable.join(' ')).toContain(status);
  });

  it('extends DXY daily through Stooq without changing point scale', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('yahoo')) return new Response('', { status: 503 });
      return new Response(stooqHistory([['2026-07-16', 98], ['2026-07-17', 99]]));
    });
    vi.stubGlobal('fetch', fetchMock);

    const points = await (fetchDxyDaily as any)({ fetchedAt: '2026-07-17T22:00:00.000Z' });

    expect(points).toEqual([{ date: '2026-07-16', value: 98 }, { date: '2026-07-17', value: 99 }]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.every(([input]) => /DX-Y\.NYB|dx\.f/.test(String(input)))).toBe(true);
  });

  it('rejects an impossible Stooq history calendar date as INVALID_TIMESTAMP', async () => {
    const provider = new StooqMarketDataProvider(vi.fn(async () =>
      new Response(stooqHistory([['2026-99-99', 100]]))) as any);

    const result = await provider.fetchHistory({ symbol: '^spx', fetchedAt: '2026-07-17T22:00:00.000Z' });

    expect(result).toMatchObject({ status: 'FAILED', reasonCode: 'INVALID_TIMESTAMP', points: [] });
    expect(result.sourceTimestamp).toBeNull();
  });

  it('rejects an impossible FRED observation calendar date as INVALID_TIMESTAMP', async () => {
    const provider = new FredMarketDataProvider('test', vi.fn(async () =>
      Response.json({ observations: [{ date: '2026-99-99', value: '4.25' }] })) as any);

    const result = await provider.fetchHistory({ symbol: 'DGS10', fetchedAt: '2026-07-17T22:00:00.000Z' });

    expect(result).toMatchObject({ status: 'FAILED', reasonCode: 'INVALID_TIMESTAMP', points: [] });
    expect(result.sourceTimestamp).toBeNull();
  });

  it('rejects Stooq quote dates and times that normalize into another instant', async () => {
    const provider = new StooqMarketDataProvider(vi.fn(async () =>
      new Response(stooqQuote('^SPX', '2026-02-30', '25:61:00', 5000))) as any);

    const result = await provider.fetchQuote({ symbol: '^spx', fetchedAt: '2026-03-02T22:00:00.000Z' });

    expect(result).toMatchObject({ status: 'FAILED', reasonCode: 'INVALID_TIMESTAMP', value: null });
  });

  it.each([
    ['Yahoo', new YahooMarketDataProvider(vi.fn(async () => Response.json(yahooChart(5000, Date.parse('2026-07-18T20:00:00.000Z') / 1000))) as any), '^GSPC'],
    ['Stooq', new StooqMarketDataProvider(vi.fn(async () => new Response(stooqQuote('^SPX', '2026-07-18', '20:00:00', 5000))) as any), '^spx'],
    ['FRED', new FredMarketDataProvider('test', vi.fn(async () => Response.json({ observations: [{ date: '2026-07-18', value: '5000' }] })) as any), 'SP500'],
  ] as const)('rejects a future %s observation instead of treating it as age zero', async (_name, provider, symbol) => {
    const result = await provider.fetchQuote({ symbol, fetchedAt: '2026-07-17T20:00:00.000Z' });

    expect(result).toMatchObject({ status: 'FAILED', reasonCode: 'FUTURE_TIMESTAMP', value: null });
  });

  it('does not coerce missing FRED values to zero', async () => {
    const provider = new FredMarketDataProvider('test', vi.fn(async () => Response.json({ observations: [
      { date: '2026-07-14', value: null },
      { date: '2026-07-15', value: '' },
      { date: '2026-07-16', value: '.' },
      { date: '2026-07-17', value: '4.25' },
    ] })) as any);

    const result = await provider.fetchHistory({ symbol: 'DGS10', fetchedAt: '2026-07-17T22:00:00.000Z' });

    expect(result.points).toEqual([{ date: '2026-07-17', value: 4.25 }]);
  });

  it('uses the named DTWEXBGS release-lag freshness window for official DXY fallback', async () => {
    const provider = new FredMarketDataProvider('test', vi.fn(async () => Response.json({
      observations: [{ date: '2026-07-13', value: '120' }],
    })) as any);

    const result = await provider.fetchHistory({ symbol: 'DTWEXBGS', fetchedAt: '2026-07-21T22:00:00.000Z' });

    expect(result.status).toBe('OK');
  });

  it('rejects a Stooq HTML challenge instead of parsing it as market history', async () => {
    const provider = new StooqMarketDataProvider(vi.fn(async () => new Response(
      '<!doctype html><script>challenge()</script>', { headers: { 'content-type': 'text/html' } },
    )) as any);

    const result = await provider.fetchHistory({ symbol: '^spx', fetchedAt: '2026-07-17T22:00:00.000Z' });

    expect(result).toMatchObject({ status: 'FAILED', reasonCode: 'INVALID_RESPONSE', points: [] });
  });

  it('rejects a Stooq JavaScript challenge response before CSV parsing', async () => {
    const provider = new StooqMarketDataProvider(vi.fn(async () => new Response(
      'window._cf_chl_opt={cvId:"3"};', { headers: { 'content-type': 'application/javascript' } },
    )) as any);

    const result = await provider.fetchHistory({ symbol: '^spx', fetchedAt: '2026-07-17T22:00:00.000Z' });

    expect(result).toMatchObject({ status: 'FAILED', reasonCode: 'INVALID_RESPONSE', points: [] });
  });

  it('keeps Stooq 404 explicit so the next fallback can be selected', async () => {
    const provider = new StooqMarketDataProvider(vi.fn(async () => new Response('', { status: 404 })) as any);

    expect(await provider.fetchQuote({ symbol: '^spx', fetchedAt: '2026-07-17T22:00:00.000Z' }))
      .toMatchObject({ status: 'FAILED', reasonCode: 'HTTP_ERROR' });
  });

  it('falls through Yahoo and unusable Stooq to official FRED quotes for all four symbols', async () => {
    const fetchedAt = '2026-07-17T22:00:00.000Z';
    const fredValues: Record<string, string> = { SP500: '5000', VIXCLS: '15', DTWEXBGS: '120', DGS10: '4.25' };
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('query1.finance.yahoo.com')) return new Response('', { status: 503 });
      if (url.includes('stooq.com')) return new Response('<script>challenge()</script>', { headers: { 'content-type': 'text/html' } });
      const id = new URL(url).searchParams.get('series_id') ?? '';
      return Response.json({ observations: [{ date: '2026-07-17', value: fredValues[id] }] });
    }));

    const result = await (fetchLivePrices as any)(fetchedAt, { fredApiKey: 'test' });

    expect(result).toMatchObject({ spx: 5000, vix: 15, dxy: 120, us10y: 4.25 });
    expect(result.quotes.spx).toMatchObject({ sourceName: 'FRED', sourceSymbol: 'SP500', fallbackUsed: true });
    expect(result.quotes.vix).toMatchObject({ sourceName: 'FRED', sourceSymbol: 'VIXCLS', fallbackUsed: true });
    expect(result.quotes.dxy).toMatchObject({
      sourceName: 'FRED', sourceSymbol: 'DTWEXBGS', sourceLabel: 'Broad U.S. Dollar Index', fallbackUsed: true,
    });
    expect(result.quotes.us10y).toMatchObject({ sourceName: 'FRED', sourceSymbol: 'DGS10', fallbackUsed: true });
  });

  it('uses official FRED histories when Yahoo and Stooq are unavailable', async () => {
    const fetchedAt = '2026-07-17T22:00:00.000Z';
    const ids: Record<string, number> = { SP500: 5000, VIXCLS: 15, DTWEXBGS: 120, DGS10: 4 };
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('query1.finance.yahoo.com')) return new Response('', { status: 503 });
      if (url.includes('stooq.com')) return new Response('', { status: 404 });
      const id = new URL(url).searchParams.get('series_id') ?? '';
      return Response.json({ observations: Array.from({ length: 6 }, (_, i) => ({
        date: `2026-07-${String(12 + i).padStart(2, '0')}`, value: String(ids[id] + i * 0.01),
      })) });
    }));

    const series = await (fetchStressSeries as any)({ fetchedAt, fredApiKey: 'test' });

    expect(Object.values(series.inputs).every((input: any) => input.status === 'OK' && input.sourceName === 'FRED')).toBe(true);
    expect(series.inputs.dxy).toMatchObject({ sourceSymbol: 'DTWEXBGS', sourceLabel: 'Broad U.S. Dollar Index' });
    expect(evaluateLiveStress(series).status).not.toBe('UNKNOWN');
  });

  it('falls through to FRED DTWEXBGS for DXY extension without rescaling its levels', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (!url.includes('api.stlouisfed.org')) return new Response('', { status: 503 });
      return Response.json({ observations: [
        { date: '2026-07-16', value: '120' }, { date: '2026-07-17', value: '121' },
      ] });
    }));

    const points = await (fetchDxyDaily as any)({ fetchedAt: '2026-07-17T22:00:00.000Z', fredApiKey: 'test' });

    expect(points).toEqual([{ date: '2026-07-16', value: 120 }, { date: '2026-07-17', value: 121 }]);
  });

  it('marks VIX histories divergent when providers disagree on the stress classification', async () => {
    const fetchedAt = '2026-07-17T22:00:00.000Z';
    const end = Date.parse('2026-07-17T20:00:00.000Z') / 1000;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('%5EVIX')) return Response.json(yahooChart(35, end, [35, 35, 35, 35, 35, 35]));
      if (url.includes('stooq.com') && url.includes('vix')) {
        return new Response(stooqHistory(Array.from({ length: 6 }, (_, i) => [`2026-07-${String(12 + i).padStart(2, '0')}`, 15])));
      }
      if (url.includes('stooq.com') || url.includes('api.stlouisfed.org')) return new Response('', { status: 503 });
      return Response.json(yahooChart(url.includes('TNX') ? 40 : 100, end));
    }));

    const series = await (fetchStressSeries as any)({ fetchedAt });

    expect(series.inputs.vix).toMatchObject({ status: 'DIVERGENT', reasonCode: 'SOURCE_DIVERGENCE' });
    expect(evaluateLiveStress(series).status).toBe('UNKNOWN');
  });

  it('marks same-class VIX histories divergent when latest levels differ materially', async () => {
    const fetchedAt = '2026-07-17T22:00:00.000Z';
    const end = Date.parse('2026-07-17T20:00:00.000Z') / 1000;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('%5EVIX')) return Response.json(yahooChart(20, end, [20, 20, 20, 20, 20, 20]));
      if (url.includes('stooq.com') && url.includes('vix')) {
        return new Response(stooqHistory(Array.from({ length: 6 }, (_, i) => [`2026-07-${12 + i}`, 27])));
      }
      if (url.includes('stooq.com') || url.includes('api.stlouisfed.org')) return new Response('', { status: 503 });
      return Response.json(yahooChart(url.includes('TNX') ? 40 : 100, end));
    }));

    const series = await (fetchStressSeries as any)({ fetchedAt });

    expect(series.inputs.vix).toMatchObject({ status: 'DIVERGENT', reasonCode: 'SOURCE_DIVERGENCE' });
  });

  it('marks 10Y histories divergent when providers disagree on the 5-day stress classification', async () => {
    const fetchedAt = '2026-07-17T22:00:00.000Z';
    const end = Date.parse('2026-07-17T20:00:00.000Z') / 1000;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('%5ETNX')) return Response.json(yahooChart(43, end, [40, 40.5, 41, 41.5, 42, 43]));
      if (url.includes('api.stlouisfed.org') && url.includes('DGS10')) {
        return Response.json({ observations: Array.from({ length: 6 }, (_, i) => ({ date: `2026-07-${12 + i}`, value: '4.00' })) });
      }
      if (url.includes('api.stlouisfed.org') || url.includes('stooq.com')) return new Response('', { status: 503 });
      return Response.json(yahooChart(100, end));
    }));

    const series = await (fetchStressSeries as any)({ fetchedAt, fredApiKey: 'test' });

    expect(series.inputs.us10y).toMatchObject({ status: 'DIVERGENT', reasonCode: 'SOURCE_DIVERGENCE' });
    expect(evaluateLiveStress(series).status).toBe('UNKNOWN');
  });

  it('marks same-class 10Y histories divergent when 5-day pp deltas differ materially', async () => {
    const fetchedAt = '2026-07-17T22:00:00.000Z';
    const end = Date.parse('2026-07-17T20:00:00.000Z') / 1000;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('%5ETNX')) return Response.json(yahooChart(43, end, [40, 40.5, 41, 41.5, 42, 43]));
      if (url.includes('api.stlouisfed.org') && url.includes('DGS10')) {
        const values = [4, 4.1, 4.2, 4.3, 4.4, 4.6];
        return Response.json({ observations: values.map((value, i) => ({ date: `2026-07-${12 + i}`, value: String(value) })) });
      }
      if (url.includes('api.stlouisfed.org') || url.includes('stooq.com')) return new Response('', { status: 503 });
      return Response.json(yahooChart(100, end));
    }));

    const series = await (fetchStressSeries as any)({ fetchedAt, fredApiKey: 'test' });

    expect(series.inputs.us10y).toMatchObject({ status: 'DIVERGENT', reasonCode: 'SOURCE_DIVERGENCE' });
  });

  it('times out a hung secondary without hanging otherwise usable live quotes', async () => {
    const fetchedAt = '2026-07-17T22:00:00.000Z';
    const end = Date.parse('2026-07-17T20:00:00.000Z') / 1000;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('stooq.com')) return new Promise<Response>(() => {});
      if (url.includes('api.stlouisfed.org')) return new Response('', { status: 503 });
      return Response.json(yahooChart(url.includes('TNX') ? 43 : 100, end));
    }));

    const result = await Promise.race([
      (fetchLivePrices as any)(fetchedAt, { providerTimeoutMs: 5 }),
      new Promise<null>(resolve => setTimeout(() => resolve(null), 100)),
    ]);

    expect(result).not.toBeNull();
    expect((result as any).quotes.spx.status).toBe('OK');
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

  it('complete calm series → NORMAL, stressed=false, reasons empty', () => {
    const result = evaluateLiveStress(calm);
    expect(result.status).toBe('NORMAL');
    expect(result.stressed).toBe(false);
    expect(result.reasons).toHaveLength(0);
  });

  it('VIX=35 → stressed, reasons contains VIX', () => {
    const s: StressSeries = { ...calm, vix: [14, 15, 14, 15, 14, 35] };
    const result = evaluateLiveStress(s);
    expect(result.status).toBe('STRESSED');
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

  it('empty arrays → UNKNOWN rather than false-safe', () => {
    const s: StressSeries = { spx: [], vix: [], us10y: [], dxy: [] };
    const result = evaluateLiveStress(s);
    expect(result.status).toBe('UNKNOWN');
    expect(result.stressed).toBe(false);
    expect(result.unavailable).toEqual(['VIX', 'SPX 5日', '10Y 5日', 'DXY 5日']);
    expect(result.signals.vix).toBeNull();
    expect(result.signals.spx5d).toBeNull();
    expect(result.signals.us10y5d).toBeNull();
    expect(result.signals.dxy5d).toBeNull();
  });

  it('one insufficient critical series makes the whole risk layer UNKNOWN', () => {
    const result = evaluateLiveStress({ ...calm, dxy: [103] });

    expect(result.status).toBe('UNKNOWN');
    expect(result.stressed).toBe(false);
    expect(result.unavailable).toEqual(['DXY 5日']);
  });
});

describe('evaluateLiveStress thresholds', () => {
  it('exposes the thresholds it evaluated against', () => {
    const s: StressSeries = { spx: [100], vix: [15], us10y: [4.2], dxy: [98] };
    const r = evaluateLiveStress(s);
    expect(r.thresholds).toEqual({ vix: 28, spxDd: -0.04, y10: 0.25, dxy: 0.02 });
  });
});

describe('parseYahooDailyObs', () => {
  it('pairs timestamps with closes as UTC dates, skipping nulls', () => {
    const json = {
      chart: {
        result: [{
          timestamp: [1784073600, 1784160000, 1784246400], // 2026-07-15/16/17 00:00 UTC
          indicators: { quote: [{ close: [98.2, null, 97.5] }] },
        }],
      },
    };
    expect(parseYahooDailyObs(json)).toEqual([
      { date: '2026-07-15', value: 98.2 },
      { date: '2026-07-17', value: 97.5 },
    ]);
  });
  it('returns empty on malformed shape', () => {
    expect(parseYahooDailyObs(null)).toEqual([]);
    expect(parseYahooDailyObs({ chart: { result: null } })).toEqual([]);
  });
});

describe('spliceSeries', () => {
  const base = [
    { date: '2026-07-08', value: 120 },
    { date: '2026-07-10', value: 121 },
  ];
  it('chains market returns onto the last base level', () => {
    const market = [
      { date: '2026-07-10', value: 98.0 },
      { date: '2026-07-14', value: 99.96 },
      { date: '2026-07-15', value: 96.04 },
    ];
    const out = spliceSeries(base, market);
    expect(out).toHaveLength(4);
    expect(out[0]).toEqual(base[0]);
    expect(out[2].date).toBe('2026-07-14');
    expect(out[2].value).toBeCloseTo(121 * (99.96 / 98.0));
    expect(out[3].value).toBeCloseTo(121 * (96.04 / 98.0));
  });
  it('uses nearest market obs on/before the base end as anchor', () => {
    const market = [
      { date: '2026-07-09', value: 100 },
      { date: '2026-07-14', value: 102 },
    ];
    const out = spliceSeries(base, market);
    expect(out).toHaveLength(3);
    expect(out[2].value).toBeCloseTo(121 * 1.02);
  });
  it('returns base unchanged when market has no anchor overlap', () => {
    const market = [{ date: '2026-07-14', value: 102 }];
    expect(spliceSeries(base, market)).toEqual(base);
  });
  it('returns base unchanged on empty inputs', () => {
    expect(spliceSeries(base, [])).toEqual(base);
    expect(spliceSeries([], [{ date: '2026-07-14', value: 1 }])).toEqual([]);
  });
});
