import { MARKET_DATA_QUALITY, STRESS } from './config';
import {
  HttpAttemptBudgetExhaustedError,
  HttpAttemptTimeoutError,
  fetchWithRetry,
  releaseResponseBody,
} from './http-retry';
import type { HttpRetryOptions } from './http-retry';

export type ProviderStatus = 'OK' | 'STALE' | 'DIVERGENT' | 'FAILED';
export type ProviderReasonCode = 'SOURCE_DIVERGENCE' | 'HTTP_ERROR' | 'INVALID_RESPONSE'
  | 'INVALID_TIMESTAMP' | 'FUTURE_TIMESTAMP' | 'NO_DATA' | 'TIMEOUT' | 'ATTEMPT_BUDGET_EXHAUSTED';
export type MarketSymbol = 'spx' | 'vix' | 'dxy' | 'us10y';
export interface ObsPoint { date: string; value: number }

export interface ProviderProvenance {
  sourceTimestamp: string | null;
  fetchedAt: string;
  marketState: string;
  isDelayed: boolean;
  sourceName: string;
  sourceSymbol: string;
  sourceLabel: string;
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
export interface ProviderFetchOptions extends HttpRetryOptions {
  fetchFn?: Fetcher;
  fetchedAt?: string;
  fredApiKey?: string;
  providerTimeoutMs?: number;
}

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

function validClockTime(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = /^(\d{2}):(\d{2}):(\d{2})$/.exec(value);
  if (!match) return false;
  const hour = Number(match[1]), minute = Number(match[2]), second = Number(match[3]);
  return hour <= 23 && minute <= 59 && second <= 59;
}

function isFutureTimestamp(sourceTimestamp: string, fetchedAt: string): boolean {
  const source = Date.parse(sourceTimestamp), fetched = Date.parse(fetchedAt);
  if (!Number.isFinite(source) || !Number.isFinite(fetched)) return false;
  return source > fetched + MARKET_DATA_QUALITY.maxFutureSkewMinutes * 60_000;
}

const INSTRUMENT_LABELS: Record<string, string> = {
  '^GSPC': 'S&P 500', '^spx': 'S&P 500', SP500: 'S&P 500',
  '^VIX': 'CBOE VIX', '^vix': 'CBOE VIX', VIXCLS: 'CBOE VIX',
  'DX-Y.NYB': 'ICE U.S. Dollar Index', 'dx.f': 'U.S. Dollar Index Futures',
  DTWEXBGS: 'Broad U.S. Dollar Index',
  '^TNX': '10-Year Treasury Yield', DGS10: '10-Year Treasury Yield',
};

function sourceLabel(symbol: string): string {
  return INSTRUMENT_LABELS[symbol] ?? symbol;
}

function errorReason(error: unknown): ProviderReasonCode {
  if (error instanceof HttpAttemptTimeoutError) return 'TIMEOUT';
  if (error instanceof HttpAttemptBudgetExhaustedError) return 'ATTEMPT_BUDGET_EXHAUSTED';
  return 'HTTP_ERROR';
}

function providerRetryOptions(options: ProviderFetchOptions): HttpRetryOptions {
  return {
    ...options,
    attemptTimeoutMs: options.providerTimeoutMs ?? options.attemptTimeoutMs
      ?? MARKET_DATA_QUALITY.providerTimeoutMs,
  };
}

function knownYahooMarketState(value: unknown): string {
  return typeof value === 'string' && ['REGULAR', 'PRE', 'PREPRE', 'POST', 'POSTPOST', 'CLOSED'].includes(value)
    ? value : 'UNKNOWN';
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

function failedQuote(sourceName: string, fetchedAt: string, reasonCode: ProviderReasonCode, symbol = ''): QuoteResult {
  return {
    value: null, sourceTimestamp: null, fetchedAt, marketState: 'UNKNOWN', isDelayed: false,
    sourceName, sourceSymbol: symbol, sourceLabel: sourceLabel(symbol),
    fallbackUsed: false, primarySourceName: sourceName, status: 'FAILED', reasonCode,
  };
}

function failedSeries(sourceName: string, fetchedAt: string, reasonCode: ProviderReasonCode, symbol = ''): SeriesResult {
  return {
    points: [], sourceTimestamp: null, fetchedAt, marketState: 'UNKNOWN', isDelayed: false,
    sourceName, sourceSymbol: symbol, sourceLabel: sourceLabel(symbol),
    fallbackUsed: false, primarySourceName: sourceName, status: 'FAILED', reasonCode,
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
    marketState: knownYahooMarketState(meta.marketState),
    isDelayed: typeof meta.exchangeDataDelayedBy === 'number' && meta.exchangeDataDelayedBy > 0,
    sourceName: 'Yahoo Finance',
  };
}

export function parseStooqCsv(csv: string, fetchedAt: string): ParsedQuote | null {
  const lines = csv.trim().split(/\r?\n/);
  if (lines.length < 2) return null;
  const cols = lines[lines.length - 1].split(',');
  const value = Number(cols[6]);
  if (!validCalendarDate(cols[1]) || !validClockTime(cols[2])) return null;
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

function invalidStooqResponse(response: Response, body: string): boolean {
  const contentType = (response.headers.get('content-type') ?? '').toLowerCase();
  const sample = body.trimStart().slice(0, 256).toLowerCase();
  return contentType.includes('text/html')
    || contentType.includes('javascript')
    || sample.startsWith('<!doctype html')
    || sample.startsWith('<html')
    || sample.includes('<script')
    || sample.includes('_cf_chl_');
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
  return out.sort((a, b) => a.date.localeCompare(b.date));
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
  let latest: number | null = null;
  for (let index = 0; index < Math.min(timestamps.length, closes.length); index++) {
    if (typeof timestamps[index] !== 'number' || typeof closes[index] !== 'number' || !Number.isFinite(closes[index])) continue;
    const date = new Date(timestamps[index] * 1000);
    if (Number.isFinite(date.getTime()) && (latest == null || date.getTime() > latest)) latest = date.getTime();
  }
  return latest == null ? null : new Date(latest).toISOString();
}

export class YahooMarketDataProvider implements MarketDataProvider {
  readonly name = 'Yahoo Finance';
  constructor(
    private readonly fetchFn: Fetcher = fetch,
    private readonly retryOptions: HttpRetryOptions = {},
  ) {}

  async fetchQuote({ symbol, fetchedAt }: QuoteRequest): Promise<QuoteResult> {
    try {
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=5d`;
      const response = await fetchWithRetry(
        this.fetchFn, url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, this.retryOptions,
      );
      if (!response.ok) {
        await releaseResponseBody(response);
        return failedQuote(this.name, fetchedAt, 'HTTP_ERROR', symbol);
      }
      const parsed = parseYahooQuote(await response.json(), fetchedAt);
      if (!parsed) return failedQuote(this.name, fetchedAt, 'INVALID_TIMESTAMP', symbol);
      if (isFutureTimestamp(parsed.sourceTimestamp, fetchedAt)) {
        return failedQuote(this.name, fetchedAt, 'FUTURE_TIMESTAMP', symbol);
      }
      return {
        ...parsed, sourceSymbol: symbol, sourceLabel: sourceLabel(symbol),
        fallbackUsed: false, primarySourceName: this.name,
        status: qualityStatus(parsed.sourceTimestamp, fetchedAt, MARKET_DATA_QUALITY.quoteMaxAgeBusinessDays),
      };
    } catch (error) {
      return failedQuote(this.name, fetchedAt, errorReason(error), symbol);
    }
  }

  async fetchHistory({ symbol, fetchedAt, range = '1mo' }: HistoryRequest): Promise<SeriesResult> {
    try {
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=${range}`;
      const response = await fetchWithRetry(
        this.fetchFn, url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, this.retryOptions,
      );
      if (!response.ok) {
        await releaseResponseBody(response);
        return failedSeries(this.name, fetchedAt, 'HTTP_ERROR', symbol);
      }
      const json: any = await response.json();
      const points = parseYahooDailyObs(json);
      const sourceTimestamp = yahooSourceTimestamp(json);
      if (!sourceTimestamp || points.length === 0) return failedSeries(this.name, fetchedAt, 'INVALID_TIMESTAMP', symbol);
      if (isFutureTimestamp(sourceTimestamp, fetchedAt)) {
        return failedSeries(this.name, fetchedAt, 'FUTURE_TIMESTAMP', symbol);
      }
      const meta = json?.chart?.result?.[0]?.meta;
      return {
        points, sourceTimestamp, fetchedAt,
        marketState: knownYahooMarketState(meta?.marketState),
        isDelayed: typeof meta?.exchangeDataDelayedBy === 'number' && meta.exchangeDataDelayedBy > 0,
        sourceName: this.name, sourceSymbol: symbol, sourceLabel: sourceLabel(symbol),
        fallbackUsed: false, primarySourceName: this.name,
        status: qualityStatus(sourceTimestamp, fetchedAt, MARKET_DATA_QUALITY.historyMaxAgeBusinessDays),
      };
    } catch (error) {
      return failedSeries(this.name, fetchedAt, errorReason(error), symbol);
    }
  }
}

export class StooqMarketDataProvider implements MarketDataProvider {
  readonly name = 'Stooq';
  constructor(
    private readonly fetchFn: Fetcher = fetch,
    private readonly retryOptions: HttpRetryOptions = {},
  ) {}

  async fetchQuote({ symbol, fetchedAt }: QuoteRequest): Promise<QuoteResult> {
    try {
      const url = `https://stooq.com/q/l/?s=${encodeURIComponent(symbol)}&f=sd2t2ohlcv&h&e=csv`;
      const response = await fetchWithRetry(this.fetchFn, url, undefined, this.retryOptions);
      if (!response.ok) {
        await releaseResponseBody(response);
        return failedQuote(this.name, fetchedAt, 'HTTP_ERROR', symbol);
      }
      const body = await response.text();
      if (invalidStooqResponse(response, body)) return failedQuote(this.name, fetchedAt, 'INVALID_RESPONSE', symbol);
      const parsed = parseStooqCsv(body, fetchedAt);
      if (!parsed) return failedQuote(this.name, fetchedAt, 'INVALID_TIMESTAMP', symbol);
      if (isFutureTimestamp(parsed.sourceTimestamp, fetchedAt)) {
        return failedQuote(this.name, fetchedAt, 'FUTURE_TIMESTAMP', symbol);
      }
      return {
        ...parsed, sourceSymbol: symbol, sourceLabel: sourceLabel(symbol),
        fallbackUsed: false, primarySourceName: this.name,
        status: qualityStatus(parsed.sourceTimestamp, fetchedAt, MARKET_DATA_QUALITY.quoteMaxAgeBusinessDays),
      };
    } catch (error) {
      return failedQuote(this.name, fetchedAt, errorReason(error), symbol);
    }
  }

  async fetchHistory({ symbol, fetchedAt }: HistoryRequest): Promise<SeriesResult> {
    try {
      const start = new Date(Date.parse(fetchedAt) - 45 * 86400000).toISOString().slice(0, 10).replaceAll('-', '');
      const url = `https://stooq.com/q/d/l/?s=${encodeURIComponent(symbol)}&i=d&d1=${start}`;
      const response = await fetchWithRetry(this.fetchFn, url, undefined, this.retryOptions);
      if (!response.ok) {
        await releaseResponseBody(response);
        return failedSeries(this.name, fetchedAt, 'HTTP_ERROR', symbol);
      }
      const body = await response.text();
      if (invalidStooqResponse(response, body)) return failedSeries(this.name, fetchedAt, 'INVALID_RESPONSE', symbol);
      const parsed = parseStooqHistory(body);
      if (parsed.invalidTimestamp) return failedSeries(this.name, fetchedAt, 'INVALID_TIMESTAMP', symbol);
      const points = parsed.points;
      const last = points.at(-1);
      if (!last) return failedSeries(this.name, fetchedAt, 'NO_DATA', symbol);
      const sourceTimestamp = `${last.date}T00:00:00.000Z`;
      if (isFutureTimestamp(sourceTimestamp, fetchedAt)) {
        return failedSeries(this.name, fetchedAt, 'FUTURE_TIMESTAMP', symbol);
      }
      return {
        points, sourceTimestamp, fetchedAt, marketState: 'UNKNOWN', isDelayed: true,
        sourceName: this.name, sourceSymbol: symbol, sourceLabel: sourceLabel(symbol),
        fallbackUsed: false, primarySourceName: this.name,
        status: qualityStatus(sourceTimestamp, fetchedAt, MARKET_DATA_QUALITY.historyMaxAgeBusinessDays),
      };
    } catch (error) {
      return failedSeries(this.name, fetchedAt, errorReason(error), symbol);
    }
  }
}

export class FredMarketDataProvider implements MarketDataProvider {
  readonly name = 'FRED';
  constructor(
    private readonly apiKey: string,
    private readonly fetchFn: Fetcher = fetch,
    private readonly retryOptions: HttpRetryOptions = {},
  ) {}

  private async observations(symbol: string, fetchedAt: string): Promise<SeriesResult> {
    if (!this.apiKey) return failedSeries(this.name, fetchedAt, 'HTTP_ERROR', symbol);
    try {
      const url = new URL('https://api.stlouisfed.org/fred/series/observations');
      url.searchParams.set('series_id', symbol);
      url.searchParams.set('api_key', this.apiKey);
      url.searchParams.set('file_type', 'json');
      url.searchParams.set('observation_start', new Date(Date.parse(fetchedAt) - 45 * 86400000).toISOString().slice(0, 10));
      const response = await fetchWithRetry(this.fetchFn, url.toString(), undefined, this.retryOptions);
      if (!response.ok) {
        await releaseResponseBody(response);
        return failedSeries(this.name, fetchedAt, 'HTTP_ERROR', symbol);
      }
      const json: any = await response.json();
      const observations: any[] = Array.isArray(json?.observations) ? json.observations : [];
      const numericObservations = observations.filter((observation: any) => {
        const value = observation?.value;
        return value !== null && value !== undefined && value !== '' && value !== '.'
          && Number.isFinite(Number(value));
      });
      if (numericObservations.some((observation: any) => !validCalendarDate(observation?.date))) {
        return failedSeries(this.name, fetchedAt, 'INVALID_TIMESTAMP', symbol);
      }
      const points: ObsPoint[] = numericObservations
        .map((o: any) => ({ date: o.date, value: Number(o.value) }))
        .sort((a: ObsPoint, b: ObsPoint) => a.date.localeCompare(b.date));
      const last = points.at(-1);
      if (!last) return failedSeries(this.name, fetchedAt, 'NO_DATA', symbol);
      const sourceTimestamp = `${last.date}T00:00:00.000Z`;
      if (isFutureTimestamp(sourceTimestamp, fetchedAt)) {
        return failedSeries(this.name, fetchedAt, 'FUTURE_TIMESTAMP', symbol);
      }
      const maxAge = symbol === 'DTWEXBGS'
        ? MARKET_DATA_QUALITY.fredMaxAgeBusinessDays.DTWEXBGS
        : MARKET_DATA_QUALITY.historyMaxAgeBusinessDays;
      return {
        points, sourceTimestamp, fetchedAt, marketState: 'OFFICIAL', isDelayed: true,
        sourceName: this.name, sourceSymbol: symbol, sourceLabel: sourceLabel(symbol),
        fallbackUsed: false, primarySourceName: this.name,
        status: qualityStatus(sourceTimestamp, fetchedAt, maxAge),
      };
    } catch (error) {
      return failedSeries(this.name, fetchedAt, errorReason(error), symbol);
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
      sourceSymbol: history.sourceSymbol,
      sourceLabel: history.sourceLabel,
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

function quoteLevelsComparable(a: QuoteResult, b: QuoteResult): boolean {
  return a.sourceSymbol !== 'DTWEXBGS' && b.sourceSymbol !== 'DTWEXBGS';
}

function resolveQuote(candidates: QuoteResult[], tolerance: number): QuoteResult {
  const selectedIndex = candidates.findIndex(candidate => candidate.status === 'OK');
  if (selectedIndex >= 0) {
    const selected = candidates[selectedIndex];
    const disagreement = candidates.find((candidate, index) => index !== selectedIndex
      && candidate.status === 'OK'
      && selected.value != null && candidate.value != null
      && quoteLevelsComparable(selected, candidate)
      && selected.sourceTimestamp?.slice(0, 10) === candidate.sourceTimestamp?.slice(0, 10)
      && relativeDifference(selected.value, candidate.value) > tolerance);
    if (disagreement) {
      return {
        ...selected, status: 'DIVERGENT', reasonCode: 'SOURCE_DIVERGENCE',
        comparisonSourceName: disagreement.sourceName,
      };
    }
    return selectedIndex === 0 ? selected : {
      ...selected, fallbackUsed: true, primarySourceName: candidates[0].sourceName,
    };
  }
  const staleIndex = candidates.findIndex(candidate => candidate.status === 'STALE');
  if (staleIndex >= 0) {
    const stale = candidates[staleIndex];
    return staleIndex === 0 ? stale : { ...stale, fallbackUsed: true, primarySourceName: candidates[0].sourceName };
  }
  return candidates[0];
}

function sharedWindow(primary: ObsPoint[], secondary: ObsPoint[]): [ObsPoint[], ObsPoint[]] | null {
  const secondaryByDate = new Map(secondary.map(point => [point.date, point]));
  const primaryShared = primary.filter(point => secondaryByDate.has(point.date));
  if (primaryShared.length < 1) return null;
  return [primaryShared, primaryShared.map(point => secondaryByDate.get(point.date)!)];
}

function historyStressClassification(symbol: MarketSymbol, points: ObsPoint[]): boolean | null {
  if (symbol === 'vix') return points.length ? points.at(-1)!.value > STRESS.vix : null;
  if (points.length < 6) return null;
  const window = points.slice(-6);
  const first = window[0].value, last = window.at(-1)!.value;
  if (symbol === 'us10y') return last - first > STRESS.y10;
  if (first === 0) return null;
  const change = last / first - 1;
  return symbol === 'spx' ? change < STRESS.spxDd : change > STRESS.dxy;
}

function historySemanticMetric(symbol: MarketSymbol, points: ObsPoint[]): number | null {
  if (symbol === 'vix') return points.length ? points.at(-1)!.value : null;
  if (points.length < 6) return null;
  const window = points.slice(-6);
  const first = window[0].value, last = window.at(-1)!.value;
  if (symbol === 'us10y') return last - first;
  return first === 0 ? null : last / first - 1;
}

function historySemanticsDisagree(symbol: MarketSymbol, a: SeriesResult, b: SeriesResult): boolean {
  const shared = sharedWindow(a.points, b.points);
  if (!shared) return false;
  const aClass = historyStressClassification(symbol, shared[0]);
  const bClass = historyStressClassification(symbol, shared[1]);
  if (aClass != null && bClass != null && aClass !== bClass) return true;
  const aMetric = historySemanticMetric(symbol, shared[0]);
  const bMetric = historySemanticMetric(symbol, shared[1]);
  if (aMetric == null || bMetric == null) return false;
  const tolerance = MARKET_DATA_QUALITY.historyReturnTolerance[symbol];
  return symbol === 'vix'
    ? relativeDifference(aMetric, bMetric) > tolerance
    : Math.abs(aMetric - bMetric) > tolerance;
}

function resolveHistory(symbol: MarketSymbol, candidates: SeriesResult[]): SeriesResult {
  const selectedIndex = candidates.findIndex(candidate => candidate.status === 'OK');
  if (selectedIndex >= 0) {
    const selected = candidates[selectedIndex];
    const disagreement = candidates.find((candidate, index) => index !== selectedIndex
      && candidate.status === 'OK' && historySemanticsDisagree(symbol, selected, candidate));
    if (disagreement) {
      return {
        ...selected, status: 'DIVERGENT', reasonCode: 'SOURCE_DIVERGENCE',
        comparisonSourceName: disagreement.sourceName,
      };
    }
    return selectedIndex === 0 ? selected : {
      ...selected, fallbackUsed: true, primarySourceName: candidates[0].sourceName,
    };
  }
  const staleIndex = candidates.findIndex(candidate => candidate.status === 'STALE');
  if (staleIndex >= 0) {
    const stale = candidates[staleIndex];
    return staleIndex === 0 ? stale : { ...stale, fallbackUsed: true, primarySourceName: candidates[0].sourceName };
  }
  return candidates[0];
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

export async function fetchLivePrices(nowIso: string, options: Omit<ProviderFetchOptions, 'fetchedAt'> = {}): Promise<LivePrices> {
  const fetchFn = options.fetchFn ?? fetch;
  const retryOptions = providerRetryOptions(options);
  const yahoo = new YahooMarketDataProvider(fetchFn, retryOptions);
  const stooq = new StooqMarketDataProvider(fetchFn, retryOptions);
  const fred = new FredMarketDataProvider(options.fredApiKey ?? '', fetchFn, retryOptions);
  const quoteCandidates = await Promise.all([
    Promise.all([
      yahoo.fetchQuote({ symbol: '^GSPC', fetchedAt: nowIso }),
      stooq.fetchQuote({ symbol: '^spx', fetchedAt: nowIso }),
      fred.fetchQuote({ symbol: 'SP500', fetchedAt: nowIso }),
    ]),
    Promise.all([
      yahoo.fetchQuote({ symbol: '^VIX', fetchedAt: nowIso }),
      stooq.fetchQuote({ symbol: '^vix', fetchedAt: nowIso }),
      fred.fetchQuote({ symbol: 'VIXCLS', fetchedAt: nowIso }),
    ]),
    Promise.all([
      yahoo.fetchQuote({ symbol: 'DX-Y.NYB', fetchedAt: nowIso }),
      stooq.fetchQuote({ symbol: 'dx.f', fetchedAt: nowIso }),
      fred.fetchQuote({ symbol: 'DTWEXBGS', fetchedAt: nowIso }),
    ]),
    Promise.all([
      yahoo.fetchQuote({ symbol: '^TNX', fetchedAt: nowIso }),
      stooq.fetchQuote({ symbol: '10usy.b', fetchedAt: nowIso }),
      fred.fetchQuote({ symbol: 'DGS10', fetchedAt: nowIso }),
    ]),
  ]);
  const quotes: Record<MarketSymbol, QuoteResult> = {
    spx: resolveQuote(quoteCandidates[0], MARKET_DATA_QUALITY.quoteRelativeTolerance.spx),
    vix: resolveQuote(quoteCandidates[1], MARKET_DATA_QUALITY.quoteRelativeTolerance.vix),
    dxy: resolveQuote(quoteCandidates[2], MARKET_DATA_QUALITY.quoteRelativeTolerance.dxy),
    us10y: resolveQuote([
      scaleQuote(quoteCandidates[3][0], normalizeTnx),
      quoteCandidates[3][1],
      quoteCandidates[3][2],
    ], MARKET_DATA_QUALITY.quoteRelativeTolerance.us10y),
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

async function fetchMarketHistories(options: ProviderFetchOptions = {}): Promise<Record<MarketSymbol, SeriesResult>> {
  const fetchedAt = options.fetchedAt ?? new Date().toISOString();
  const fetchFn = options.fetchFn ?? fetch;
  const retryOptions = providerRetryOptions(options);
  const yahoo = new YahooMarketDataProvider(fetchFn, retryOptions);
  const stooq = new StooqMarketDataProvider(fetchFn, retryOptions);
  const fred = new FredMarketDataProvider(options.fredApiKey ?? '', fetchFn, retryOptions);
  const candidates = await Promise.all([
    Promise.all([
      yahoo.fetchHistory({ symbol: '^GSPC', fetchedAt }),
      stooq.fetchHistory({ symbol: '^spx', fetchedAt }),
      fred.fetchHistory({ symbol: 'SP500', fetchedAt }),
    ]),
    Promise.all([
      yahoo.fetchHistory({ symbol: '^VIX', fetchedAt }),
      stooq.fetchHistory({ symbol: '^vix', fetchedAt }),
      fred.fetchHistory({ symbol: 'VIXCLS', fetchedAt }),
    ]),
    Promise.all([
      yahoo.fetchHistory({ symbol: 'DX-Y.NYB', fetchedAt }),
      stooq.fetchHistory({ symbol: 'dx.f', fetchedAt }),
      fred.fetchHistory({ symbol: 'DTWEXBGS', fetchedAt }),
    ]),
    Promise.all([
      yahoo.fetchHistory({ symbol: '^TNX', fetchedAt }),
      stooq.fetchHistory({ symbol: '10usy.b', fetchedAt }),
      fred.fetchHistory({ symbol: 'DGS10', fetchedAt }),
    ]),
  ]);
  return {
    spx: resolveHistory('spx', candidates[0]),
    vix: resolveHistory('vix', candidates[1]),
    dxy: resolveHistory('dxy', candidates[2]),
    us10y: resolveHistory('us10y', [
      scaleHistory(candidates[3][0], normalizeTnx), candidates[3][1], candidates[3][2],
    ]),
  };
}

export async function fetchStressSeries(options: ProviderFetchOptions = {}): Promise<StressSeries> {
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

export async function fetchDxyDaily(options: ProviderFetchOptions = {}): Promise<ObsPoint[]> {
  const fetchedAt = options.fetchedAt ?? new Date().toISOString();
  const fetchFn = options.fetchFn ?? fetch;
  const retryOptions = providerRetryOptions(options);
  const yahoo = new YahooMarketDataProvider(fetchFn, retryOptions);
  const stooq = new StooqMarketDataProvider(fetchFn, retryOptions);
  const fred = new FredMarketDataProvider(options.fredApiKey ?? '', fetchFn, retryOptions);
  const candidates = await Promise.all([
    yahoo.fetchHistory({ symbol: 'DX-Y.NYB', fetchedAt }),
    stooq.fetchHistory({ symbol: 'dx.f', fetchedAt }),
    fred.fetchHistory({ symbol: 'DTWEXBGS', fetchedAt }),
  ]);
  const result = resolveHistory('dxy', candidates);
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
