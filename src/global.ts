import type { SeriesMap } from './metrics';
import { asOf } from './metrics';

export interface GlPoint { date: string; gl: number }
export interface GlLatest {
  date: string; gl: number; fed: number; ecb: number; boj: number;
  fedPct: number; ecbPct: number; bojPct: number;
  trend13wPct: number | null; dir: 'UP' | 'DOWN' | 'FLAT';
}

// FX-adjusted components (billions USD) as of `date`.
// Returns null if ANY component is missing — never fabricates a value.
function components(m: SeriesMap, date: string): { fed: number; ecb: number; boj: number } | null {
  const walcl  = asOf(m.WALCL ?? [], date);       // already billions USD
  const ecbA   = asOf(m.ECBASSETSW ?? [], date);  // millions EUR
  const eurusd = asOf(m.DEXUSEU ?? [], date);     // USD per EUR
  const bojA   = asOf(m.JPNASSETS ?? [], date);   // 億円
  const jpyusd = asOf(m.DEXJPUS ?? [], date);     // JPY per USD
  if (walcl == null || ecbA == null || eurusd == null || bojA == null || jpyusd == null || jpyusd === 0) {
    return null;
  }
  const fed = walcl;
  const ecb = (ecbA * eurusd) / 1000;
  const boj = (bojA * 100) / jpyusd / 1000;
  return { fed, ecb, boj };
}

// GL series aligned to WALCL weekly dates; points with any missing component are skipped.
export function globalLiquiditySeries(m: SeriesMap, upTo: string): GlPoint[] {
  const out: GlPoint[] = [];
  for (const w of (m.WALCL ?? [])) {
    if (w.date > upTo) break;
    const c = components(m, w.date);
    if (c == null) continue;
    out.push({ date: w.date, gl: c.fed + c.ecb + c.boj });
  }
  return out;
}

// Latest GL point + composition + 13-week total-GL % change. null if not computable.
export function globalLiquidityLatest(m: SeriesMap, date: string): GlLatest | null {
  const c = components(m, date);
  if (c == null) return null;
  const gl = c.fed + c.ecb + c.boj;
  if (!(gl > 0)) return null;

  const series = globalLiquiditySeries(m, date);
  const past = new Date(date + 'T00:00:00Z');
  past.setUTCDate(past.getUTCDate() - 91); // ~13 weeks
  const pastDate = past.toISOString().slice(0, 10);
  let glPast: number | null = null;
  for (const p of series) { if (p.date <= pastDate) glPast = p.gl; else break; }
  const trend13wPct = (glPast != null && glPast > 0) ? ((gl - glPast) / glPast) * 100 : null;
  const dir: GlLatest['dir'] =
    trend13wPct == null ? 'FLAT' : trend13wPct > 0.5 ? 'UP' : trend13wPct < -0.5 ? 'DOWN' : 'FLAT';

  return {
    date, gl, fed: c.fed, ecb: c.ecb, boj: c.boj,
    fedPct: c.fed / gl, ecbPct: c.ecb / gl, bojPct: c.boj / gl,
    trend13wPct, dir,
  };
}
