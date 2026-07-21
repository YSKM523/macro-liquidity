import { MARKET_DATA_QUALITY, STRESS } from './config';

export type ProviderStatus = 'OK' | 'STALE' | 'DIVERGENT' | 'FAILED';
export type ProviderReasonCode = 'SOURCE_DIVERGENCE' | 'HTTP_ERROR' | 'INVALID_TIMESTAMP' | 'NO_DATA';
export type MarketSymbol = 'spx' | 'vix' | 'dxy' | 'us10y';
export interface ObsPoint { date: string; value: number }

export interface ProviderProvenance {
  sourceTimestamp: string | null;
  fetchedAt: string;
  marketState: string;
  isDelayed: boolean;
  sourceName: string;
  fallbackUsed: boolean;
  primarySourceName: string;
  status: ProviderStatus;
  reasonCode?: ProviderReasonCode;
  comparisonSourceName?: string;
}

export interface QuoteResult extends ProviderProvenance { value: number | null }
export interface SeriesResult extends ProviderProvenance { points: ObsPoint[] }

export interface QuoteRequest { symbol: string; fetchedAt: string }
export interface HistoryRequest { symbol: string; fetchedAt: string; range?: string }
export interface MarketDataProvider {
  readonly name: string;
  fetchQuote(request: QuoteRequest): Promise<QuoteResult>;
  fetchHistory(request: HistoryRequest): Promise<SeriesResult>;
}

export interface ParsedQuote {
  value: number;
  sourceTimestamp: string;
  fetchedAt: string;
  marketState: string;
  isDelayed: boolean;
  sourceName: string;
}

export interface LivePrices {
  spx: number | null;
  vix: number | null;
  dxy: number | null;
  us10y: number | null;
  /** @deprecated Fetch time only. Use fetchedAt; this is never market time. */
  asof: string;
  asofSemantics: 'FETCH_TIME';
  fetchedAt: string;
  quotes: Record<MarketSymbol, QuoteResult>;
}

export interface HistoryProvenance extends ProviderProvenance {}
export interface StressSeries {
  spx: number[];
  vix: number[];
  us10y: number[];
  dxy: number[];
  inputs?: Record<MarketSymbol, HistoryProvenance>;
}
export type StressStatus = 'NORMAL' | 'STRESSED' | 'UNKNOWN';
export interface LiveStress {
  status: StressStatus;
  stressed: boolean;
  reasons: string[];
  unavailable: string[];
  signals: { vix: number|null; spx5d: number|null; us10y5d: number|null; dxy5d: number|null };
  thresholds: { vix: number; spxDd: number; y10: number; dxy: number };
  inputs?: Record<MarketSymbol, HistoryProvenance>;
}

type Fetcher = typeof fetch;
interface FetchOptions { fetchFn?: Fetcher; fetchedAt?: string; fredApiKey?: string }

function validIso(value: string): boolean {
  return Number.isFinite(Date.parse(value));
}

function validCalendarDate(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day;
}

function businessAgeDays(sourceTimestamp: string, fetchedAt: string): number {
  const source = new Date(sourceTimestamp);
  const fetched = new Date(fetchedAt);
  if (!Number.isFinite(source.getTime()) || !Number.isFinite(fetched.getTime())) return Number.POSITIVE_INFINITY;
  source.setUTCHours(0, 0, 0, 0);
  fetched.setUTCHours(0, 0, 0, 0);
  let days = 0;
  for (let time = source.getTime() + 86400000; time <= fetched.getTime(); time += 86400000) {
    const dow = new Date(time).getUTCDay();
    if (dow !== 0 && dow !== 6) days++;
  }
  return Math.max(0, days);
}

function qualityStatus(sourceTimestamp: string, fetchedAt: string, maxAge: number): ProviderStatus {
  return businessAgeDays(sourceTimestamp, fetchedAt) > maxAge ? 'STALE' : 'OK';
}

function failedQuote(sourceName: string, fetchedAt: string, reasonCode: ProviderReasonCode): QuoteResult {
  return {
    value: null, sourceTimestamp: null, fetchedAt, marketState: 'UNKNOWN', isDelayed: false,
    sourceName, fallbackUsed: false, primarySourceName: sourceName, status: 'FAILED', reasonCode,
  };
}

