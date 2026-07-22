import type { Env } from './service';
import { runIngest, scheduledIngest } from './service';
import {
  latestOfficialSnapshot,
  latestNowcastSnapshot,
  officialSnapshotHistory,
  loadBacktestRows,
  getAllMeta,
  countOfficialSnapshots,
  officialSnapshotOnOrBefore,
  loadSeriesMap,
  ingestRunSummary,
  loadEventBacktestInputs,
  exportOfficialSnapshots,
  recordAdminAudit,
  adminRateLimitAllowed,
} from './db';
import { factorContributions, attributeScoreChange, decomposeNetliq, sameScoringFactorAvailability } from './explain';
import { fetchLivePrices, fetchStressSeries, evaluateLiveStress } from './prices';
import { policyRegime, deriveDecisionState } from './metrics';
import { INGEST_STALE_HOURS, COVERAGE_FACTORS } from './config';
import { assessHealth } from './health';
import { runBacktest } from './backtest';
import { runEventTimeBacktest } from './event-backtest';
import { runWalkForward } from './walkforward';
import { runRobustness } from './robustness';
import { globalLiquiditySeries, globalLiquidityLatest } from './global';
import type { DecisionStatus } from './metrics';
import { assertSnapshotVersionMetadata, parseDateRange, snapshotsToCsv } from './api-schema';
import { presentModelDescriptor, resolveModelIdentity } from './model-version';
import {
  LiveDataCache,
  SLO_TARGETS,
  authenticateAdmin,
  fullRebuildConfirmed,
  structuredLog,
} from './operations';
import {
  TypedLiveDataFailure,
  assertCacheableLivePrices,
  assertCacheableStress,
  failClosedCachedStress,
} from './live-data';
import type { LivePrices, LiveStress } from './prices';

const livePricesCache = new LiveDataCache<any>({ freshMs: 30_000, staleMs: 120_000, failureThreshold: 3, openMs: 60_000 });
const liveStressCache = new LiveDataCache<any>({ freshMs: 30_000, staleMs: 120_000, failureThreshold: 3, openMs: 60_000 });

async function loadLive(env: Env) {
  const pricesPromise = livePricesCache
    .get(() => fetchLivePrices(new Date().toISOString(), { fredApiKey: env.FRED_API_KEY })
      .then(assertCacheableLivePrices))
    .catch(error => {
      if (error instanceof TypedLiveDataFailure) {
        return { value: error.payload as LivePrices, status: 'FAILED' as const, ageMs: 0 };
      }
      throw error;
    });
  const stressPromise = liveStressCache
    .get(() => fetchStressSeries({ fredApiKey: env.FRED_API_KEY })
      .then(evaluateLiveStress).then(assertCacheableStress))
    .catch(error => {
      if (error instanceof TypedLiveDataFailure) {
        return { value: error.payload as LiveStress, status: 'FAILED' as const, ageMs: 0 };
      }
      throw error;
    });
  const [prices, stress] = await Promise.all([pricesPromise, stressPromise]);
  return {
    live: prices.value,
    stress: failClosedCachedStress(stress.value, stress.status),
    cache: { prices: prices.status, stress: stress.status, prices_age_ms: prices.ageMs, stress_age_ms: stress.ageMs },
  };
}

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

