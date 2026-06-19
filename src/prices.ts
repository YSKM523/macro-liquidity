export interface LivePrices { spx: number|null; vix: number|null; dxy: number|null; us10y: number|null; asof: string }
export interface StressSeries { spx: number[]; vix: number[]; us10y: number[]; dxy: number[]; }
export interface LiveStress {
  stressed: boolean;
  reasons: string[];
  signals: { vix: number|null; spx5d: number|null; us10y5d: number|null; dxy5d: number|null };
}

export function normalizeTnx(raw: number): number {
  return raw > 20 ? raw / 10 : raw; // ^TNX sometimes ×10
}

export function parseYahooQuote(json: any): number | null {
  const p = json?.chart?.result?.[0]?.meta?.regularMarketPrice;
  return typeof p === 'number' ? p : null;
}

export function parseStooqCsv(csv: string): number | null {
  const lines = csv.trim().split('\n');
  if (lines.length < 2) return null;
  const cols = lines[1].split(',');
  const close = Number(cols[6]);
  return Number.isFinite(close) ? close : null;
}

async function yahoo(symbol: string): Promise<number | null> {
  try {
    const u = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=5d`;
    const r = await fetch(u, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!r.ok) return null;
    return parseYahooQuote(await r.json());
  } catch { return null; }
}

async function stooq(symbol: string): Promise<number | null> {
  try {
    const u = `https://stooq.com/q/l/?s=${encodeURIComponent(symbol)}&f=sd2t2ohlcv&h&e=csv`;
    const r = await fetch(u);
    if (!r.ok) return null;
    return parseStooqCsv(await r.text());
  } catch { return null; }
}

export async function fetchLivePrices(nowIso: string): Promise<LivePrices> {
  const [spx, vix, dxy, tnx] = await Promise.all([
    yahoo('^GSPC').then(v => v ?? stooq('^spx')),
    yahoo('^VIX').then(v => v ?? stooq('^vix')),
    yahoo('DX-Y.NYB'),
    yahoo('^TNX'),
  ]);
  return { spx, vix, dxy, us10y: tnx == null ? null : normalizeTnx(tnx), asof: nowIso };
}

// ── Stress series: daily closes for near-5-day momentum ──────────────────────

export function parseYahooCloses(json: any): number[] {
  const c = json?.chart?.result?.[0]?.indicators?.quote?.[0]?.close;
  return Array.isArray(c)
    ? c.filter((x: any) => typeof x === 'number' && Number.isFinite(x))
    : [];
}

async function recentCloses(symbol: string): Promise<number[]> {
  try {
    const u = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=1mo`;
    const r = await fetch(u, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!r.ok) return [];
    return parseYahooCloses(await r.json());
  } catch { return []; }
}

export async function fetchStressSeries(): Promise<StressSeries> {
  const [spx, vix, dxy, tnx] = await Promise.all([
    recentCloses('^GSPC'),
    recentCloses('^VIX'),
    recentCloses('DX-Y.NYB'),
    recentCloses('^TNX'),
  ]);
  return { spx, vix, dxy, us10y: tnx.map(normalizeTnx) };
}

import { STRESS } from './config';

export function evaluateLiveStress(s: StressSeries, t = STRESS): LiveStress {
  const last = (a: number[]) => a.length ? a[a.length - 1] : null;
  const ago5 = (a: number[]) => a.length >= 6 ? a[a.length - 6] : (a.length ? a[0] : null);

  const vix = last(s.vix);
  const spx_c = last(s.spx), spx_a = ago5(s.spx);
  const spx5d = (spx_c != null && spx_a != null && spx_a !== 0) ? spx_c / spx_a - 1 : null;
  const y_c = last(s.us10y), y_a = ago5(s.us10y);
  const us10y5d = (y_c != null && y_a != null) ? y_c - y_a : null;
  const d_c = last(s.dxy), d_a = ago5(s.dxy);
  const dxy5d = (d_c != null && d_a != null && d_a !== 0) ? d_c / d_a - 1 : null;

  const reasons: string[] = [];
  if (vix != null && vix > t.vix) reasons.push(`VIX ${vix.toFixed(1)} > ${t.vix}`);
  if (spx5d != null && spx5d < t.spxDd) reasons.push(`SPX 5日 ${(spx5d * 100).toFixed(1)}%`);
  if (us10y5d != null && us10y5d > t.y10) reasons.push(`10Y 5日 +${us10y5d.toFixed(2)}pp`);
  if (dxy5d != null && dxy5d > t.dxy) reasons.push(`美元 5日 +${(dxy5d * 100).toFixed(1)}%`);

  return { stressed: reasons.length > 0, reasons, signals: { vix, spx5d, us10y5d, dxy5d } };
}
