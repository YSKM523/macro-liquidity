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
  loadLiquidityStructureSeries,
  resolvePolicyRegime,
  exportOfficialSnapshots,
  recordAdminAudit,
  reserveAdminRateLimit,
} from './db';
import { factorContributions, attributeScoreChange, decomposeNetliq, sameScoringFactorAvailability } from './explain';
import { fetchLivePrices, fetchStressSeries, evaluateLiveStress } from './prices';
import { balanceSheetImpulse, policyRegime, deriveDecisionState } from './metrics';
import {
  INGEST_STALE_HOURS,
  COVERAGE_FACTORS,
  LEGACY_ZERO_WEIGHT_DIAGNOSTICS,
  LIVE_RISK_OVERLAY_INPUTS,
  SCORING_FACTOR_KEYS,
} from './config';
import { createHttpAttemptBudget } from './http-retry';
import { assessHealth } from './health';
import { runBacktest } from './backtest';
import { runEventTimeBacktest } from './event-backtest';
import { runWalkForward } from './walkforward';
import { runRobustness } from './robustness';
import { formalValidationUnavailable, runFormalValidation, validateFormalSignal } from './evaluation-protocol';
import { isoTimestampMs } from './pit';
import {
  SCORE_STRESS_PROTOCOL,
  buildFormalOutcomes,
  buildScoreBuckets,
  buildUnavailableStressEvents,
  evaluateStressEvents,
  summarizeHypothesisLedger,
  validateHypothesisLedger,
} from './score-stress-diagnostics';
import scoreStressLedgerArtifact from '../docs/research/SCORE_STRESS_HYPOTHESIS_LEDGER.json';
import scoreStressLedgerInterpretation from '../docs/research/SCORE_STRESS_HYPOTHESIS_LEDGER_INTERPRETATION.json';
import { globalLiquiditySeries, globalLiquidityLatest } from './global';
import type { DecisionStatus } from './metrics';
import {
  assertSnapshotVersionMetadata,
  normalizeSnapshotProvenance,
  parseDateRange,
  snapshotsToCsv,
  summarizeSnapshotProvenance,
} from './api-schema';
import type { NormalizedSnapshotRow } from './api-schema';
import { presentModelDescriptor, resolveModelIdentity } from './model-version';
import {
  LiveDataCache,
  SLO_TARGETS,
  adminRateLimitBucket,
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
import {
  LIQUIDITY_STRUCTURE_PROTOCOL,
  buildEightFactorBenchmarks,
  buildFundingCreditAblations,
  evaluateFundingCreditAblation,
  evaluateTgaBuffer,
  scorePolicyAwareWalcl,
} from './liquidity-structure-challenger';

const livePricesCache = new LiveDataCache<any>({ freshMs: 30_000, staleMs: 120_000, failureThreshold: 3, openMs: 60_000 });
const liveStressCache = new LiveDataCache<any>({ freshMs: 30_000, staleMs: 120_000, failureThreshold: 3, openMs: 60_000 });
export const LIVE_HTTP_ATTEMPT_BUDGET = 32;

async function loadLive(env: Env, ctx?: ExecutionContext) {
  const attemptBudget = createHttpAttemptBudget(LIVE_HTTP_ATTEMPT_BUDGET);
  const providerOptions = { fredApiKey: env.FRED_API_KEY, attemptBudget };
  const cached = <T>(cache: LiveDataCache<T>, loader: () => Promise<T>) => ctx
    ? cache.getSWR(loader, promise => ctx.waitUntil(promise))
    : cache.get(loader);
  const pricesPromise = cached(livePricesCache, () =>
    fetchLivePrices(new Date().toISOString(), providerOptions)
      .then(assertCacheableLivePrices))
    .catch(error => {
      if (error instanceof TypedLiveDataFailure) {
        return { value: error.payload as LivePrices, status: 'FAILED' as const, ageMs: 0 };
      }
      throw error;
    });
  const stressPromise = cached(liveStressCache, () =>
    fetchStressSeries(providerOptions)
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

function requestIdFor(req: Request): string {
  return (req.headers.get('cf-ray') ?? req.headers.get('x-request-id')
    ?? `local-${Date.now()}-${Math.random().toString(36).slice(2)}`).slice(0, 128);
}

const errorJson = (requestId: string, error: string, errorCode: string, status: number) =>
  json({ error, error_code: errorCode, request_id: requestId }, status);

function parseJsonObject(value: unknown): Record<string, unknown> {
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value);
    return parsed != null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function governedSnapshotModels(rows: NormalizedSnapshotRow[]): ReturnType<typeof assertSnapshotVersionMetadata>[] {
  const unique = new Map<string, ReturnType<typeof assertSnapshotVersionMetadata>>();
  for (const row of rows) {
    if (row.provenance_status === 'LEGACY') continue;
    const metadata = assertSnapshotVersionMetadata(row);
    const key = [metadata.modelVersion, metadata.configHash, metadata.codeCommitSha,
      metadata.dataRunId, metadata.dataCutoff, metadata.decisionAt, metadata.createdAt].join('|');
    unique.set(key, metadata);
  }
  return [...unique.values()];
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
  const factorQuality = parseJsonObject(r.factor_quality_json);
  const vol = factorQuality.vol;
  if (vol != null && typeof vol === 'object' && !Array.isArray(vol)) {
    factorQuality.vol = { ...vol as Record<string, unknown>, classification: 'LEGACY_ZERO_WEIGHT_DIAGNOSTIC' };
  }
  return {
    ...r,
    channel_status: channel,
    score: persistedScore,
    verdict: persistedVerdict,
    decision_status: decisionStatus,
    factor_quality: factorQuality,
    factor_classification: {
      scoring_factor_keys: SCORING_FACTOR_KEYS,
      legacy_zero_weight_diagnostics: LEGACY_ZERO_WEIGHT_DIAGNOSTICS,
      live_risk_overlay_inputs: LIVE_RISK_OVERLAY_INPUTS,
    },
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
  async fetch(req: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
    const requestId = requestIdFor(req);
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
        structuredLog('request_failure', {
          request_id: requestId, error_code: 'DB_UNREACHABLE', error: String((e as Error).message),
        }, console.error);
        return errorJson(requestId, 'service_unavailable', 'DB_UNREACHABLE', 503);
      }
    }
    if (p === '/api/snapshot' || p === '/api/v1/snapshot') {
      const v1 = p === '/api/v1/snapshot';
      const [officialRow, nowcastRow, liveData, meta, ingestRuns] = await Promise.all([
        latestOfficialSnapshot(env.DB),
        latestNowcastSnapshot(env.DB),
        loadLive(env, ctx),
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
      let officialSource = officialRow;
      let nowcastSource = nowcastRow;
      let snapshotProvenance: ReturnType<typeof summarizeSnapshotProvenance> | undefined;
      if (v1) {
        try {
          const normalized: NormalizedSnapshotRow[] = [];
          if (officialRow) {
            officialSource = normalizeSnapshotProvenance(officialRow);
            normalized.push(officialSource as NormalizedSnapshotRow);
          }
          if (nowcastRow) {
            nowcastSource = normalizeSnapshotProvenance(nowcastRow);
            normalized.push(nowcastSource as NormalizedSnapshotRow);
          }
          snapshotProvenance = summarizeSnapshotProvenance(normalized);
        } catch (error) {
          structuredLog('request_failure', {
            request_id: requestId, error_code: 'SNAPSHOT_SCHEMA_INVALID', error: String((error as Error).message),
          }, console.error);
          return errorJson(requestId, 'schema_validation_failed', 'SNAPSHOT_SCHEMA_INVALID', 503);
        }
      }
      const official = presentSnapshot(officialSource, stress, 'OFFICIAL');
      const nowcast = presentSnapshot(nowcastSource, stress, 'PROVISIONAL');
      if (!official && !nowcast) return json({
        ...(v1 ? { api_version: 'v1' } : {}),
        official: null, nowcast: null, live, live_cache: cache, ingest,
        ...(v1 ? { snapshot_provenance: snapshotProvenance } : {}),
        error: 'no_data', error_code: 'SNAPSHOT_NO_DATA', request_id: requestId,
      });
      return json({
        ...(v1 ? { api_version: 'v1', snapshot_provenance: snapshotProvenance } : {}),
        official, nowcast, live, live_cache: cache, ingest,
      });
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
      const liveData = await loadLive(env, ctx);
      return json({ ...liveData.live, cache_status: liveData.cache.prices });
    }
    if (p === '/api/v1/challengers/liquidity-structure') {
      const requestedAsOf = url.searchParams.has('as_of') ? url.searchParams.get('as_of')! : undefined;
      const unavailable = (reason: string, asOfCutoff: string | null = requestedAsOf ?? null) => json({
        api_version: 'v1', challenger_id: LIQUIDITY_STRUCTURE_PROTOCOL.protocol,
        mode: LIQUIDITY_STRUCTURE_PROTOCOL.mode, champion_change: false,
        status: 'DATA_INCOMPLETE', reason, as_of_cutoff: asOfCutoff,
        protocol: LIQUIDITY_STRUCTURE_PROTOCOL, provenance: null, signal_provenance: null,
        tga_buffer: null, policy_regime: null, walcl_policy: null,
        weight_benchmarks: null, funding_credit_ablation: null, formal_ablation_evaluation: null,
      });
      let structureInputs: Awaited<ReturnType<typeof loadLiquidityStructureSeries>>;
      let eventInputs: Awaited<ReturnType<typeof loadEventBacktestInputs>>;
      try {
        [structureInputs, eventInputs] = await Promise.all([
          loadLiquidityStructureSeries(env.DB, requestedAsOf),
          loadEventBacktestInputs(env.DB, requestedAsOf),
        ]);
      } catch (error) {
        const message = String((error as Error)?.message ?? error);
        if (/^(?:invalid|future) (?:liquidity-structure|backtest) as_of$/i.test(message)) {
          return errorJson(requestId, 'invalid_as_of', 'INVALID_AS_OF', 400);
        }
        structuredLog('liquidity_structure_failure', {
          request_id: requestId, reason: 'INPUT_LOAD_FAILED', error: message,
        }, console.error);
        return unavailable('INPUT_LOAD_FAILED');
      }
      const signals = [...eventInputs.signals].sort((left, right) => left.decisionAt.localeCompare(right.decisionAt));
      const latestSignal = signals.at(-1);
      if (!latestSignal || !eventInputs.asOfCutoff) {
        return unavailable('NO_GOVERNED_SIGNAL_COVERAGE', eventInputs.asOfCutoff ?? structureInputs.asOfCutoff);
      }
      try {
        validateFormalSignal(latestSignal, isoTimestampMs(eventInputs.asOfCutoff, 'liquidity-structure as-of cutoff'));
      } catch (error) {
        structuredLog('liquidity_structure_failure', {
          request_id: requestId, reason: 'FORMAL_SIGNAL_INVALID',
          error: String((error as Error)?.message ?? error),
        }, console.error);
        return unavailable('FORMAL_SIGNAL_INVALID', eventInputs.asOfCutoff);
      }
      let policy: Awaited<ReturnType<typeof resolvePolicyRegime>>;
      try {
        policy = await resolvePolicyRegime(env.DB, {
          decisionDate: latestSignal.signalDate,
          decisionAt: latestSignal.decisionAt,
          asOfCutoff: eventInputs.asOfCutoff,
        });
      } catch (error) {
        structuredLog('liquidity_structure_failure', {
          request_id: requestId, reason: 'POLICY_REGIME_INVALID',
          error: String((error as Error)?.message ?? error),
        }, console.error);
        return unavailable('POLICY_REGIME_INVALID', eventInputs.asOfCutoff);
      }
      const tgaBuffer = evaluateTgaBuffer(structureInputs.seriesMap, structureInputs.decisionDate);
      const walcl = (structureInputs.seriesMap.WALCL ?? [])
        .filter(row => row.date <= structureInputs.decisionDate);
      const impulse = walcl.length >= 14 ? balanceSheetImpulse(walcl.map(row => row.value)) : null;
      const walclPolicy = policy.status === 'OK' && impulse != null
        ? { ...scorePolicyAwareWalcl(policy.regime, impulse), impulse }
        : { status: 'POLICY_OR_WALCL_UNAVAILABLE' as const, score: null, impulse };
      const weightBenchmarks = buildEightFactorBenchmarks(latestSignal.factors ?? {});
      const ablations = buildFundingCreditAblations(latestSignal.factors ?? {});
      let formalAblation: ReturnType<typeof evaluateFundingCreditAblation> | {
        status: 'DATA_INCOMPLETE'; reason: 'FORMAL_ABLATION_INVALID'; arms: Record<string, never>;
      };
      try {
        formalAblation = evaluateFundingCreditAblation(eventInputs);
      } catch (error) {
        structuredLog('liquidity_structure_failure', {
          request_id: requestId, reason: 'FORMAL_ABLATION_INVALID',
          error: String((error as Error)?.message ?? error),
        }, console.error);
        formalAblation = { status: 'DATA_INCOMPLETE', reason: 'FORMAL_ABLATION_INVALID', arms: {} };
      }
      const complete = tgaBuffer.status === 'OK' && policy.status === 'OK'
        && walclPolicy.status === 'OK' && weightBenchmarks.status === 'OK' && ablations.status === 'OK'
        && formalAblation.status === 'OK';
      return json({
        api_version: 'v1', challenger_id: LIQUIDITY_STRUCTURE_PROTOCOL.protocol,
        mode: LIQUIDITY_STRUCTURE_PROTOCOL.mode, champion_change: false,
        status: complete ? 'OK' : 'DATA_INCOMPLETE', reason: complete ? null : 'CHALLENGER_COMPONENT_INCOMPLETE',
        as_of_cutoff: eventInputs.asOfCutoff, protocol: LIQUIDITY_STRUCTURE_PROTOCOL,
        provenance: structureInputs.provenance,
        signal_provenance: {
          signal_date: latestSignal.signalDate, decision_at: latestSignal.decisionAt,
          model_version: latestSignal.modelVersion, config_hash: latestSignal.configHash,
        },
        tga_buffer: tgaBuffer, policy_regime: policy, walcl_policy: walclPolicy,
        weight_benchmarks: weightBenchmarks, funding_credit_ablation: ablations,
        formal_ablation_evaluation: formalAblation,
      });
    }
    if (p === '/api/v1/diagnostics') {
      const requestedAsOf = url.searchParams.has('as_of') ? url.searchParams.get('as_of')! : undefined;
      const multipleTesting = summarizeHypothesisLedger(validateHypothesisLedger(
        scoreStressLedgerArtifact, scoreStressLedgerInterpretation,
      ));
      const unavailable = (
        reason: string,
        eventStatus: Parameters<typeof buildUnavailableStressEvents>[0] = 'INPUT_UNAVAILABLE',
        asOfCutoff: string | null = requestedAsOf ?? null,
      ) => json({
        api_version: 'v1', status: 'DATA_INCOMPLETE', reason,
        as_of_cutoff: asOfCutoff, protocol: SCORE_STRESS_PROTOCOL,
        score_buckets: buildScoreBuckets([]), stress_events: buildUnavailableStressEvents(eventStatus),
        multiple_testing: multipleTesting,
        formal_dsr: {
          status: 'TRIAL_UNIVERSE_INCOMPLETE', value: null,
          reason: 'NO_COMPLETE_FORMAL_DAILY_NET_RETURN_TRIAL_VECTOR',
        },
        candidate_comparison: { status: 'CANDIDATE_NOT_PROVIDED', candidate: null },
      });
      let eventInputs: Awaited<ReturnType<typeof loadEventBacktestInputs>>;
      try {
        eventInputs = await loadEventBacktestInputs(env.DB, requestedAsOf);
      } catch (error) {
        const message = String((error as Error)?.message ?? error);
        if (/^(?:invalid|future) backtest as_of$/i.test(message)) {
          return errorJson(requestId, 'invalid_as_of', 'INVALID_AS_OF', 400);
        }
        structuredLog('diagnostics_failure', {
          request_id: requestId, reason: 'EVENT_INPUT_LOAD_FAILED', error: message,
        }, console.error);
        return unavailable('EVENT_INPUT_LOAD_FAILED');
      }
      if (eventInputs.signals.length === 0) {
        return unavailable('NO_FORMAL_SIGNAL_COVERAGE', 'NO_FORMAL_SIGNAL_COVERAGE', eventInputs.asOfCutoff ?? null);
      }
      if (eventInputs.prices.length === 0) {
        return unavailable('NO_FORMAL_PRICE_COVERAGE', 'NO_FORMAL_PRICE_COVERAGE', eventInputs.asOfCutoff ?? null);
      }
      if (eventInputs.prices.some(price => price.provenanceStatus !== 'PIT_RAW')) {
        return unavailable('NON_PIT_PRICE_COVERAGE', 'NON_PIT_PRICE_COVERAGE', eventInputs.asOfCutoff ?? null);
      }
      try {
        const outcomes = buildFormalOutcomes(eventInputs);
        const asOfCutoff = eventInputs.asOfCutoff;
        if (!asOfCutoff) throw new Error('formal diagnostics require an explicit as-of cutoff');
        const missingCoverage = outcomes.some(row => row.status === 'MISSING_PRICE_COVERAGE' || row.status === 'UNEXECUTED');
        const pending = outcomes.some(row => row.status === 'PENDING_OUTCOME');
        const stressEvents = evaluateStressEvents(outcomes, asOfCutoff.slice(0, 10), eventInputs.prices);
        return json({
          api_version: 'v1',
          status: missingCoverage ? 'DATA_INCOMPLETE' : pending ? 'PENDING_OUTCOMES' : 'OK',
          reason: missingCoverage ? 'FORMAL_PRICE_COVERAGE_INCOMPLETE' : pending ? 'OUTCOMES_NOT_YET_MATURE' : null,
          as_of_cutoff: asOfCutoff,
          protocol: SCORE_STRESS_PROTOCOL,
          provenance: {
            methodology: 'APPEND_ONLY_AS_OF_PIT_RAW',
            signal_count: eventInputs.signals.length,
            price_count: eventInputs.prices.length,
            model_versions: [...new Set(eventInputs.signals.map(signal => signal.modelVersion))].sort(),
            config_hashes: [...new Set(eventInputs.signals.map(signal => signal.configHash))].sort(),
          },
          score_buckets: buildScoreBuckets(outcomes),
          stress_events: stressEvents,
          multiple_testing: multipleTesting,
          formal_dsr: {
            status: 'TRIAL_UNIVERSE_INCOMPLETE', value: null,
            reason: 'NO_COMPLETE_FORMAL_DAILY_NET_RETURN_TRIAL_VECTOR',
          },
          candidate_comparison: { status: 'CANDIDATE_NOT_PROVIDED', candidate: null },
        });
      } catch (error) {
        structuredLog('diagnostics_failure', {
          request_id: requestId, reason: 'FORMAL_INPUT_INVALID',
          error: String((error as Error)?.message ?? error),
        }, console.error);
        return unavailable('FORMAL_INPUT_INVALID', 'FORMAL_INPUT_INVALID', eventInputs.asOfCutoff ?? null);
      }
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
          return errorJson(requestId, 'invalid_as_of', 'INVALID_AS_OF', 400);
        }
        throw error;
      }
      const snaps = rows
        .filter((r: any) => r.spx != null && r.score != null && r.factors_json)
        .map((r: any) => ({ date: r.date, score: r.score, spx: r.spx, factors: JSON.parse(r.factors_json) }));
      const legacy = runBacktest(snaps);
      let governedModels: ReturnType<typeof assertSnapshotVersionMetadata>[] = [];
      let normalizedRows: NormalizedSnapshotRow[] = [];
      if (v1) {
        try {
          normalizedRows = eventInputs.signals.map(signal => normalizeSnapshotProvenance({
            model_version: signal.modelVersion,
            config_hash: signal.configHash,
            code_commit_sha: signal.codeCommitSha,
            data_run_id: signal.dataRunId,
            data_cutoff: signal.dataCutoff,
            decision_at: signal.decisionAt,
            created_at: signal.createdAt,
          }));
          governedModels = governedSnapshotModels(normalizedRows);
        } catch (error) {
          structuredLog('request_failure', {
            request_id: requestId, error_code: 'SNAPSHOT_SCHEMA_INVALID', error: String((error as Error).message),
          }, console.error);
          return errorJson(requestId, 'schema_validation_failed', 'SNAPSHOT_SCHEMA_INVALID', 503);
        }
      }
      return json({
        ...(v1 ? {
          api_version: 'v1', runtime_model: presentModelDescriptor(await resolveModelIdentity(env)),
          snapshot_models: governedModels,
          snapshot_provenance: summarizeSnapshotProvenance(normalizedRows),
        } : {}),
        ...legacy,
        strategy_long_flat: { ...legacy.strategy_long_flat, methodology: 'LEGACY_WEEKLY' },
        event_time: runEventTimeBacktest(eventInputs),
      });
    }
    if (p === '/api/walkforward') {
      const [rows, validation] = await Promise.all([
        loadBacktestRows(env.DB),
        loadEventBacktestInputs(env.DB)
          .then(runFormalValidation)
          .catch(error => formalValidationUnavailable('EVENT_INPUT_LOAD_FAILED', String((error as Error).message))),
      ]);
      const snaps = rows
        .filter((r: any) => r.spx != null && r.score != null && r.factors_json)
        .map((r: any) => ({ date: r.date, score: r.score, spx: r.spx, factors: JSON.parse(r.factors_json) }));
      return json({ ...runWalkForward(snaps), validation });
    }
    if (p === '/api/robustness' || p === '/api/v1/robustness') {
      const v1 = p === '/api/v1/robustness';
      const [rows, validation] = await Promise.all([
        loadBacktestRows(env.DB),
        loadEventBacktestInputs(env.DB)
          .then(runFormalValidation)
          .catch(error => formalValidationUnavailable('EVENT_INPUT_LOAD_FAILED', String((error as Error).message))),
      ]);
      const snaps = rows
        .filter((r: any) => r.spx != null && r.score != null && r.factors_json)
        .map((r: any) => ({
          date: r.date, score: r.score, spx: r.spx, factors: JSON.parse(r.factors_json),
          regime: r.qe_qt_regime, vix: r.vix_eod,
        }));
      const result = { ...runRobustness(snaps), validation };
      if (!v1) return json(result);
      try {
        const normalizedRows = rows.map(normalizeSnapshotProvenance);
        return json({
          api_version: 'v1', runtime_model: presentModelDescriptor(await resolveModelIdentity(env)),
          snapshot_models: governedSnapshotModels(normalizedRows),
          snapshot_provenance: summarizeSnapshotProvenance(normalizedRows), result,
        });
      } catch (error) {
        structuredLog('request_failure', {
          request_id: requestId, error_code: 'SNAPSHOT_SCHEMA_INVALID', error: String((error as Error).message),
        }, console.error);
        return errorJson(requestId, 'schema_validation_failed', 'SNAPSHOT_SCHEMA_INVALID', 503);
      }
    }
    if (p === '/api/v1/model') {
      return json({ api_version: 'v1', model: presentModelDescriptor(await resolveModelIdentity(env)) });
    }
    if (p === '/api/v1/snapshots/export') {
      let range: { from: string; to: string };
      try {
        range = parseDateRange(url);
      } catch {
        return errorJson(requestId, 'invalid_query', 'INVALID_QUERY', 400);
      }
      const format = url.searchParams.get('format') ?? 'json';
      if (format !== 'json' && format !== 'csv') {
        return errorJson(requestId, 'invalid_query', 'INVALID_QUERY', 400);
      }
      const rows = await exportOfficialSnapshots(env.DB, range.from, range.to);
      let normalizedRows: NormalizedSnapshotRow[];
      try {
        normalizedRows = rows.map(normalizeSnapshotProvenance);
      } catch (error) {
        structuredLog('request_failure', {
          request_id: requestId, error_code: 'SNAPSHOT_SCHEMA_INVALID', error: String((error as Error).message),
        }, console.error);
        return errorJson(requestId, 'schema_validation_failed', 'SNAPSHOT_SCHEMA_INVALID', 503);
      }
      if (format === 'csv') {
        return new Response(snapshotsToCsv(normalizedRows), {
          headers: {
            'content-type': 'text/csv; charset=utf-8',
            'content-disposition': 'attachment; filename="official-snapshots.csv"',
          },
        });
      }
      return json({ api_version: 'v1', range, provenance: summarizeSnapshotProvenance(normalizedRows), rows: normalizedRows });
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
      const rebuildAll = url.searchParams.get('all') === '1';
      const confirmed = !rebuildAll || fullRebuildConfirmed(req);
      const action = rebuildAll ? 'FULL_REBUILD' : 'INCREMENTAL_REFRESH';
      const reservation = await reserveAdminRateLimit(
        env.DB, adminRateLimitBucket(req), attemptedAt,
      );
      if (!reservation) {
        await recordAdminAudit(env.DB, {
          auditId: `${requestId}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
          attemptedAt, action, authMethod: 'NOT_EVALUATED', authorized: false,
          confirmed, outcome: 'RATE_LIMITED', requestId,
        });
        structuredLog('admin_refresh', {
          request_id: requestId, auth_method: 'NOT_EVALUATED', rebuild_all: rebuildAll, outcome: 'RATE_LIMITED',
        });
        return json({ error: 'rate_limited', error_code: 'ADMIN_RATE_LIMITED', request_id: requestId, retry_after_seconds: 60 }, 429);
      }
      const authMethod = authenticateAdmin(req, env);
      const audit = async (outcome: string) => recordAdminAudit(env.DB, {
        auditId: `${requestId}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        attemptedAt, action,
        authMethod: authMethod ?? 'NONE', authorized: authMethod != null, confirmed,
        outcome, requestId,
      });
      if (!authMethod) {
        await audit('UNAUTHORIZED');
        structuredLog('admin_refresh', { request_id: requestId, authorized: false, rebuild_all: rebuildAll, outcome: 'UNAUTHORIZED' });
        return errorJson(requestId, 'unauthorized', 'ADMIN_UNAUTHORIZED', 401);
      }
      if (!confirmed) {
        await audit('CONFIRMATION_REQUIRED');
        structuredLog('admin_refresh', { request_id: requestId, auth_method: authMethod, rebuild_all: true, outcome: 'CONFIRMATION_REQUIRED' });
        return json({ error: 'confirmation_required', error_code: 'REBUILD_CONFIRMATION_REQUIRED', request_id: requestId,
          required_header: 'x-confirm-full-rebuild: FULL_REBUILD' }, 428);
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
    return await env.ASSETS.fetch(req);
    } catch (e) {
      structuredLog('request_failure', {
        request_id: requestId, error_code: 'INTERNAL_ERROR', error: String((e as Error).message),
      }, console.error);
      return errorJson(requestId, 'internal_error', 'INTERNAL_ERROR', 500);
    }
  },

  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(scheduledIngest(event.cron, env).catch(() => undefined));
  },
};