function failedSeries(sourceName: string, fetchedAt: string, reasonCode: ProviderReasonCode): SeriesResult {
  return {
    points: [], sourceTimestamp: null, fetchedAt, marketState: 'UNKNOWN', isDelayed: false,
    sourceName, fallbackUsed: false, primarySourceName: sourceName, status: 'FAILED', reasonCode,
  };
}

export function parseYahooQuote(json: any, fetchedAt: string): ParsedQuote | null {
  const meta = json?.chart?.result?.[0]?.meta;
  const value = meta?.regularMarketPrice;
  const sourceSeconds = meta?.regularMarketTime;
  if (typeof value !== 'number' || !Number.isFinite(value) || typeof sourceSeconds !== 'number') return null;
  const sourceDate = new Date(sourceSeconds * 1000);
  if (!Number.isFinite(sourceDate.getTime())) return null;
  return {
    value,
    sourceTimestamp: sourceDate.toISOString(),
    fetchedAt,
    marketState: typeof meta.marketState === 'string' ? meta.marketState : 'UNKNOWN',
    isDelayed: typeof meta.exchangeDataDelayedBy === 'number' && meta.exchangeDataDelayedBy > 0,
    sourceName: 'Yahoo Finance',
  };
}

export function parseStooqCsv(csv: string, fetchedAt: string): ParsedQuote | null {
  const lines = csv.trim().split(/\r?\n/);
  if (lines.length < 2) return null;
  const cols = lines[lines.length - 1].split(',');
  const value = Number(cols[6]);
  const sourceTimestamp = `${cols[1]}T${cols[2]}Z`;
  if (!Number.isFinite(value) || !validIso(sourceTimestamp)) return null;
  return {
    value,
    sourceTimestamp: new Date(sourceTimestamp).toISOString(),
    fetchedAt,
    marketState: 'UNKNOWN',
    isDelayed: true,
    sourceName: 'Stooq',
  };
}

export function parseYahooDailyObs(json: any): ObsPoint[] {
  const result = json?.chart?.result?.[0];
  const timestamps: unknown[] = Array.isArray(result?.timestamp) ? result.timestamp : [];
  const closes: unknown[] = Array.isArray(result?.indicators?.quote?.[0]?.close)
    ? result.indicators.quote[0].close : [];
  const out: ObsPoint[] = [];
  for (let i = 0; i < timestamps.length; i++) {
    const timestamp = timestamps[i], close = closes[i];
    if (typeof timestamp === 'number' && typeof close === 'number' && Number.isFinite(close)) {
      const d = new Date(timestamp * 1000);
      if (Number.isFinite(d.getTime())) out.push({ date: d.toISOString().slice(0, 10), value: close });
    }
  }
  return out;
}

function parseStooqHistory(csv: string): { points: ObsPoint[]; invalidTimestamp: boolean } {
  const lines = csv.trim().split(/\r?\n/).slice(1);
  const points: ObsPoint[] = [];
  for (const line of lines) {
    const cols = line.split(',');
    const value = Number(cols[4]);
    if (!validCalendarDate(cols[0])) return { points: [], invalidTimestamp: true };
    if (Number.isFinite(value)) points.push({ date: cols[0], value });
  }
  return { points: points.sort((a, b) => a.date.localeCompare(b.date)), invalidTimestamp: false };
}

function yahooSourceTimestamp(json: any): string | null {
  const result = json?.chart?.result?.[0];
  const timestamps = result?.timestamp;
  const closes = result?.indicators?.quote?.[0]?.close;
  if (!Array.isArray(timestamps) || !Array.isArray(closes)) return null;
  for (let index = Math.min(timestamps.length, closes.length) - 1; index >= 0; index--) {
    if (typeof timestamps[index] !== 'number' || typeof closes[index] !== 'number' || !Number.isFinite(closes[index])) continue;
    const date = new Date(timestamps[index] * 1000);
    if (Number.isFinite(date.getTime())) return date.toISOString();
  }
  return null;
}

