/**
 * research-fetch.mjs — Phase R data acquisition (free public sources, no keys except FRED).
 * Returns ascending [{date, value}]. RAW values (callers handle units).
 *
 * Adaptation notes vs. brief:
 * - NY Fed ACM URL returns an Excel binary (XLS), not a CSV. The fallback to FRED THREEFYTP10
 *   is always taken. THREEFYTP10 is current as of 2026 (not discontinued).
 * - Treasury Fiscal Data API: verified JSON shape (data[], meta['total-pages']), field is
 *   tot_pub_debt_out_amt in USD. Current debt ~$39T (not $36T — US debt grew since brief was written).
 */

export async function fetchFred(id, start = '2002-01-01', key = process.env.FRED_API_KEY) {
  if (!key) throw new Error('FRED_API_KEY not set');
  const url = `https://api.stlouisfed.org/fred/series/observations`
    + `?series_id=${id}&api_key=${key}&file_type=json&observation_start=${start}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`FRED ${id} HTTP ${r.status}`);
  const j = await r.json();
  return (j.observations ?? [])
    .filter(o => o.value !== '.' && o.value != null && o.value !== '')
    .map(o => ({ date: o.date, value: Number(o.value) }))
    .filter(o => Number.isFinite(o.value))
    .sort((a, b) => (a.date < b.date ? -1 : 1));
}

// Treasury "Debt to the Penny" — daily total public debt outstanding (USD). 1993+. No key.
export async function fetchDebtToPenny(start = '2002-01-01') {
  const base = 'https://api.fiscaldata.treasury.gov/services/api/fiscal_service'
    + '/v2/accounting/od/debt_to_penny';
  const out = [];
  let page = 1;
  for (;;) {
    const url = `${base}?fields=record_date,tot_pub_debt_out_amt`
      + `&filter=record_date:gte:${start}&sort=record_date`
      + `&page[number]=${page}&page[size]=10000`;
    const r = await fetch(url);
    if (!r.ok) throw new Error(`Treasury HTTP ${r.status}`);
    const j = await r.json();
    for (const row of j.data ?? []) {
      const v = Number(row.tot_pub_debt_out_amt);
      if (Number.isFinite(v)) out.push({ date: row.record_date, value: v });
    }
    const totalPages = j.meta?.['total-pages'] ?? 1;
    if (page >= totalPages) break;
    page++;
  }
  out.sort((a, b) => (a.date < b.date ? -1 : 1));
  return out;
}

// Term premium — try NY Fed ACM CSV; fall back to FRED THREEFYTP10 (Kim-Wright, active as of 2026).
// NOTE: The NY Fed URL (ACMTermPremium.csv) returns a binary Excel file, not plain text CSV.
// The try block will fail on parse and fall through to the FRED fallback every time.
export async function fetchTermPremium() {
  const acmUrl = 'https://www.newyorkfed.org/medialibrary/media/research/data_indicators/ACMTermPremium.csv';
  try {
    const r = await fetch(acmUrl);
    if (r.ok) {
      const text = await r.text();
      const series = parseAcmCsv(text);
      if (series.length > 100) return { source: 'NYFed ACM ACMTP10', series };
    }
  } catch { /* fall through */ }
  // Fallback: FRED THREEFYTP10 (Kim-Wright 10-year term premium, in percentage points)
  const series = await fetchFred('THREEFYTP10');
  return { source: 'FRED THREEFYTP10 (Kim-Wright)', series };
}

// ACM CSV: header row contains a DATE column and ACMTP10 column. Dates may be MM/DD/YYYY.
// In practice the NY Fed serves XLS not CSV, so this is rarely invoked.
function parseAcmCsv(text) {
  const lines = text.trim().split(/\r?\n/);
  const header = lines[0].split(',').map(s => s.trim().toUpperCase());
  const di = header.findIndex(h => h === 'DATE');
  const ti = header.findIndex(h => h === 'ACMTP10');
  if (di < 0 || ti < 0) return [];
  const out = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',');
    const raw = (cols[di] ?? '').trim();
    const v = Number((cols[ti] ?? '').trim());
    if (!raw || !Number.isFinite(v)) continue;
    out.push({ date: normDate(raw), value: v });
  }
  return out.filter(o => o.date).sort((a, b) => (a.date < b.date ? -1 : 1));
}

// datahub Shiller mirror — monthly trailing S&P 500 EPS ("Earnings" column). 1871+.
export async function fetchShillerEarnings() {
  const url = 'https://raw.githubusercontent.com/datasets/s-and-p-500/master/data/data.csv';
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Shiller CSV HTTP ${r.status}`);
  const text = await r.text();
  const lines = text.trim().split(/\r?\n/);
  const header = lines[0].split(',').map(s => s.trim().toLowerCase());
  const di = header.findIndex(h => h === 'date');
  const ei = header.findIndex(h => h === 'earnings');
  if (di < 0 || ei < 0) throw new Error(`Shiller CSV: Date/Earnings columns not found. Header: ${header.join(',')}`);
  const out = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',');
    const v = Number((cols[ei] ?? '').trim());
    const date = normDate((cols[di] ?? '').trim());
    if (date && Number.isFinite(v) && v > 0) out.push({ date, value: v });
  }
  return out.sort((a, b) => (a.date < b.date ? -1 : 1));
}

// Normalize a date to YYYY-MM-DD. Accepts 'YYYY-MM-DD', 'YYYY-MM', 'M/D/YYYY'.
function normDate(s) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  if (/^\d{4}-\d{2}$/.test(s)) return `${s}-01`;
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  return '';
}
