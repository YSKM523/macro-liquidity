export interface LivePrices { spx: number|null; vix: number|null; dxy: number|null; us10y: number|null; asof: string }

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