export class YahooMarketDataProvider implements MarketDataProvider {
  readonly name = 'Yahoo Finance';
  constructor(private readonly fetchFn: Fetcher = fetch) {}

  async fetchQuote({ symbol, fetchedAt }: QuoteRequest): Promise<QuoteResult> {
    try {
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=5d`;
      const response = await this.fetchFn(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (!response.ok) return failedQuote(this.name, fetchedAt, 'HTTP_ERROR');
      const parsed = parseYahooQuote(await response.json(), fetchedAt);
      if (!parsed) return failedQuote(this.name, fetchedAt, 'INVALID_TIMESTAMP');
      return {
        ...parsed, fallbackUsed: false, primarySourceName: this.name,
        status: qualityStatus(parsed.sourceTimestamp, fetchedAt, MARKET_DATA_QUALITY.quoteMaxAgeBusinessDays),
      };
    } catch {
      return failedQuote(this.name, fetchedAt, 'HTTP_ERROR');
    }
  }

  async fetchHistory({ symbol, fetchedAt, range = '1mo' }: HistoryRequest): Promise<SeriesResult> {
    try {
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=${range}`;
      const response = await this.fetchFn(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (!response.ok) return failedSeries(this.name, fetchedAt, 'HTTP_ERROR');
      const json: any = await response.json();
      const points = parseYahooDailyObs(json);
      const sourceTimestamp = yahooSourceTimestamp(json);
      if (!sourceTimestamp || points.length === 0) return failedSeries(this.name, fetchedAt, 'INVALID_TIMESTAMP');
      const meta = json?.chart?.result?.[0]?.meta;
      return {
        points, sourceTimestamp, fetchedAt,
        marketState: typeof meta?.marketState === 'string' ? meta.marketState : 'UNKNOWN',
        isDelayed: typeof meta?.exchangeDataDelayedBy === 'number' && meta.exchangeDataDelayedBy > 0,
        sourceName: this.name, fallbackUsed: false, primarySourceName: this.name,
        status: qualityStatus(sourceTimestamp, fetchedAt, MARKET_DATA_QUALITY.historyMaxAgeBusinessDays),
      };
    } catch {
      return failedSeries(this.name, fetchedAt, 'HTTP_ERROR');
    }
  }
}

export class StooqMarketDataProvider implements MarketDataProvider {
  readonly name = 'Stooq';
  constructor(private readonly fetchFn: Fetcher = fetch) {}

  async fetchQuote({ symbol, fetchedAt }: QuoteRequest): Promise<QuoteResult> {
    try {
      const url = `https://stooq.com/q/l/?s=${encodeURIComponent(symbol)}&f=sd2t2ohlcv&h&e=csv`;
      const response = await this.fetchFn(url);
      if (!response.ok) return failedQuote(this.name, fetchedAt, 'HTTP_ERROR');
      const parsed = parseStooqCsv(await response.text(), fetchedAt);
      if (!parsed) return failedQuote(this.name, fetchedAt, 'INVALID_TIMESTAMP');
      return {
        ...parsed, fallbackUsed: false, primarySourceName: this.name,
        status: qualityStatus(parsed.sourceTimestamp, fetchedAt, MARKET_DATA_QUALITY.quoteMaxAgeBusinessDays),
      };
    } catch {
      return failedQuote(this.name, fetchedAt, 'HTTP_ERROR');
    }
  }

  async fetchHistory({ symbol, fetchedAt }: HistoryRequest): Promise<SeriesResult> {
    try {
      const start = new Date(Date.parse(fetchedAt) - 45 * 86400000).toISOString().slice(0, 10).replaceAll('-', '');
      const url = `https://stooq.com/q/d/l/?s=${encodeURIComponent(symbol)}&i=d&d1=${start}`;
      const response = await this.fetchFn(url);
      if (!response.ok) return failedSeries(this.name, fetchedAt, 'HTTP_ERROR');
      const parsed = parseStooqHistory(await response.text());
      if (parsed.invalidTimestamp) return failedSeries(this.name, fetchedAt, 'INVALID_TIMESTAMP');
      const points = parsed.points;
      const last = points.at(-1);
      if (!last) return failedSeries(this.name, fetchedAt, 'NO_DATA');
      const sourceTimestamp = `${last.date}T00:00:00.000Z`;
      return {
        points, sourceTimestamp, fetchedAt, marketState: 'UNKNOWN', isDelayed: true,
        sourceName: this.name, fallbackUsed: false, primarySourceName: this.name,
        status: qualityStatus(sourceTimestamp, fetchedAt, MARKET_DATA_QUALITY.historyMaxAgeBusinessDays),
      };
    } catch {
      return failedSeries(this.name, fetchedAt, 'HTTP_ERROR');
    }
  }
}

export class FredMarketDataProvider implements MarketDataProvider {
  readonly name = 'FRED';
  constructor(private readonly apiKey: string, private readonly fetchFn: Fetcher = fetch) {}

