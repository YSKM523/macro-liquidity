import type { Env } from './service';
import { runIngest, scheduledIngest } from './service';
import { latestSnapshot, snapshotHistory, loadBacktestRows, getAllMeta, countSnapshots, snapshotOnOrBefore, loadSeriesMap } from './db';
import { factorContributions, attributeScoreChange, decomposeNetliq } from './explain';
import { fetchLivePrices, fetchStressSeries, evaluateLiveStress } from './prices';
import { policyRegime, deriveDecisionState } from './metrics';
import { INGEST_STALE_HOURS, COVERAGE_FACTORS } from './config';
import { assessHealth } from './health';
import { runBacktest } from './backtest';
import { runWalkForward } from './walkforward';
import { runRobustness } from './robustness';
import { globalLiquiditySeries, globalLiquidityLatest } from './global';

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

const faviconSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#F6F8FA"/><path d="M14 43h36" stroke="#1A1F36" stroke-width="4" stroke-linecap="round"/><path d="M16 39c7-14 15-20 24-20 5 0 9 2 12 5" fill="none" stroke="#635BFF" stroke-width="5" stroke-linecap="round"/><path d="M37 20l12 1-5 11" fill="none" stroke="#1A7F4B" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    try {
    const url = new URL(req.url);
    const p = url.pathname;

    if (p === '/favicon.ico' || p === '/favicon.svg') {
      return new Response(faviconSvg, {
        headers: {
          'content-type': 'image/svg+xml; charset=utf-8',
          'cache-control': 'public, max-age=31536000, immutable',
        },
      });
    }

    if (p === '/api/health' || p === '/health') {
      try {
        const [row, meta, count] = await Promise.all([
          latestSnapshot(env.DB),
          getAllMeta(env.DB),
          countSnapshots(env.DB),
        ]);
        const h = assessHealth({
          dataDate: (row as any)?.date ?? null,
          snapshots: count,
          coverage: (row as any)?.coverage ?? null,
          lastIngestAt: meta.last_ingest_at ?? null,
          lastStatus: meta.last_status ?? null,
          lastError: meta.last_error ?? null,
          now: new Date().toISOString(),
          staleHours: INGEST_STALE_HOURS,
        });
        return json(h, h.ok ? 200 : 503);
      } catch (e) {
        return json({ ok: false, stale: true, error: 'db_unreachable', message: String((e as any)?.message ?? e) }, 503);
      }
    }
    if (p === '/api/snapshot') {
      const [row, live, stress, meta] = await Promise.all([
        latestSnapshot(env.DB),
        fetchLivePrices(new Date().toISOString()),
        fetchStressSeries().then(s => evaluateLiveStress(s)),
        getAllMeta(env.DB),
      ]);
      const ingest = {
        ingest_at: meta.last_ingest_at ?? null,
        last_attempt_at: meta.last_attempt_at ?? null,
        ingest_age_hours: meta.last_ingest_at
          ? (Date.now() - Date.parse(meta.last_ingest_at)) / 3600000
          : null,
        ingest_status: meta.last_status ?? null,
      };
      if (!row) return json({ snapshot: null, live, ingest, error: 'no_data' });
      const r: any = row;
      const decision = deriveDecisionState({
        score: r.score,
        previousVerdict: r.verdict,
        netliqDir: r.netliq_dir,
        qeQtRegime: r.qe_qt_regime,
        stressed: stress.stressed,
      });
      const snap = {
        ...r,
        policy_regime: policyRegime(r.qe_qt_regime, r.date),
        reason: decision.reason,
        display_verdict: decision.displayVerdict,
        live_stress: stress,
        guidance: decision.guidance,
        coverage_total: COVERAGE_FACTORS.length,
      };
      return json({ snapshot: snap, live, ingest });
    }
    if (p === '/api/explain') {
      const wparam = url.searchParams.get('window');
      const window = (wparam === '1m' || wparam === '3m') ? wparam : '1w';
      const days = window === '3m' ? 91 : window === '1m' ? 30 : 7;

      const cur: any = await latestSnapshot(env.DB);
      if (!cur) return json({ window, error: 'no_data' });

      const refDate = new Date(new Date(cur.date + 'T00:00:00Z').getTime() - days * 86400000)
        .toISOString().slice(0, 10);
      const refRow: any = await snapshotOnOrBefore(env.DB, refDate);
      const reference = (refRow && refRow.date !== cur.date) ? refRow : null;

      const curFactors = JSON.parse(cur.factors_json ?? '{}');
      const contributions = factorContributions(curFactors);
      const attribution = reference
        ? attributeScoreChange(curFactors, JSON.parse(reference.factors_json ?? '{}'))
        : null;
      const netliq = decomposeNetliq(
        { walcl: cur.walcl, tga: cur.tga, rrp: cur.rrp },
        reference ? { walcl: reference.walcl, tga: reference.tga, rrp: reference.rrp } : null,
      );

      return json({
        window,
        current: { date: cur.date, score: cur.score, netliq: cur.netliq, walcl: cur.walcl, tga: cur.tga, rrp: cur.rrp },
        reference: reference
          ? { date: reference.date, score: reference.score, netliq: reference.netliq, walcl: reference.walcl, tga: reference.tga, rrp: reference.rrp }
          : null,
        deltaScore: reference ? cur.score - reference.score : null,
        contributions,
        attribution,
        netliq,
      });
    }
    if (p === '/api/history') {
      const to = url.searchParams.get('to') ?? '2100-01-01';
      const from = url.searchParams.get('from') ?? '1900-01-01';
      return json({ rows: await snapshotHistory(env.DB, from, to) });
    }
    if (p === '/api/prices') {
      return json(await fetchLivePrices(new Date().toISOString()));
    }
    if (p === '/api/backtest') {
      const rows = await loadBacktestRows(env.DB);
      const snaps = rows
        .filter((r: any) => r.spx != null && r.score != null && r.factors_json)
        .map((r: any) => ({ date: r.date, score: r.score, spx: r.spx, factors: JSON.parse(r.factors_json) }));
      return json(runBacktest(snaps));
    }
    if (p === '/api/walkforward') {
      const rows = await loadBacktestRows(env.DB);
      const snaps = rows
        .filter((r: any) => r.spx != null && r.score != null && r.factors_json)
        .map((r: any) => ({ date: r.date, score: r.score, spx: r.spx, factors: JSON.parse(r.factors_json) }));
      return json(runWalkForward(snaps));
    }
    if (p === '/api/robustness') {
      const rows = await loadBacktestRows(env.DB);
      const snaps = rows
        .filter((r: any) => r.spx != null && r.score != null && r.factors_json)
        .map((r: any) => ({
          date: r.date, score: r.score, spx: r.spx, factors: JSON.parse(r.factors_json),
          regime: r.qe_qt_regime, vix: r.vix_eod,
        }));
      return json(runRobustness(snaps));
    }
    if (p === '/api/global-liquidity') {
      const m = await loadSeriesMap(env.DB);
      const date = (m.WALCL ?? []).at(-1)?.date;
      const latest = date ? globalLiquidityLatest(m, date) : null;
      const series = date ? globalLiquiditySeries(m, date) : [];
      if (!latest || series.length === 0) return json({ error: 'no_data' });
      return json({ latest, series, note: 'display-only · 不进打分 · 弱信号(IC≈0.08 不显著)' });
    }
    if (p === '/api/admin/refresh' && req.method === 'POST') {
      const auth = req.headers.get('authorization') ?? '';
      if (auth !== `Bearer ${env.ADMIN_TOKEN}`) return json({ error: 'unauthorized' }, 401);
      const rebuildAll = url.searchParams.get('all') === '1';
      return json(await runIngest(env, rebuildAll));
    }
    // not an API route → static assets
    return env.ASSETS.fetch(req);
    } catch (e) {
      return json({ error: 'internal', message: String((e as any)?.message ?? e) }, 500);
    }
  },

  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(scheduledIngest(event.cron, env).catch(() => undefined));
  },
};
