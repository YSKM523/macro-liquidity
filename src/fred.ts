import { UNIT_BY_ID } from './config';

export interface Obs { date: string; value: number }

export function parseFredJson(seriesId: string, json: any): Obs[] {
  const unit = UNIT_BY_ID[seriesId] ?? 'I';
  const rows: Obs[] = [];
  for (const o of (json?.observations ?? [])) {
    if (o.value === '.' || o.value == null || o.value === '') continue;
    let v = Number(o.value);
    if (!Number.isFinite(v)) continue;
    if (unit === 'M') v = v / 1000; // millions → billions
    rows.push({ date: o.date, value: v });
  }
  rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return rows;
}

export async function fetchFredSeries(seriesId: string, fromDate: string, apiKey: string): Promise<Obs[]> {
  const url = new URL('https://api.stlouisfed.org/fred/series/observations');
  url.searchParams.set('series_id', seriesId);
  url.searchParams.set('api_key', apiKey);
  url.searchParams.set('file_type', 'json');
  url.searchParams.set('observation_start', fromDate);
  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`FRED ${seriesId} ${res.status}`);
  return parseFredJson(seriesId, await res.json());
}