  private async observations(symbol: string, fetchedAt: string): Promise<SeriesResult> {
    if (!this.apiKey) return failedSeries(this.name, fetchedAt, 'HTTP_ERROR');
    try {
      const url = new URL('https://api.stlouisfed.org/fred/series/observations');
      url.searchParams.set('series_id', symbol);
      url.searchParams.set('api_key', this.apiKey);
      url.searchParams.set('file_type', 'json');
      url.searchParams.set('observation_start', new Date(Date.parse(fetchedAt) - 45 * 86400000).toISOString().slice(0, 10));
      const response = await this.fetchFn(url.toString());
      if (!response.ok) return failedSeries(this.name, fetchedAt, 'HTTP_ERROR');
      const json: any = await response.json();
      const observations: any[] = Array.isArray(json?.observations) ? json.observations : [];
      const numericObservations = observations.filter((observation: any) => Number.isFinite(Number(observation?.value)));
      if (numericObservations.some((observation: any) => !validCalendarDate(observation?.date))) {
        return failedSeries(this.name, fetchedAt, 'INVALID_TIMESTAMP');
      }
      const points: ObsPoint[] = numericObservations
        .map((o: any) => ({ date: o.date, value: Number(o.value) }))
        .sort((a: ObsPoint, b: ObsPoint) => a.date.localeCompare(b.date));
      const last = points.at(-1);
      if (!last) return failedSeries(this.name, fetchedAt, 'NO_DATA');
      const sourceTimestamp = `${last.date}T00:00:00.000Z`;
      return {
        points, sourceTimestamp, fetchedAt, marketState: 'OFFICIAL', isDelayed: true,
        sourceName: this.name, fallbackUsed: false, primarySourceName: this.name,
        status: qualityStatus(sourceTimestamp, fetchedAt, MARKET_DATA_QUALITY.historyMaxAgeBusinessDays),
      };
    } catch {
      return failedSeries(this.name, fetchedAt, 'HTTP_ERROR');
    }
  }

  fetchHistory({ symbol, fetchedAt }: HistoryRequest): Promise<SeriesResult> {
    return this.observations(symbol, fetchedAt);
  }