function parseJsonObject(value: unknown): Record<string, unknown> {
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value);
    return parsed != null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function presentSnapshot(row: unknown, stress: ReturnType<typeof evaluateLiveStress>, channel: 'OFFICIAL' | 'PROVISIONAL') {
  if (!row) return null;
  const r: any = row;
  const decisionStatus: DecisionStatus = r.decision_status === 'OK' ? 'OK' : 'DATA_INCOMPLETE';
  const persistedScore = decisionStatus === 'OK' && typeof r.score === 'number' ? r.score : null;
  const persistedVerdict = decisionStatus === 'OK' ? r.verdict : null;
  const decision = deriveDecisionState({
    score: persistedScore,
    previousVerdict: persistedVerdict,
    netliqDir: r.netliq_dir,
    qeQtRegime: r.qe_qt_regime,
    stressStatus: stress.status,
    decisionStatus,
  });
  return {
    ...r,
    channel_status: channel,
    score: persistedScore,
    verdict: persistedVerdict,
    decision_status: decisionStatus,
    factor_quality: parseJsonObject(r.factor_quality_json),
    freshness: parseJsonObject(r.freshness_json),
    policy_regime: decisionStatus === 'OK' ? policyRegime(r.qe_qt_regime, r.date) : null,
    reason: decision.reason,
    display_verdict: decision.displayVerdict,
    live_stress: stress,
    guidance: decision.guidance,
    coverage_total: COVERAGE_FACTORS.length,
  };
}

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
        const [row, meta, count, ingestRuns] = await Promise.all([
          latestOfficialSnapshot(env.DB),
          getAllMeta(env.DB),
          countOfficialSnapshots(env.DB),
          ingestRunSummary(env.DB),
        ]);
        const h = assessHealth({
          dataDate: (row as any)?.date ?? null,
          snapshots: count,
          coverage: (row as any)?.coverage ?? null,
          decisionStatus: (row as any)?.decision_status,
          lastIngestAt: meta.last_ingest_at ?? null,
          lastStatus: meta.last_status ?? null,
          lastError: meta.last_error ?? null,
          now: new Date().toISOString(),
          staleHours: INGEST_STALE_HOURS,
        });
        const activeSnapshotState = (ingestRuns.active as any)?.snapshot_state as string | undefined;
        const activeSnapshotUnhealthy = ingestRuns.active != null && activeSnapshotState !== 'SUCCEEDED';
        const snapshotError = activeSnapshotState === 'PENDING'
          ? 'snapshot_pending'
          : activeSnapshotState === 'FAILED'
            ? 'snapshot_failed'
            : 'snapshot_not_succeeded';
        const health = activeSnapshotUnhealthy
          ? { ...h, ok: false, stale: true, error: snapshotError }
          : h;
        return json({
          ...health,
          ingest_runs: ingestRuns,
          slo: {
            targets: SLO_TARGETS,
            page_status: health.ok ? 'HEALTHY' : 'UNHEALTHY',
            ingest_status: meta.last_status === 'ok' ? 'HEALTHY' : 'UNHEALTHY',
            critical_snapshot_alerting: SLO_TARGETS.criticalSnapshotAlerting,
          },
        }, health.ok ? 200 : 503);
      } catch (e) {
        return json({ ok: false, stale: true, error: 'db_unreachable', message: String((e as any)?.message ?? e) }, 503);
      }
    }
    if (p === '/api/snapshot' || p === '/api/v1/snapshot') {
      const v1 = p === '/api/v1/snapshot';
      const [officialRow, nowcastRow, liveData, meta, ingestRuns] = await Promise.all([
        latestOfficialSnapshot(env.DB),
        latestNowcastSnapshot(env.DB),
        loadLive(env),
        getAllMeta(env.DB),
        ingestRunSummary(env.DB),
      ]);
      const { live, stress, cache } = liveData;
      const ingest = {
        ingest_at: meta.last_ingest_at ?? null,
        last_attempt_at: meta.last_attempt_at ?? null,
        ingest_age_hours: meta.last_ingest_at
          ? (Date.now() - Date.parse(meta.last_ingest_at)) / 3600000
          : null,
        ingest_status: meta.last_status ?? null,
        runs: ingestRuns,
      };
      const official = presentSnapshot(officialRow, stress, 'OFFICIAL');
      const nowcast = presentSnapshot(nowcastRow, stress, 'PROVISIONAL');
      if (v1) {
        try {
          if (officialRow) assertSnapshotVersionMetadata(officialRow);
          if (nowcastRow) assertSnapshotVersionMetadata(nowcastRow);
        } catch (error) {
          return json({ api_version: 'v1', error: 'schema_validation_failed', message: String((error as Error).message) }, 503);
        }
      }
      if (!official && !nowcast) return json({ official: null, nowcast: null, live, ingest, error: 'no_data' });
      return json({ ...(v1 ? { api_version: 'v1' } : {}), official, nowcast, live, live_cache: cache, ingest });
    }
    if (p === '/api/explain') {
      const wparam = url.searchParams.get('window');
      const window = (wparam === '1m' || wparam === '3m') ? wparam : '1w';
      const days = window === '3m' ? 91 : window === '1m' ? 30 : 7;

      const cur: any = await latestOfficialSnapshot(env.DB);
      if (!cur) return json({ window, error: 'no_data' });
      if (cur.decision_status !== 'OK') {
        return json({
          window,
          error: 'data_incomplete',
          message: '宏观数据不完整，无法生成可靠分数归因',
          current: { date: cur.date, score: null },
        });
      }

      const refDate = new Date(new Date(cur.date + 'T00:00:00Z').getTime() - days * 86400000)
        .toISOString().slice(0, 10);
      const refRow: any = await officialSnapshotOnOrBefore(env.DB, refDate);
      const reference = (refRow && refRow.decision_status === 'OK' && refRow.date !== cur.date) ? refRow : null;

      const curFactors = JSON.parse(cur.factors_json ?? '{}');
      const contributions = factorContributions(curFactors);
      const referenceFactors = reference ? JSON.parse(reference.factors_json ?? '{}') : null;
      const availabilityChanged = referenceFactors != null
        && !sameScoringFactorAvailability(curFactors, referenceFactors);
      const attribution = reference && !availabilityChanged
        ? attributeScoreChange(curFactors, referenceFactors)
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
        attribution_unavailable_reason: availabilityChanged ? 'factor_availability_changed' : null,
        attribution_message: availabilityChanged ? '当前与基准的因子可用性发生变化，暂不进行分数变化归因' : null,
        netliq,
      });
    }
    if (p === '/api/history') {
      const to = url.searchParams.get('to') ?? '2100-01-01';
      const from = url.searchParams.get('from') ?? '1900-01-01';
      return json({ rows: await officialSnapshotHistory(env.DB, from, to) });
    }
    if (p === '/api/prices') {
      const liveData = await loadLive(env);
      return json({ ...liveData.live, cache_status: liveData.cache.prices });
    }
    if (p === '/api/backtest' || p === '/api/v1/backtest') {
      const v1 = p === '/api/v1/backtest';
      const requestedAsOf = url.searchParams.has('as_of') ? url.searchParams.get('as_of')! : undefined;
      let rows: any[];
      let eventInputs: Awaited<ReturnType<typeof loadEventBacktestInputs>>;
      try {
        [rows, eventInputs] = await Promise.all([
          loadBacktestRows(env.DB),
          loadEventBacktestInputs(env.DB, requestedAsOf),
        ]);
      } catch (error) {
        const message = String((error as any)?.message ?? error);
        if (/^(?:invalid|future) backtest as_of$/i.test(message)) {
          return json({ error: 'invalid_as_of', message }, 400);
        }
        throw error;
      }
      const snaps = rows
        .filter((r: any) => r.spx != null && r.score != null && r.factors_json)
        .map((r: any) => ({ date: r.date, score: r.score, spx: r.spx, factors: JSON.parse(r.factors_json) }));
      const legacy = runBacktest(snaps);
      return json({
        ...(v1 ? { api_version: 'v1', model: presentModelDescriptor(await resolveModelIdentity(env)) } : {}),
        ...legacy,
        strategy_long_flat: { ...legacy.strategy_long_flat, methodology: 'LEGACY_WEEKLY' },
        event_time: runEventTimeBacktest(eventInputs),
      });
    }
    if (p === '/api/walkforward') {
      const rows = await loadBacktestRows(env.DB);
      const snaps = rows
        .filter((r: any) => r.spx != null && r.score != null && r.factors_json)
        .map((r: any) => ({ date: r.date, score: r.score, spx: r.spx, factors: JSON.parse(r.factors_json) }));
      return json(runWalkForward(snaps));
    }
    if (p === '/api/robustness' || p === '/api/v1/robustness') {
      const v1 = p === '/api/v1/robustness';
      const rows = await loadBacktestRows(env.DB);
      const snaps = rows
        .filter((r: any) => r.spx != null && r.score != null && r.factors_json)
        .map((r: any) => ({
          date: r.date, score: r.score, spx: r.spx, factors: JSON.parse(r.factors_json),
          regime: r.qe_qt_regime, vix: r.vix_eod,
        }));
      const result = runRobustness(snaps);
      return json(v1
        ? { api_version: 'v1', model: presentModelDescriptor(await resolveModelIdentity(env)), result }
        : result);
    }
    if (p === '/api/v1/model') {
      return json({ api_version: 'v1', model: presentModelDescriptor(await resolveModelIdentity(env)) });
    }
    if (p === '/api/v1/snapshots/export') {
      let range: { from: string; to: string };
      try {
        range = parseDateRange(url);
      } catch (error) {
        return json({ api_version: 'v1', error: 'invalid_query', message: String((error as Error).message) }, 400);
      }
      const format = url.searchParams.get('format') ?? 'json';
      if (format !== 'json' && format !== 'csv') {
        return json({ api_version: 'v1', error: 'invalid_query', message: 'format must be json or csv' }, 400);
      }
      const rows = await exportOfficialSnapshots(env.DB, range.from, range.to);
      try {
        for (const row of rows) assertSnapshotVersionMetadata(row);
      } catch (error) {
        return json({ api_version: 'v1', error: 'schema_validation_failed', message: String((error as Error).message) }, 503);
      }
      if (format === 'csv') {
        return new Response(snapshotsToCsv(rows), {
          headers: {
            'content-type': 'text/csv; charset=utf-8',
            'content-disposition': 'attachment; filename="official-snapshots.csv"',
          },
        });
      }
      return json({ api_version: 'v1', range, rows });
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
      const attemptedAt = new Date().toISOString();
      const requestId = (req.headers.get('cf-ray') ?? req.headers.get('x-request-id')
        ?? `local-${Date.now()}-${Math.random().toString(36).slice(2)}`).slice(0, 128);
      const authMethod = authenticateAdmin(req, env);
      const rebuildAll = url.searchParams.get('all') === '1';
      const confirmed = !rebuildAll || fullRebuildConfirmed(req);
      const audit = async (outcome: string) => recordAdminAudit(env.DB, {
        auditId: `${requestId}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        attemptedAt, action: rebuildAll ? 'FULL_REBUILD' : 'INCREMENTAL_REFRESH',
        authMethod: authMethod ?? 'NONE', authorized: authMethod != null, confirmed,
        outcome, requestId,
      });
      if (!authMethod) {
        await audit('UNAUTHORIZED');
        structuredLog('admin_refresh', { request_id: requestId, authorized: false, rebuild_all: rebuildAll, outcome: 'UNAUTHORIZED' });
        return json({ error: 'unauthorized' }, 401);
      }
      if (!await adminRateLimitAllowed(env.DB, attemptedAt)) {
        await audit('RATE_LIMITED');
        structuredLog('admin_refresh', {
          request_id: requestId, auth_method: authMethod, rebuild_all: rebuildAll, outcome: 'RATE_LIMITED',
        });
        return json({ error: 'rate_limited', retry_after_seconds: 60 }, 429);
      }
      if (!confirmed) {
        await audit('CONFIRMATION_REQUIRED');
        structuredLog('admin_refresh', { request_id: requestId, auth_method: authMethod, rebuild_all: true, outcome: 'CONFIRMATION_REQUIRED' });
        return json({ error: 'confirmation_required', required_header: 'x-confirm-full-rebuild: FULL_REBUILD' }, 428);
      }
      try {
        const result = await runIngest(env, rebuildAll);
        await audit(result.status === 'conflict' ? 'CONFLICT' : 'ACCEPTED');
        structuredLog('admin_refresh', {
          request_id: requestId, auth_method: authMethod, rebuild_all: rebuildAll, outcome: result.status,
        });
        return json(result, result.status === 'conflict' ? 409 : 200);
      } catch (error) {
        await audit('FAILED');
        throw error;
      }
    }
    // not an API route → static assets
    return env.ASSETS.fetch(req);
    } catch (e) {
      structuredLog('request_failure', { error: String((e as Error).message) }, console.error);
      return json({ error: 'internal', message: String((e as any)?.message ?? e) }, 500);
    }
  },

  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(scheduledIngest(event.cron, env).catch(() => undefined));
  },
};
