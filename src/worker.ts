import type { Env } from './service';
import { runIngest } from './service';
import { latestSnapshot, snapshotHistory, loadBacktestRows } from './db';
import { fetchLivePrices, fetchStressSeries, evaluateLiveStress } from './prices';
import { policyRegime, downgradeVerdict, buildGuidance } from './metrics';
import { STRESS_SCORE_CEILING } from './config';
import { runBacktest } from './backtest';
import { runWalkForward } from './walkforward';

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const p = url.pathname;

    if (p === '/api/snapshot') {
      const row: any = await latestSnapshot(env.DB);
      const [live, stress] = await Promise.all([
        fetchLivePrices(new Date().toISOString()),
        fetchStressSeries().then(s => evaluateLiveStress(s)),
      ]);
      let snap: any = null;
      if (row) {
        const display_verdict = (stress.stressed && row.score < STRESS_SCORE_CEILING)
          ? downgradeVerdict(row.verdict)
          : row.verdict;
        const guidance = buildGuidance({
          score: row.score,
          verdict: row.verdict,
          netliqDir: row.netliq_dir,
          qeQtRegime: row.qe_qt_regime,
          stressed: stress.stressed,
        });
        snap = { ...row, policy_regime: policyRegime(row.qe_qt_regime, row.date), display_verdict, live_stress: stress, guidance };
      }
      return json({ snapshot: snap, live });
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
    if (p === '/api/admin/refresh' && req.method === 'POST') {
      const auth = req.headers.get('authorization') ?? '';
      if (auth !== `Bearer ${env.ADMIN_TOKEN}`) return json({ error: 'unauthorized' }, 401);
      const rebuildAll = url.searchParams.get('all') === '1';
      return json(await runIngest(env, rebuildAll));
    }
    // not an API route → static assets
    return env.ASSETS.fetch(req);
  },

  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runIngest(env, false).then(() => undefined).catch(() => undefined));
  },
};