  async fetchQuote({ symbol, fetchedAt }: QuoteRequest): Promise<QuoteResult> {
    const history = await this.observations(symbol, fetchedAt);
    const last = history.points.at(-1);
    return {
      value: last?.value ?? null,
      sourceTimestamp: history.sourceTimestamp,
      fetchedAt,
      marketState: history.marketState,
      isDelayed: history.isDelayed,
      sourceName: this.name,
      fallbackUsed: false,
      primarySourceName: this.name,
      status: history.status,
      reasonCode: history.reasonCode,
    };
  }
}

function relativeDifference(a: number, b: number): number {
  return Math.abs(a - b) / Math.max(Math.abs(a), Math.abs(b), Number.EPSILON);
}

function resolveQuote(primary: QuoteResult, secondary: QuoteResult, tolerance: number): QuoteResult {
  if (primary.status === 'OK' && secondary.status === 'OK'
      && primary.value != null && secondary.value != null
      && primary.sourceTimestamp?.slice(0, 10) === secondary.sourceTimestamp?.slice(0, 10)
      && relativeDifference(primary.value, secondary.value) > tolerance) {
    return {
      ...primary, status: 'DIVERGENT', reasonCode: 'SOURCE_DIVERGENCE',
      comparisonSourceName: secondary.sourceName,
    };
  }
  if (primary.status === 'OK') return primary;
  if (secondary.status === 'OK') {
    return { ...secondary, fallbackUsed: true, primarySourceName: primary.sourceName };
  }
  if (primary.status === 'STALE') return primary;
  if (secondary.status === 'STALE') {
    return { ...secondary, fallbackUsed: true, primarySourceName: primary.sourceName };
  }
  return primary;
}

function normalizedChange(points: ObsPoint[]): number | null {
  if (points.length < 2 || points[0].value === 0) return null;
  return points.at(-1)!.value / points[0].value - 1;
}

function sharedWindow(primary: ObsPoint[], secondary: ObsPoint[]): [ObsPoint[], ObsPoint[]] | null {
  const secondaryByDate = new Map(secondary.map(point => [point.date, point]));
  const primaryShared = primary.filter(point => secondaryByDate.has(point.date));
  if (primaryShared.length < 2) return null;
  return [primaryShared, primaryShared.map(point => secondaryByDate.get(point.date)!)];
}

function resolveHistory(primary: SeriesResult, secondary: SeriesResult, tolerance: number): SeriesResult {
  if (primary.status === 'OK' && secondary.status === 'OK') {
    // Yahoo commonly returns one month while Stooq returns full history. Only
    // compare normalized changes on exact shared dates, never unrelated starts.
    const shared = sharedWindow(primary.points, secondary.points);
    const a = shared ? normalizedChange(shared[0]) : null;
    const b = shared ? normalizedChange(shared[1]) : null;
    if (a != null && b != null && Math.abs(a - b) > tolerance) {
      return {
        ...primary, status: 'DIVERGENT', reasonCode: 'SOURCE_DIVERGENCE',
        comparisonSourceName: secondary.sourceName,
      };
    }
  }
  if (primary.status === 'OK') return primary;
  if (secondary.status === 'OK') {
    return { ...secondary, fallbackUsed: true, primarySourceName: primary.sourceName };
  }
  if (primary.status === 'STALE') return primary;
  if (secondary.status === 'STALE') {
    return { ...secondary, fallbackUsed: true, primarySourceName: primary.sourceName };
  }
  return primary;
}

function scaleQuote(result: QuoteResult, transform: (value: number) => number): QuoteResult {
  return result.value == null ? result : { ...result, value: transform(result.value) };
}

function scaleHistory(result: SeriesResult, transform: (value: number) => number): SeriesResult {
  return { ...result, points: result.points.map(p => ({ ...p, value: transform(p.value) })) };
}

export function normalizeTnx(raw: number): number {
  return raw > 20 ? raw / 10 : raw;
}

export async function fetchLivePrices(nowIso: string, options: Omit<FetchOptions, 'fetchedAt'> = {}): Promise<LivePrices> {
  const fetchFn = options.fetchFn ?? fetch;
  const yahoo = new YahooMarketDataProvider(fetchFn);
  const stooq = new StooqMarketDataProvider(fetchFn);
  const fred = new FredMarketDataProvider(options.fredApiKey ?? '', fetchFn);
  const quotePairs = await Promise.all([
    Promise.all([yahoo.fetchQuote({ symbol: '^GSPC', fetchedAt: nowIso }), stooq.fetchQuote({ symbol: '^spx', fetchedAt: nowIso })]),
    Promise.all([yahoo.fetchQuote({ symbol: '^VIX', fetchedAt: nowIso }), stooq.fetchQuote({ symbol: '^vix', fetchedAt: nowIso })]),
    Promise.all([yahoo.fetchQuote({ symbol: 'DX-Y.NYB', fetchedAt: nowIso }), stooq.fetchQuote({ symbol: 'dx.f', fetchedAt: nowIso })]),
    Promise.all([yahoo.fetchQuote({ symbol: '^TNX', fetchedAt: nowIso }), fred.fetchQuote({ symbol: 'DGS10', fetchedAt: nowIso })]),
  ]);
  const quotes: Record<MarketSymbol, QuoteResult> = {
    spx: resolveQuote(...quotePairs[0], MARKET_DATA_QUALITY.quoteRelativeTolerance.spx),
    vix: resolveQuote(...quotePairs[1], MARKET_DATA_QUALITY.quoteRelativeTolerance.vix),
    dxy: resolveQuote(...quotePairs[2], MARKET_DATA_QUALITY.quoteRelativeTolerance.dxy),
    us10y: resolveQuote(
      scaleQuote(quotePairs[3][0], normalizeTnx), quotePairs[3][1], MARKET_DATA_QUALITY.quoteRelativeTolerance.us10y,
    ),
  };
  const usable = (result: QuoteResult) => result.status === 'OK' ? result.value : null;
  return {
    spx: usable(quotes.spx), vix: usable(quotes.vix), dxy: usable(quotes.dxy), us10y: usable(quotes.us10y),
    asof: nowIso, asofSemantics: 'FETCH_TIME', fetchedAt: nowIso, quotes,
  };
}

function historyMeta(result: SeriesResult): HistoryProvenance {
  const { points: _points, ...meta } = result;
  return meta;
}

async function fetchMarketHistories(options: FetchOptions = {}): Promise<Record<MarketSymbol, SeriesResult>> {
  const fetchedAt = options.fetchedAt ?? new Date().toISOString();
  const fetchFn = options.fetchFn ?? fetch;
  const yahoo = new YahooMarketDataProvider(fetchFn);
  const stooq = new StooqMarketDataProvider(fetchFn);
  const fred = new FredMarketDataProvider(options.fredApiKey ?? '', fetchFn);
  const pairs = await Promise.all([
    Promise.all([yahoo.fetchHistory({ symbol: '^GSPC', fetchedAt }), stooq.fetchHistory({ symbol: '^spx', fetchedAt })]),
    Promise.all([yahoo.fetchHistory({ symbol: '^VIX', fetchedAt }), stooq.fetchHistory({ symbol: '^vix', fetchedAt })]),
    Promise.all([yahoo.fetchHistory({ symbol: 'DX-Y.NYB', fetchedAt }), stooq.fetchHistory({ symbol: 'dx.f', fetchedAt })]),
    Promise.all([yahoo.fetchHistory({ symbol: '^TNX', fetchedAt }), fred.fetchHistory({ symbol: 'DGS10', fetchedAt })]),
  ]);
  return {
    spx: resolveHistory(...pairs[0], MARKET_DATA_QUALITY.historyReturnTolerance.spx),
    vix: resolveHistory(...pairs[1], MARKET_DATA_QUALITY.historyReturnTolerance.vix),
    dxy: resolveHistory(...pairs[2], MARKET_DATA_QUALITY.historyReturnTolerance.dxy),
    us10y: resolveHistory(
      scaleHistory(pairs[3][0], normalizeTnx), pairs[3][1], MARKET_DATA_QUALITY.historyReturnTolerance.us10y,
    ),
  };
}

export async function fetchStressSeries(options: FetchOptions = {}): Promise<StressSeries> {
  const results = await fetchMarketHistories(options);
  const values = (result: SeriesResult) => result.status === 'OK' ? result.points.map(p => p.value) : [];
  return {
    spx: values(results.spx), vix: values(results.vix), dxy: values(results.dxy), us10y: values(results.us10y),
    inputs: {
      spx: historyMeta(results.spx), vix: historyMeta(results.vix),
      dxy: historyMeta(results.dxy), us10y: historyMeta(results.us10y),
    },
  };
}

export async function fetchDxyDaily(options: FetchOptions = {}): Promise<ObsPoint[]> {
  const fetchedAt = options.fetchedAt ?? new Date().toISOString();
  const fetchFn = options.fetchFn ?? fetch;
  const yahoo = new YahooMarketDataProvider(fetchFn);
  const stooq = new StooqMarketDataProvider(fetchFn);
  const [primary, secondary] = await Promise.all([
    yahoo.fetchHistory({ symbol: 'DX-Y.NYB', fetchedAt }),
    stooq.fetchHistory({ symbol: 'dx.f', fetchedAt }),
  ]);
  const result = resolveHistory(primary, secondary, MARKET_DATA_QUALITY.historyReturnTolerance.dxy);
  return result.status === 'OK' ? result.points : [];
}

/**
 * Chain market-index returns onto the end of a slower official series.
 * Anchor = nearest market obs on/before the base's last date; each later market
 * date extends the base at base_last * (mkt / anchor). Levels stay on the base's
 * scale, so DXY (~98) can extend DTWEXBGS (~120) without a level break.
 */
export function spliceSeries(base: ObsPoint[], market: ObsPoint[]): ObsPoint[] {
  if (base.length === 0 || market.length === 0) return base;
  const mkt = [...market].sort((a, b) => a.date < b.date ? -1 : 1);
  const last = base[base.length - 1];
  let anchor: ObsPoint | undefined;
  for (const observation of mkt) { if (observation.date <= last.date) anchor = observation; else break; }
  if (!anchor || anchor.value === 0) return base;
  const extension = mkt.filter(observation => observation.date > last.date)
    .map(observation => ({ date: observation.date, value: last.value * (observation.value / anchor!.value) }));
  return extension.length ? [...base, ...extension] : base;
}

export function parseYahooCloses(json: any): number[] {
  const closes = json?.chart?.result?.[0]?.indicators?.quote?.[0]?.close;
  return Array.isArray(closes)
    ? closes.filter((value: any) => typeof value === 'number' && Number.isFinite(value))
    : [];
}

export function evaluateLiveStress(series: StressSeries, thresholds = STRESS): LiveStress {
  const last = (values: number[]) => values.length ? values[values.length - 1] : null;
  const ago5 = (values: number[]) => values.length >= 6 ? values[values.length - 6] : null;
  const vix = last(series.vix);
  const spxCurrent = last(series.spx), spxPrior = ago5(series.spx);
  const spx5d = spxCurrent != null && spxPrior != null && spxPrior !== 0 ? spxCurrent / spxPrior - 1 : null;
  const yCurrent = last(series.us10y), yPrior = ago5(series.us10y);
  const us10y5d = yCurrent != null && yPrior != null ? yCurrent - yPrior : null;
  const dxyCurrent = last(series.dxy), dxyPrior = ago5(series.dxy);
  const dxy5d = dxyCurrent != null && dxyPrior != null && dxyPrior !== 0 ? dxyCurrent / dxyPrior - 1 : null;

  const reasons: string[] = [];
  if (vix != null && vix > thresholds.vix) reasons.push(`VIX ${vix.toFixed(1)} > ${thresholds.vix}`);
  if (spx5d != null && spx5d < thresholds.spxDd) reasons.push(`SPX 5日 ${(spx5d * 100).toFixed(1)}%`);
  if (us10y5d != null && us10y5d > thresholds.y10) reasons.push(`10Y 5日 +${us10y5d.toFixed(2)}pp`);
  if (dxy5d != null && dxy5d > thresholds.dxy) reasons.push(`美元 5日 +${(dxy5d * 100).toFixed(1)}%`);

  const unavailable: string[] = [];
  const requireInput = (symbol: MarketSymbol, label: string, enough: boolean) => {
    const meta = series.inputs?.[symbol];
    if (meta && meta.status !== 'OK') {
      unavailable.push(`${label} (${meta.status}${meta.reasonCode ? `: ${meta.reasonCode}` : ''})`);
    } else if (!enough) unavailable.push(label);
  };
  requireInput('vix', 'VIX', series.vix.length >= 1);
  requireInput('spx', 'SPX 5日', series.spx.length >= 6);
  requireInput('us10y', '10Y 5日', series.us10y.length >= 6);
  requireInput('dxy', 'DXY 5日', series.dxy.length >= 6);
  const status: StressStatus = unavailable.length > 0 ? 'UNKNOWN' : reasons.length > 0 ? 'STRESSED' : 'NORMAL';
  return {
    status, stressed: status === 'STRESSED', reasons, unavailable,
    signals: { vix, spx5d, us10y5d, dxy5d },
    thresholds: { vix: thresholds.vix, spxDd: thresholds.spxDd, y10: thresholds.y10, dxy: thresholds.dxy },
    inputs: series.inputs,
  };
}
