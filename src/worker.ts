import type { Env } from './service';
import { runIngest } from './service';
import { latestSnapshot, snapshotHistory } from './db';
import { fetchLivePrices } from './prices';
import { policyRegime } from './metrics';

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const p = url.pathname;

    if (p === '/api/snapshot') {
      const row: any = await latestSnapshot(env.DB);
      const snap = row ? { ...row, policy_regime: policyRegime(row.qe_qt_regime, row.date) } : null;
      const live = await fetchLivePrices(new Date().toISOString());
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
    ctx.waitUntil(runIngest(env, false).then(() => undefined));
  },
};
