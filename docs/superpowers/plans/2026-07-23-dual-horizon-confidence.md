# Dual-Horizon Score and Confidence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a read-only Shadow endpoint and dashboard card that preserve the formal 13-week Champion, calculate a four-week tactical score, and guard its hypothetical exposure adjustment with an auditable five-part confidence score.

**Architecture:** A new pure `dual-horizon-confidence` module owns the frozen Shadow protocol, tactical/confidence arithmetic, PR-11 Raw/Smooth adapter, fail-closed composition, and result types. `db.ts` supplies one governed formal snapshot cohort plus four strictly cutoff-visible PIT liquidity series; `worker.ts` only validates the request, pins both loaders to one database cutoff, and serializes the pure result. The existing Champion computation, snapshot writes, portfolio mapper, and formal routes remain unchanged.

**Tech Stack:** TypeScript 5.5 strict mode, Cloudflare Workers/D1, Vitest 2, Miniflare 3, plain browser JavaScript and CSS.

## Global Constraints

- Protocol identity is exactly `DUAL_HORIZON_CONFIDENCE_SHADOW_V1`; mode is `SHADOW_ONLY`; `championChanged` is always `false`.
- `strategicScore` is the persisted formal Champion score; it is never recomputed.
- Tactical scoring uses the existing eight positive-weight Champion factors and exact current `WEIGHTS`; only `netliqTrend` uses `scoreNetliqTrend(rawLevels, 4)`.
- Tactical thresholds are inclusive: score `>= 60` is `+0.10`, score `<= 40` is `-0.10`, otherwise zero.
- Confidence is the equal 20% mean of completeness, freshness, current-regime sample size, major-factor agreement, and Raw/Smooth direction agreement.
- A positive tactical adjustment is blocked below confidence 60; Shadow exposure is capped at 0.75 below confidence 40.
- All database visibility comparisons remain strict (`julianday(value) < julianday(cutoff)`).
- Missing key PIT evidence returns `DATA_INCOMPLETE`; it never becomes neutral confidence.
- No scoring formula, Champion weight, verdict threshold, hysteresis rule, formal snapshot, live stress overlay, or production route meaning may change.
- No migration, deployment, remote D1/R2 command, real alert, or production write is authorized.
- If weekly formal and daily provisional snapshots interfere with tests, record the issue in `docs/pr-reports/PR-18.md`; do not refactor the channels in this PR.

---

## File Map

- Create `src/dual-horizon-confidence.ts`: frozen protocol, pure scoring/confidence functions, PR-11 adapter, input/result types, and fail-closed composer.
- Create `test/dual-horizon-confidence.test.ts`: arithmetic boundaries, 4/13 divergence, PR-11 parity, no-lookahead, incomplete inputs, and Champion immutability.
- Create `test/dual-horizon-db.test.ts`: exact cutoff, latest vintage, override visibility, snapshot cohort, regime sample, and channel-exclusion integration tests.
- Modify `src/db.ts`: add the dedicated governed-snapshot loader and include `WTREGEN` in the existing read-only PIT liquidity-series result.
- Modify `src/worker.ts`: expose `GET /api/v1/challengers/dual-horizon`.
- Modify `test/worker.test.ts`: route success, cutoff pinning, validation, redaction, and Champion-unchanged tests.
- Modify `public/index.html`: add the visibly Shadow dual-horizon card.
- Modify `public/app.js`: fetch, escape, and render the new response.
- Modify `public/styles.css`: place the new card in the mobile reading order.
- Modify `test/ui-assets.test.ts`: verify labeling, fetch path, escaping, incomplete state, and absence of formal/Champion claims.
- Create `docs/pr-reports/PR-18.md`: implementation, tests, limitations, rollback, and non-deployment evidence.
- Modify `public/md/CODEX_PROFESSIONAL_UPGRADE_PLAN.md`: mark PR-18 complete only after final verification and independent review.

---

### Task 1: Freeze the pure tactical and confidence policy

**Files:**
- Create: `src/dual-horizon-confidence.ts`
- Create: `test/dual-horizon-confidence.test.ts`

**Interfaces:**
- Consumes: `SCORING_FACTOR_KEYS`, `WEIGHTS`, `scoreNetliqTrend`, `mapPortfolioPolicy`, and `snapshotVixStressStatus`.
- Produces: `DUAL_HORIZON_PROTOCOL`, `scoreTacticalCohort()`, `computeDualHorizonConfidence()`, and `mapShadowExposure()`.

- [ ] **Step 1: Write failing arithmetic and boundary tests**

```ts
import { describe, expect, it } from 'vitest';
import { WEIGHTS } from '../src/config';
import {
  computeDualHorizonConfidence,
  mapShadowExposure,
  scoreTacticalCohort,
} from '../src/dual-horizon-confidence';

const factors = {
  netliqTrend: 10, impulse: 60, credit: 20, funding: 40,
  rates: 50, dollar: 70, reserveAdequacy: 60, curve: 90,
};

describe('dual-horizon frozen arithmetic', () => {
  it('replaces only netliqTrend and applies the literal Champion weights without renormalizing', () => {
    expect(WEIGHTS).toEqual({
      netliqTrend: 0.35, impulse: 0.05, credit: 0.06, funding: 0.04,
      rates: 0.05, dollar: 0.18, vol: 0, reserveAdequacy: 0.12, curve: 0.15,
    });
    const result = scoreTacticalCohort(factors, 80);
    const expected = Object.entries({ ...factors, netliqTrend: 80 })
      .reduce((sum, [key, value]) => sum + value * WEIGHTS[key as keyof typeof WEIGHTS], 0);
    expect(result).toEqual({
      status: 'OK', score: expected, factors: { ...factors, netliqTrend: 80 },
    });
    expect(Object.values(WEIGHTS).reduce((sum, weight) => sum + weight, 0)).toBe(1);
  });

  it('fails closed when any positive-weight factor is absent', () => {
    const { funding: _funding, ...incomplete } = factors;
    expect(scoreTacticalCohort(incomplete, 80)).toEqual({
      status: 'DATA_INCOMPLETE', reason: 'MISSING_FORMAL_FACTOR_COHORT',
    });
  });

  it('calculates the five equal confidence components exactly', () => {
    expect(computeDualHorizonConfidence({
      factorStatuses: {
        netliqTrend: 'OK', impulse: 'PARTIAL', credit: 'OK', funding: 'OK',
        rates: 'STALE', dollar: 'OK', reserveAdequacy: 'OK', curve: 'MISSING',
      },
      tacticalFactors: {
        netliqTrend: 70, impulse: 60, credit: 20, funding: 40,
        rates: 50, dollar: 70, reserveAdequacy: 60, curve: 40,
      },
      sameRegimeSampleCount: 26,
      rawSmooth: 'HIGH',
    })).toMatchObject({
      status: 'OK',
      components: {
        completeness: 100,
        freshness: 68.75,
        regimeSample: 50,
        majorFactorAgreement: 75,
        rawSmoothAgreement: 100,
      },
      confidence: 78.75,
    });
  });

  it('uses inclusive tactical boundaries and exact confidence guard boundaries', () => {
    expect(mapShadowExposure(0.75, 60, 60)).toMatchObject({
      unguardedAdjustment: 0.10, shadowAdjustment: 0.10, shadowTargetExposure: 0.85,
    });
    expect(mapShadowExposure(0.75, 60, 59.999)).toMatchObject({
      unguardedAdjustment: 0.10, shadowAdjustment: 0, shadowTargetExposure: 0.75,
    });
    expect(mapShadowExposure(1, 50, 40)).toMatchObject({
      unguardedAdjustment: 0, shadowTargetExposure: 1,
    });
    expect(mapShadowExposure(1, 50, 39.999)).toMatchObject({
      unguardedAdjustment: 0, shadowTargetExposure: 0.75,
    });
    expect(mapShadowExposure(0.75, 40, 80).shadowAdjustment).toBe(-0.10);
  });
});
```

- [ ] **Step 2: Run the focused test and observe the missing-module failure**

Run:

```bash
env -u NODE_OPTIONS PATH=/home/ubuntu/.nvm/versions/node/v22.22.0/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin npx vitest run test/dual-horizon-confidence.test.ts
```

Expected: FAIL because `src/dual-horizon-confidence.ts` does not exist.

- [ ] **Step 3: Add the frozen protocol, tactical score, confidence, and exposure functions**

```ts
import { SCORING_FACTOR_KEYS, WEIGHTS } from './config';
import { clamp } from './metrics';

export const DUAL_HORIZON_PROTOCOL = Object.freeze({
  protocol: 'DUAL_HORIZON_CONFIDENCE_SHADOW_V1' as const,
  mode: 'SHADOW_ONLY' as const,
  championChanged: false as const,
  strategicWeeks: 13,
  tacticalWeeks: 4,
  tacticalUpper: 60,
  tacticalLower: 40,
  confidenceUpwardMinimum: 60,
  confidenceExposureCapThreshold: 40,
  lowConfidenceExposureCap: 0.75,
  regimeSampleCap: 52,
  confidenceWeight: 0.20,
});

export type DualFactorStatus = 'OK' | 'PARTIAL' | 'STALE' | 'MISSING';
export type RawSmoothAgreement = 'HIGH' | 'LOW' | 'TRANSITION';
export type DualHorizonIncompleteReason =
  | 'AS_OF_CUTOFF_MISMATCH'
  | 'NO_GOVERNED_FORMAL_SNAPSHOT'
  | 'SNAPSHOT_WORK_LIMIT_EXCEEDED'
  | 'FORMAL_SNAPSHOT_INVALID'
  | 'MISSING_FORMAL_FACTOR_COHORT'
  | 'MISSING_TACTICAL_HISTORY'
  | 'MISSING_RAW_SMOOTH_HISTORY'
  | 'CONFIDENCE_INPUT_INCOMPLETE';

function completeFactors(input: Record<string, number | undefined>) {
  const output: Record<string, number> = {};
  for (const key of SCORING_FACTOR_KEYS) {
    const value = input[key];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100) return null;
    output[key] = value;
  }
  return output;
}

export function scoreTacticalCohort(
  formalFactors: Record<string, number | undefined>,
  tacticalNetliqTrend: number,
) {
  const factors = completeFactors({ ...formalFactors, netliqTrend: tacticalNetliqTrend });
  if (!factors) {
    return { status: 'DATA_INCOMPLETE' as const, reason: 'MISSING_FORMAL_FACTOR_COHORT' as const };
  }
  const score = SCORING_FACTOR_KEYS.reduce(
    (sum, key) => sum + factors[key] * WEIGHTS[key as keyof typeof WEIGHTS],
    0,
  );
  return { status: 'OK' as const, score: clamp(score), factors };
}

const FRESHNESS_SCORE: Record<DualFactorStatus, number> = {
  OK: 100, PARTIAL: 50, STALE: 0, MISSING: 0,
};
const MAJOR_FACTORS = ['netliqTrend', 'dollar', 'reserveAdequacy', 'curve'] as const;

export function computeDualHorizonConfidence(input: {
  factorStatuses: Record<string, DualFactorStatus | undefined>;
  tacticalFactors: Record<string, number | undefined>;
  sameRegimeSampleCount: number;
  rawSmooth: RawSmoothAgreement | null;
}) {
  const factors = completeFactors(input.tacticalFactors);
  const statuses = SCORING_FACTOR_KEYS.map(key => input.factorStatuses[key]);
  if (!factors || statuses.some(status => status == null) || input.rawSmooth == null
    || !Number.isSafeInteger(input.sameRegimeSampleCount) || input.sameRegimeSampleCount < 0) {
    return { status: 'DATA_INCOMPLETE' as const, reason: 'CONFIDENCE_INPUT_INCOMPLETE' as const };
  }
  const completeness = 100;
  const freshness = statuses.reduce((sum, status) => sum + FRESHNESS_SCORE[status!], 0)
    / SCORING_FACTOR_KEYS.length;
  const regimeSample = Math.min(100, input.sameRegimeSampleCount / 52 * 100);
  const directions = MAJOR_FACTORS.map(key => factors[key] > 55 ? 'UP' : factors[key] < 45 ? 'DOWN' : 'NEUTRAL');
  const up = directions.filter(value => value === 'UP').length;
  const down = directions.filter(value => value === 'DOWN').length;
  const neutral = directions.length - up - down;
  const majorFactorAgreement = 100 * Math.max(up + 0.5 * neutral, down + 0.5 * neutral) / 4;
  const rawSmoothAgreement = input.rawSmooth === 'HIGH' ? 100 : input.rawSmooth === 'LOW' ? 0 : 50;
  const components = { completeness, freshness, regimeSample, majorFactorAgreement, rawSmoothAgreement };
  const confidence = Object.values(components).reduce((sum, value) => sum + value, 0) / 5;
  return { status: 'OK' as const, confidence, components };
}

export function mapShadowExposure(baseExposure: number, tacticalScore: number, confidence: number) {
  if (![baseExposure, tacticalScore, confidence].every(Number.isFinite)) {
    throw new Error('invalid dual-horizon exposure input');
  }
  const unguardedAdjustment = tacticalScore >= 60 ? 0.10 : tacticalScore <= 40 ? -0.10 : 0;
  const shadowAdjustment = confidence < 60 && unguardedAdjustment > 0 ? 0 : unguardedAdjustment;
  let shadowTargetExposure = Math.max(0.25, Math.min(1, baseExposure + shadowAdjustment));
  if (confidence < 40) shadowTargetExposure = Math.min(0.75, shadowTargetExposure);
  return { unguardedAdjustment, shadowAdjustment, shadowTargetExposure };
}
```

- [ ] **Step 4: Run the focused test and TypeScript**

Run:

```bash
env -u NODE_OPTIONS PATH=/home/ubuntu/.nvm/versions/node/v22.22.0/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin npx vitest run test/dual-horizon-confidence.test.ts
env -u NODE_OPTIONS PATH=/home/ubuntu/.nvm/versions/node/v22.22.0/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin npx tsc --noEmit
```

Expected: focused tests PASS and TypeScript exits 0.

- [ ] **Step 5: Commit the pure policy**

```bash
git add src/dual-horizon-confidence.ts test/dual-horizon-confidence.test.ts
git commit -m "feat: freeze dual-horizon confidence policy"
```

---

### Task 2: Load governed snapshots and all four PIT liquidity series

**Files:**
- Modify: `src/db.ts`
- Create: `test/dual-horizon-db.test.ts`

**Interfaces:**
- Consumes: existing D1 clock validation, override validation, PIT release/tradability rules, and official weekly snapshot tables.
- Produces: `loadDualHorizonSnapshotInputs(db, requestedAsOf?)` and a `loadLiquidityStructureSeries()` result containing `WALCL`, `WDTGAL`, `WTREGEN`, and `RRPONTSYD`.

- [ ] **Step 1: Write failing D1 integration tests**

```ts
import { describe, expect, it } from 'vitest';
import { Miniflare } from 'miniflare';
import {
  loadDualHorizonSnapshotInputs,
  loadLiquidityStructureSeries,
} from '../src/db';

describe('dual-horizon PIT inputs', () => {
  it('selects only governed weekly snapshots strictly visible at one cutoff', async () => {
    const { mf, db } = await migratedDb();
    await seedOfficialSnapshot(db, {
      date: '2024-01-03', recordedAt: '2024-01-05T00:00:00Z',
      modelVersion: 'champion-v1.0.0', configHash: 'a'.repeat(64), regime: 'FLAT',
    });
    await seedOfficialSnapshot(db, {
      date: '2024-01-10', recordedAt: '2024-01-12T00:00:00Z',
      modelVersion: 'champion-v1.0.0', configHash: 'a'.repeat(64), regime: 'FLAT',
    });
    await seedProvisionalSnapshot(db, '2024-01-11');

    const atEquality = await loadDualHorizonSnapshotInputs(db, '2024-01-12T00:00:00Z');
    expect(atEquality.snapshots.map(row => row.date)).toEqual(['2024-01-03']);
    const after = await loadDualHorizonSnapshotInputs(db, '2024-01-12T00:00:00.001Z');
    expect(after.snapshots.map(row => row.date)).toEqual(['2024-01-03', '2024-01-10']);
    expect(JSON.stringify(after)).not.toContain('2024-01-11');
    await mf.dispose();
  });

  it('returns WTREGEN and hides late vintages and post-cutoff overrides', async () => {
    const { mf, db } = await migratedDb();
    await seedPitRow(db, 'WTREGEN', '2024-01-03', '2024-01-04', '2024-01-05T00:00:00Z', 700);
    await seedPitRow(db, 'WTREGEN', '2024-01-03', '2024-01-11', '2024-01-12T00:00:00Z', 710);
    const old = await loadLiquidityStructureSeries(db, '2024-01-12T00:00:00Z');
    expect(old.seriesMap.WTREGEN).toEqual([{ date: '2024-01-03', value: 700 }]);
    const revised = await loadLiquidityStructureSeries(db, '2024-01-12T00:00:00.001Z');
    expect(revised.seriesMap.WTREGEN).toEqual([{ date: '2024-01-03', value: 710 }]);
    await mf.dispose();
  });

  it('rejects malformed and future as_of values', async () => {
    const { mf, db } = await migratedDb();
    await expect(loadDualHorizonSnapshotInputs(db, 'bad')).rejects.toThrow(/invalid dual-horizon as_of/i);
    await expect(loadDualHorizonSnapshotInputs(db, '2999-01-01T00:00:00Z')).rejects.toThrow(/future dual-horizon as_of/i);
    await mf.dispose();
  });
});
```

The helpers in this test apply migrations `0001` through `0011`, insert complete governed snapshot metadata, serialize all eight scores into `factors_json`, and serialize all eight `FactorResult` objects into `factor_quality_json`. They use explicit ISO timestamps and no wall-clock assumptions.

- [ ] **Step 2: Run the database test and observe the missing export/WTREGEN failures**

Run:

```bash
env -u NODE_OPTIONS PATH=/home/ubuntu/.nvm/versions/node/v22.22.0/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin npx vitest run test/dual-horizon-db.test.ts
```

Expected: FAIL because `loadDualHorizonSnapshotInputs` is not exported and `WTREGEN` is absent.

- [ ] **Step 3: Add the snapshot input types and loader**

```ts
export interface DualHorizonSnapshotRow {
  date: string;
  decisionAt: string;
  recordedAt: string;
  score: number;
  verdict: string;
  netliqDir: string;
  snapshotVixEod: number | null;
  qeQtRegime: string;
  factors: Record<string, unknown>;
  factorResults: Record<string, unknown>;
  modelVersion: string;
  configHash: string;
  codeCommitSha: string;
  dataRunId: string;
  dataCutoff: string;
  createdAt: string;
}

export interface DualHorizonSnapshotInputs {
  asOfCutoff: string;
  snapshots: DualHorizonSnapshotRow[];
  provenance: { methodology: 'GOVERNED_WEEKLY_AS_OF'; rowCount: number };
}

function parseObjectJson(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== 'string') throw new Error(`dual-horizon ${field} missing`);
  let parsed: unknown;
  try { parsed = JSON.parse(value); }
  catch { throw new Error(`dual-horizon ${field} invalid`); }
  if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`dual-horizon ${field} invalid`);
  }
  return parsed as Record<string, unknown>;
}

function parseDualHorizonSnapshotRow(row: Record<string, unknown>): DualHorizonSnapshotRow {
  if (typeof row.date !== 'string') throw new Error('dual-horizon snapshot date missing');
  requirePolicyDate(row.date, 'dual-horizon snapshot date');
  for (const field of ['decision_at', 'recorded_at', 'data_cutoff', 'created_at'] as const) {
    if (typeof row[field] !== 'string') throw new Error(`dual-horizon ${field} missing`);
    requireIsoTimestamp(row[field], `dual-horizon ${field}`);
  }
  if (typeof row.score !== 'number' || !Number.isFinite(row.score)
    || row.score < 0 || row.score > 100) throw new Error('dual-horizon snapshot score invalid');
  const fieldIssue = officialPortfolioFieldIssue({
    score: row.score,
    verdict: row.verdict,
    netliqDir: row.netliq_dir,
    snapshotVixEod: row.vix_eod,
  });
  if (fieldIssue) throw new Error(fieldIssue);
  if (typeof row.qe_qt_regime !== 'string' || row.qe_qt_regime.length === 0) {
    throw new Error('dual-horizon qe_qt_regime missing');
  }
  if (typeof row.model_version !== 'string' || row.model_version === 'LEGACY_UNVERSIONED') {
    throw new Error('dual-horizon model version invalid');
  }
  if (typeof row.config_hash !== 'string' || !/^[a-f0-9]{64}$/.test(row.config_hash)) {
    throw new Error('dual-horizon config hash invalid');
  }
  if (typeof row.code_commit_sha !== 'string'
    || !(row.code_commit_sha === 'LOCAL_UNCONFIGURED' || /^[a-f0-9]{40}$/.test(row.code_commit_sha))) {
    throw new Error('dual-horizon commit SHA invalid');
  }
  if (typeof row.data_run_id !== 'string' || row.data_run_id.length === 0) {
    throw new Error('dual-horizon data run id missing');
  }
  return {
    date: row.date,
    decisionAt: row.decision_at as string,
    recordedAt: row.recorded_at as string,
    score: row.score,
    verdict: row.verdict as string,
    netliqDir: row.netliq_dir as string,
    snapshotVixEod: row.vix_eod as number | null,
    qeQtRegime: row.qe_qt_regime,
    factors: parseObjectJson(row.factors_json, 'factors_json'),
    factorResults: parseObjectJson(row.factor_quality_json, 'factor_quality_json'),
    modelVersion: row.model_version,
    configHash: row.config_hash,
    codeCommitSha: row.code_commit_sha,
    dataRunId: row.data_run_id,
    dataCutoff: row.data_cutoff as string,
    createdAt: row.created_at as string,
  };
}

export async function loadDualHorizonSnapshotInputs(
  db: D1Database,
  requestedAsOf?: string,
): Promise<DualHorizonSnapshotInputs> {
  const clock = await db.prepare(
    `WITH clock AS (SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now') AS db_now)
     SELECT db_now,CASE WHEN ? IS NULL THEN db_now ELSE ? END AS cutoff FROM clock`,
  ).bind(requestedAsOf ?? null, requestedAsOf ?? null)
    .first<{ db_now: string; cutoff: string }>();
  if (!clock) throw new Error('dual-horizon database clock unavailable');
  requireIsoTimestamp(clock.db_now, 'dual-horizon database now');
  try { requireIsoTimestamp(clock.cutoff, 'dual-horizon as_of'); }
  catch { throw new Error('invalid dual-horizon as_of'); }
  if (compareIsoTimestamps(clock.cutoff, clock.db_now) > 0) throw new Error('future dual-horizon as_of');

  const rows = await db.prepare(
    `SELECT date,decision_at,recorded_at,score,verdict,netliq_dir,vix_eod,qe_qt_regime,
            factors_json,factor_quality_json,model_version,config_hash,code_commit_sha,
            data_run_id,data_cutoff,created_at
     FROM model_snapshot_weekly
     WHERE decision_status='OK' AND pit_status='PIT'
       AND model_version<>'LEGACY_UNVERSIONED'
       AND decision_at IS NOT NULL AND recorded_at IS NOT NULL
       AND julianday(decision_at)<julianday(?) AND julianday(recorded_at)<julianday(?)
     ORDER BY julianday(decision_at),date
     LIMIT 601`,
  ).bind(clock.cutoff, clock.cutoff).all<Record<string, unknown>>();

  const snapshots = (rows.results ?? []).map(row => parseDualHorizonSnapshotRow(row));
  return {
    asOfCutoff: clock.cutoff,
    snapshots,
    provenance: { methodology: 'GOVERNED_WEEKLY_AS_OF', rowCount: snapshots.length },
  };
}
```

The pure composer performs the stricter eight-factor and nested factor-status validation. The database parser returns the camel-case interface above and never substitutes defaults.

- [ ] **Step 4: Extend the existing PIT series query without changing its visibility policy**

Change the SQL filter and row union from three to four IDs:

```ts
WHERE raw.series_id IN ('WALCL','WDTGAL','WTREGEN','RRPONTSYD')
```

and initialize:

```ts
const seriesMap: SeriesMap = { WALCL: [], WDTGAL: [], WTREGEN: [], RRPONTSYD: [] };
```

Keep the existing latest-vintage ordering, override cutoff, release cutoff, tradable cutoff, and fetched cutoff byte-for-byte unchanged.

- [ ] **Step 5: Run database, no-lookahead, and existing liquidity-structure tests**

Run:

```bash
env -u NODE_OPTIONS PATH=/home/ubuntu/.nvm/versions/node/v22.22.0/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin npx vitest run test/dual-horizon-db.test.ts test/policy-regime-db.test.ts test/pit-db.test.ts test/pit-snapshot-db.test.ts
```

Expected: all selected tests PASS; equality cutoffs remain invisible.

- [ ] **Step 6: Commit the read-only input layer**

```bash
git add src/db.ts test/dual-horizon-db.test.ts
git commit -m "feat: load dual-horizon point-in-time inputs"
```

---

### Task 3: Compose the Shadow result with frozen PR-11 Raw/Smooth mechanics

**Files:**
- Modify: `src/dual-horizon-confidence.ts`
- Modify: `test/dual-horizon-confidence.test.ts`

**Interfaces:**
- Consumes: `buildWeeklyNetLiquidity()` and `buildContinuousChallenger()` from `scripts/netliq-challenger.mjs`, plus `DualHorizonSnapshotInputs` and `LiquidityStructureSeriesInputs`.
- Produces: `buildDualHorizonShadow(snapshotInputs, liquidityInputs): DualHorizonShadowResult`.

- [ ] **Step 1: Add failing parity, no-lookahead, divergence, and incomplete tests**

```ts
import {
  buildContinuousChallenger,
  buildWeeklyNetLiquidity,
} from '../scripts/netliq-challenger.mjs';
import { buildDualHorizonShadow } from '../src/dual-horizon-confidence';

it('matches the frozen PR-11 Raw/Smooth direction from the same synthetic history', () => {
  const rawUnits = syntheticResearchSeries(220);
  const frozen = buildContinuousChallenger(buildWeeklyNetLiquidity(rawUnits)).at(-1)!;
  const input = dualInputFromRawUnits(rawUnits);
  const result = buildDualHorizonShadow(input.snapshots, input.liquidity);
  expect(result.status).toBe('OK');
  if (result.status !== 'OK') return;
  expect(result.rawSmooth).toMatchObject({
    agreement: frozen.agreement.confidence,
    rawLatent: frozen.raw.latent,
    smoothLatent: frozen.smooth.latent,
  });
});

it('does not change an old cutoff result when future observations are appended', () => {
  const rawUnits = syntheticResearchSeries(220);
  const base = dualInputFromRawUnits(rawUnits);
  const before = buildDualHorizonShadow(base.snapshots, base.liquidity);
  const after = buildDualHorizonShadow(base.snapshots, {
    ...base.liquidity,
    seriesMap: appendFutureLiquidity(base.liquidity.seriesMap, base.liquidity.decisionDate),
  });
  expect(after).toEqual(before);
});

it('allows the four-week tactical score to diverge while preserving the strategic score', () => {
  const input = divergentFourAndThirteenWeekInput();
  const result = buildDualHorizonShadow(input.snapshots, input.liquidity);
  expect(result).toMatchObject({
    status: 'OK',
    strategicScore: input.snapshots.snapshots.at(-1)!.score,
    championChanged: false,
  });
  if (result.status !== 'OK') return;
  expect(result.tacticalFactors.netliqTrend)
    .not.toBe(input.snapshots.snapshots.at(-1)!.factors.netliqTrend);
  expect(result.formalFactors).toEqual(input.snapshots.snapshots.at(-1)!.factors);
});

it('fails closed for insufficient Raw/Smooth history without inventing confidence', () => {
  const input = dualInputFromRawUnits(syntheticResearchSeries(20));
  expect(buildDualHorizonShadow(input.snapshots, input.liquidity)).toMatchObject({
    status: 'DATA_INCOMPLETE',
    reasons: expect.arrayContaining(['MISSING_RAW_SMOOTH_HISTORY']),
    championChanged: false,
  });
});
```

- [ ] **Step 2: Run the focused test and observe missing-composer failures**

Run:

```bash
env -u NODE_OPTIONS PATH=/home/ubuntu/.nvm/versions/node/v22.22.0/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin npx vitest run test/dual-horizon-confidence.test.ts
```

Expected: FAIL because `buildDualHorizonShadow` and its result type are absent.

- [ ] **Step 3: Add the PR-11 adapter**

```ts
import {
  buildContinuousChallenger,
  buildWeeklyNetLiquidity,
} from '../scripts/netliq-challenger.mjs';
import { SERIES } from './config';
import { asOfFresh, scoreNetliqTrend } from './metrics';
import { isPortfolioDirection, isPortfolioVerdict, mapPortfolioPolicy, snapshotVixStressStatus } from './portfolio-policy';
import type { DualHorizonSnapshotInputs, LiquidityStructureSeriesInputs } from './db';

function researchRawUnits(seriesMap: Record<string, Array<{ date: string; value: number }>>) {
  return {
    WALCL: (seriesMap.WALCL ?? []).map(row => ({ ...row, value: row.value * 1_000 })),
    WDTGAL: (seriesMap.WDTGAL ?? []).map(row => ({ ...row, value: row.value * 1_000 })),
    WTREGEN: (seriesMap.WTREGEN ?? []).map(row => ({ ...row, value: row.value * 1_000 })),
    RRPONTSYD: (seriesMap.RRPONTSYD ?? []).map(row => ({ ...row })),
  };
}

export function rawSmoothAtDecision(
  seriesMap: Record<string, Array<{ date: string; value: number }>>,
  decisionDate: string,
) {
  const points = buildWeeklyNetLiquidity(researchRawUnits(seriesMap))
    .filter(point => point.availableDate <= decisionDate);
  const latest = buildContinuousChallenger(points).at(-1);
  if (!latest || !Number.isFinite(latest.raw.latent) || !Number.isFinite(latest.smooth.latent)) {
    return { status: 'DATA_INCOMPLETE' as const, reason: 'MISSING_RAW_SMOOTH_HISTORY' as const };
  }
  return {
    status: 'OK' as const,
    agreement: latest.agreement.confidence as RawSmoothAgreement,
    rawLatent: latest.raw.latent as number,
    smoothLatent: latest.smooth.latent as number,
    observationDate: latest.observationDate,
    availableDate: latest.availableDate,
    sampleCount: points.length,
  };
}
```

- [ ] **Step 4: Add the discriminated result types and fail-closed helpers**

```ts
export type DualHorizonShadowResult =
  | {
      status: 'OK';
      protocol: 'DUAL_HORIZON_CONFIDENCE_SHADOW_V1';
      asOf: string;
      snapshotDate: string;
      modelVersion: string;
      configHash: string;
      strategicScore: number;
      tacticalScore: number;
      formalFactors: Record<string, number>;
      tacticalFactors: Record<string, number>;
      confidence: number;
      confidenceComponents: {
        completeness: number;
        freshness: number;
        regimeSample: number;
        majorFactorAgreement: number;
        rawSmoothAgreement: number;
      };
      baseExposure: number;
      shadowAdjustment: number;
      shadowTargetExposure: number;
      rawSmooth: {
        agreement: RawSmoothAgreement;
        rawLatent: number;
        smoothLatent: number;
        observationDate: string;
        availableDate: string;
        sampleCount: number;
      };
      reasons: string[];
      championChanged: false;
    }
  | {
      status: 'DATA_INCOMPLETE';
      protocol: 'DUAL_HORIZON_CONFIDENCE_SHADOW_V1';
      asOf: string;
      reasons: DualHorizonIncompleteReason[];
      availableDiagnostics: Record<string, unknown>;
      championChanged: false;
    };

function incomplete(
  asOf: string,
  reason: DualHorizonIncompleteReason,
  availableDiagnostics: Record<string, unknown> = {},
): DualHorizonShadowResult {
  return {
    status: 'DATA_INCOMPLETE',
    protocol: DUAL_HORIZON_PROTOCOL.protocol,
    asOf,
    reasons: [reason],
    availableDiagnostics,
    championChanged: false,
  };
}

function tacticalReason(score: number) {
  return score >= 60 ? 'TACTICAL_UP' : score <= 40 ? 'TACTICAL_DOWN' : 'TACTICAL_NEUTRAL';
}
```

- [ ] **Step 5: Add production-compatible tactical history construction**

```ts
function tacticalRawLevels(
  seriesMap: Record<string, Array<{ date: string; value: number }>>,
  decisionDate: string,
) {
  const anchors = (seriesMap.WALCL ?? []).filter(row => row.date <= decisionDate).slice(-5);
  if (anchors.length !== 5) return null;
  const points = anchors.map(walcl => {
    const tga = asOfFresh(seriesMap.WDTGAL ?? [], walcl.date, SERIES.WDTGAL);
    const rrp = asOfFresh(seriesMap.RRPONTSYD ?? [], walcl.date, SERIES.RRPONTSYD);
    return tga.value != null && rrp.value != null
      ? { date: walcl.date, value: walcl.value - tga.value - rrp.value }
      : null;
  }).filter((row): row is { date: string; value: number } => row != null);
  if (points.length !== anchors.length) return null;
  const invalidCadence = points.slice(1).some((point, index) => {
    const gap = dayGap(points[index].date, point.date);
    return gap < 5 || gap > 10;
  });
  return invalidCadence ? null : points;
}
```

This helper matches the current production raw-net-liquidity alignment: WALCL anchors, latest cutoff-visible TGA/RRP at or before each anchor, billions already normalized by ingestion, and weekly cadence 5–10 days. The separate Raw/Smooth adapter retains PR-11's seven-day conservative availability bound.

- [ ] **Step 6: Add fail-closed composition**

`buildDualHorizonShadow()` must perform these exact actions in this order:

```ts
export function buildDualHorizonShadow(
  snapshotsInput: DualHorizonSnapshotInputs,
  liquidityInput: LiquidityStructureSeriesInputs,
): DualHorizonShadowResult {
  if (snapshotsInput.asOfCutoff !== liquidityInput.asOfCutoff) {
    return incomplete(snapshotsInput.asOfCutoff, 'AS_OF_CUTOFF_MISMATCH');
  }
  if (snapshotsInput.snapshots.length === 0) {
    return incomplete(snapshotsInput.asOfCutoff, 'NO_GOVERNED_FORMAL_SNAPSHOT');
  }
  if (snapshotsInput.snapshots.length > 600) {
    return incomplete(snapshotsInput.asOfCutoff, 'SNAPSHOT_WORK_LIMIT_EXCEEDED');
  }
  const selected = snapshotsInput.snapshots.at(-1)!;
  if (!isPortfolioVerdict(selected.verdict) || !isPortfolioDirection(selected.netliqDir)) {
    return incomplete(snapshotsInput.asOfCutoff, 'FORMAL_SNAPSHOT_INVALID');
  }

  const rawSmooth = rawSmoothAtDecision(liquidityInput.seriesMap, liquidityInput.decisionDate);
  if (rawSmooth.status !== 'OK') return incomplete(snapshotsInput.asOfCutoff, rawSmooth.reason);
  const recent = tacticalRawLevels(liquidityInput.seriesMap, liquidityInput.decisionDate);
  if (!recent) {
    return incomplete(snapshotsInput.asOfCutoff, 'MISSING_TACTICAL_HISTORY');
  }

  const tacticalNetliqTrend = scoreNetliqTrend(recent.map(point => point.value), 4);
  const tactical = scoreTacticalCohort(selected.factors as Record<string, number>, tacticalNetliqTrend);
  if (tactical.status !== 'OK') return incomplete(snapshotsInput.asOfCutoff, tactical.reason);
  const factorStatuses = statusesFromPersistedFactorResults(selected.factorResults);
  const sameRegimeSampleCount = snapshotsInput.snapshots.slice(0, -1).filter(row =>
    row.qeQtRegime === selected.qeQtRegime
    && row.modelVersion === selected.modelVersion
    && row.configHash === selected.configHash).length;
  const confidence = computeDualHorizonConfidence({
    factorStatuses,
    tacticalFactors: tactical.factors,
    sameRegimeSampleCount,
    rawSmooth: rawSmooth.agreement,
  });
  if (confidence.status !== 'OK') return incomplete(snapshotsInput.asOfCutoff, confidence.reason);

  const formalPolicy = mapPortfolioPolicy({
    score: selected.score,
    verdict: selected.verdict,
    netliqDir: selected.netliqDir,
    stressStatus: snapshotVixStressStatus(selected.snapshotVixEod),
  });
  const shadow = mapShadowExposure(formalPolicy.targetExposure, tactical.score, confidence.confidence);
  const reasons = [tacticalReason(tactical.score)];
  if (shadow.unguardedAdjustment > 0 && shadow.shadowAdjustment === 0) {
    reasons.push('UPWARD_ADJUSTMENT_BLOCKED_LOW_CONFIDENCE');
  }
  if (confidence.confidence < 40) reasons.push('LOW_CONFIDENCE_EXPOSURE_CAP');
  reasons.push(`RAW_SMOOTH_${rawSmooth.agreement}`);
  return {
    status: 'OK',
    protocol: DUAL_HORIZON_PROTOCOL.protocol,
    asOf: snapshotsInput.asOfCutoff,
    snapshotDate: selected.date,
    modelVersion: selected.modelVersion,
    configHash: selected.configHash,
    strategicScore: selected.score,
    tacticalScore: tactical.score,
    formalFactors: selected.factors as Record<string, number>,
    tacticalFactors: tactical.factors,
    confidence: confidence.confidence,
    confidenceComponents: confidence.components,
    baseExposure: formalPolicy.targetExposure,
    shadowAdjustment: shadow.shadowAdjustment,
    shadowTargetExposure: shadow.shadowTargetExposure,
    rawSmooth,
    reasons,
    championChanged: false,
  };
}
```

`statusesFromPersistedFactorResults()` accepts only the four literal statuses for every positive-weight factor. `incomplete()` returns deterministic reason arrays and `championChanged: false`; it does not emit tactical exposure.

- [ ] **Step 7: Run focused tests, TypeScript, and lint**

Run:

```bash
env -u NODE_OPTIONS PATH=/home/ubuntu/.nvm/versions/node/v22.22.0/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin npx vitest run test/dual-horizon-confidence.test.ts
env -u NODE_OPTIONS PATH=/home/ubuntu/.nvm/versions/node/v22.22.0/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin npx tsc --noEmit
env -u NODE_OPTIONS PATH=/home/ubuntu/.nvm/versions/node/v22.22.0/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin npm run lint
```

Expected: all commands exit 0.

- [ ] **Step 8: Commit the composer**

```bash
git add src/dual-horizon-confidence.ts test/dual-horizon-confidence.test.ts
git commit -m "feat: compose dual-horizon shadow result"
```

---

### Task 4: Expose the read-only v1 endpoint

**Files:**
- Modify: `src/worker.ts`
- Modify: `test/worker.test.ts`

**Interfaces:**
- Consumes: `loadDualHorizonSnapshotInputs()`, `loadLiquidityStructureSeries()`, and `buildDualHorizonShadow()`.
- Produces: `GET /api/v1/challengers/dual-horizon?as_of=<ISO instant>`.

- [ ] **Step 1: Add failing route tests and mocks**

```ts
it('exposes dual-horizon Shadow analysis without changing the Champion response', async () => {
  dbState.dualHorizonSnapshotInputs = completeDualHorizonSnapshotInputs();
  dbState.liquidityStructureInputs = completeDualHorizonLiquidityInputs();
  const championBefore = await worker.fetch(new Request('https://example.test/api/snapshot'), env);
  const championBodyBefore = await championBefore.json();

  const response = await worker.fetch(new Request(
    'https://example.test/api/v1/challengers/dual-horizon?as_of=2030-01-01T00%3A00%3A00Z',
  ), env);
  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toMatchObject({
    api_version: 'v1',
    challenger_id: 'DUAL_HORIZON_CONFIDENCE_SHADOW_V1',
    mode: 'SHADOW_ONLY',
    champion_change: false,
    status: 'OK',
    result: {
      status: 'OK',
      championChanged: false,
      strategicScore: 61,
    },
  });

  const championAfter = await worker.fetch(new Request('https://example.test/api/snapshot'), env);
  expect(await championAfter.json()).toEqual(championBodyBefore);
});

it('pins both dual-horizon loaders to one database-resolved cutoff', async () => {
  await worker.fetch(new Request('https://example.test/api/v1/challengers/dual-horizon'), env);
  expect(vi.mocked(loadDualHorizonSnapshotInputs)).toHaveBeenCalledWith(env.DB, undefined);
  expect(vi.mocked(loadLiquidityStructureSeries)).toHaveBeenCalledWith(
    env.DB, dbState.dualHorizonSnapshotInputs.asOfCutoff,
  );
});

it('returns typed invalid_as_of and redacts loader failures', async () => {
  vi.mocked(loadDualHorizonSnapshotInputs).mockRejectedValueOnce(new Error('invalid dual-horizon as_of'));
  const invalid = await worker.fetch(new Request(
    'https://example.test/api/v1/challengers/dual-horizon?as_of=bad',
  ), env);
  expect(invalid.status).toBe(400);
  await expect(invalid.json()).resolves.toMatchObject({ error_code: 'INVALID_AS_OF' });

  const errorSink = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.mocked(loadDualHorizonSnapshotInputs)
    .mockRejectedValueOnce(new Error('authorization=Bearer super-secret'));
  const unavailable = await worker.fetch(new Request(
    'https://example.test/api/v1/challengers/dual-horizon',
  ), env);
  expect(await unavailable.json()).toMatchObject({
    status: 'DATA_INCOMPLETE', reason: 'INPUT_LOAD_FAILED', champion_change: false,
  });
  expect(errorSink.mock.calls.at(-1)?.[0]).not.toMatch(/super-secret/);
});
```

- [ ] **Step 2: Run the worker test and observe the missing-route failure**

Run:

```bash
env -u NODE_OPTIONS PATH=/home/ubuntu/.nvm/versions/node/v22.22.0/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin npx vitest run test/worker.test.ts
```

Expected: new route assertions FAIL while existing route tests remain green.

- [ ] **Step 3: Add imports and the route**

```ts
if (p === '/api/v1/challengers/dual-horizon') {
  const requestedAsOf = url.searchParams.has('as_of') ? url.searchParams.get('as_of')! : undefined;
  try {
    const snapshots = await loadDualHorizonSnapshotInputs(env.DB, requestedAsOf);
    const liquidity = await loadLiquidityStructureSeries(env.DB, snapshots.asOfCutoff);
    const result = buildDualHorizonShadow(snapshots, liquidity);
    return json({
      api_version: 'v1',
      challenger_id: DUAL_HORIZON_PROTOCOL.protocol,
      mode: DUAL_HORIZON_PROTOCOL.mode,
      champion_change: false,
      status: result.status,
      reason: result.status === 'OK' ? null : result.reasons[0] ?? 'DATA_INCOMPLETE',
      as_of_cutoff: snapshots.asOfCutoff,
      protocol: DUAL_HORIZON_PROTOCOL,
      provenance: {
        snapshots: snapshots.provenance,
        liquidity: liquidity.provenance,
      },
      result,
    });
  } catch (error) {
    const message = String((error as Error)?.message ?? error);
    if (/^(?:invalid|future) (?:dual-horizon|liquidity-structure) as_of$/i.test(message)) {
      return errorJson(requestId, 'invalid_as_of', 'INVALID_AS_OF', 400);
    }
    structuredLog('dual_horizon_failure', {
      request_id: requestId, reason: 'INPUT_LOAD_FAILED', error: message,
    }, console.error);
    return json({
      api_version: 'v1',
      challenger_id: DUAL_HORIZON_PROTOCOL.protocol,
      mode: 'SHADOW_ONLY',
      champion_change: false,
      status: 'DATA_INCOMPLETE',
      reason: 'INPUT_LOAD_FAILED',
      as_of_cutoff: requestedAsOf ?? null,
      protocol: DUAL_HORIZON_PROTOCOL,
      provenance: null,
      result: null,
    });
  }
}
```

Use the existing structured logger so secrets are sanitized. Do not add an in-memory cache or any write.

- [ ] **Step 4: Run worker, core, and type tests**

Run:

```bash
env -u NODE_OPTIONS PATH=/home/ubuntu/.nvm/versions/node/v22.22.0/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin npx vitest run test/worker.test.ts test/dual-horizon-confidence.test.ts test/dual-horizon-db.test.ts
env -u NODE_OPTIONS PATH=/home/ubuntu/.nvm/versions/node/v22.22.0/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin npx tsc --noEmit
```

Expected: all selected tests PASS and TypeScript exits 0.

- [ ] **Step 5: Commit the API**

```bash
git add src/worker.ts test/worker.test.ts
git commit -m "feat: expose dual-horizon shadow endpoint"
```

---

### Task 5: Render a clearly separated Shadow card

**Files:**
- Modify: `public/index.html`
- Modify: `public/app.js`
- Modify: `public/styles.css`
- Modify: `test/ui-assets.test.ts`

**Interfaces:**
- Consumes: the v1 dual-horizon response from Task 4 and existing safe `rbEsc`, `rbMaybeNum`, and `rbMaybePct` render helpers.
- Produces: `renderDualHorizonShadow()` and `fetchDualHorizonShadow()`.

- [ ] **Step 1: Add failing static and adversarial rendering tests**

```ts
it('renders dual-horizon analysis as Shadow and never as the formal recommendation', () => {
  const html = read('public/index.html');
  const js = read('public/app.js');
  expect(html).toContain('id="dual-horizon-card"');
  expect(html).toContain('DUAL_HORIZON_CONFIDENCE_SHADOW_V1');
  expect(js).toContain("fetch('/api/v1/challengers/dual-horizon')");
  expect(js).toContain('renderDualHorizonShadow');
  expect(js).toContain('Shadow only · Champion unchanged');
  expect(js).toContain('战略 13 周');
  expect(js).toContain('战术 4 周');
  expect(js).not.toContain('正式建议：采用 Shadow 仓位');

  const start = js.indexOf('function renderDualHorizonShadow');
  const end = js.indexOf('async function fetchDualHorizonShadow');
  const render = new Function(
    `${js.slice(js.indexOf('function rbFinite'), end)}; return renderDualHorizonShadow;`,
  )() as (value: unknown) => string;
  const malicious = '<img src=x onerror=globalThis.pwned=true>';
  const rendered = render({
    status: 'DATA_INCOMPLETE', reason: malicious,
    result: { status: 'DATA_INCOMPLETE', reasons: [malicious] },
  });
  expect(rendered).not.toContain('<img');
  expect(rendered).toContain('&lt;img');
});
```

- [ ] **Step 2: Run the UI test and observe missing-card failures**

Run:

```bash
env -u NODE_OPTIONS PATH=/home/ubuntu/.nvm/versions/node/v22.22.0/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin npx vitest run test/ui-assets.test.ts
```

Expected: FAIL because the new card, fetch, and renderer do not exist.

- [ ] **Step 3: Add the card and mobile order**

Insert after the liquidity-structure card:

```html
<section class="card collapsible" id="dual-horizon-card" style="display:none">
  <h2>双周期评分与模型置信度 · SHADOW</h2>
  <p class="muted">DUAL_HORIZON_CONFIDENCE_SHADOW_V1 · 战略 13 周 / 战术 4 周 · Champion 不变</p>
  <div id="dual-horizon-body"></div>
</section>
```

In the mobile rule:

```css
#dual-horizon-card{order:11}
#event-backtest-card{order:12}
```

- [ ] **Step 4: Add the safe renderer and fetch**

```js
function renderDualHorizonShadow(payload) {
  const result = payload && payload.result;
  const status = rbEsc(payload?.status || result?.status || 'DATA_INCOMPLETE');
  const header = `<div class="rb-concl">${status} · Shadow only · Champion unchanged</div>`;
  if (!result || result.status !== 'OK') {
    const reasons = Array.isArray(result?.reasons) ? result.reasons.join(' · ') : payload?.reason;
    return header + `<p class="rb-note">数据不完整：${rbEsc(reasons || 'INPUT_UNAVAILABLE')}</p>`;
  }
  const components = result.confidenceComponents || {};
  const reason = Array.isArray(result.reasons) ? result.reasons.join(' · ') : '—';
  return header
    + `<div class="rb-stat"><span class="k">战略 13 周 / 战术 4 周</span><span class="v">${rbMaybeNum(result.strategicScore)} / ${rbMaybeNum(result.tacticalScore)}</span></div>`
    + `<div class="rb-stat"><span class="k">模型置信度</span><span class="v">${rbMaybeNum(result.confidence)} / 100</span></div>`
    + `<div class="rb-stat"><span class="k">正式基础敞口 / Shadow 敞口</span><span class="v">${rbMaybePct(result.baseExposure)} / ${rbMaybePct(result.shadowTargetExposure)}</span></div>`
    + `<div class="rb-stat"><span class="k">完整 / 新鲜 / regime 样本</span><span class="v">${rbMaybeNum(components.completeness)} / ${rbMaybeNum(components.freshness)} / ${rbMaybeNum(components.regimeSample)}</span></div>`
    + `<div class="rb-stat"><span class="k">主要因子 / Raw-Smooth</span><span class="v">${rbMaybeNum(components.majorFactorAgreement)} / ${rbMaybeNum(components.rawSmoothAgreement)}</span></div>`
    + `<p class="rb-note">假设性微调，不是正式建议；${rbEsc(reason)}</p>`;
}

async function fetchDualHorizonShadow() {
  const card = document.getElementById('dual-horizon-card');
  const body = document.getElementById('dual-horizon-body');
  if (!card || !body) return;
  try {
    const result = await fetch('/api/v1/challengers/dual-horizon').then(response => response.json());
    body.innerHTML = renderDualHorizonShadow(result);
  } catch {
    body.innerHTML = '<p class="rb-note">双周期 Shadow 加载失败，稍后重试</p>';
  }
  card.style.display = '';
}
```

Call `fetchDualHorizonShadow()` beside the existing challenger fetches in `main()`.

- [ ] **Step 5: Run UI, worker, and model-language tests**

Run:

```bash
env -u NODE_OPTIONS PATH=/home/ubuntu/.nvm/versions/node/v22.22.0/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin npx vitest run test/ui-assets.test.ts test/ui-channels.test.ts test/model-language.test.ts test/worker.test.ts
```

Expected: all selected tests PASS.

- [ ] **Step 6: Commit the Shadow UI**

```bash
git add public/index.html public/app.js public/styles.css test/ui-assets.test.ts
git commit -m "feat: render dual-horizon shadow card"
```

---

### Task 6: Prove no-lookahead and Champion non-regression

**Files:**
- Modify: `test/dual-horizon-confidence.test.ts`
- Modify: `test/dual-horizon-db.test.ts`
- Modify: `test/production-governance.test.ts`

**Interfaces:**
- Consumes: completed core, database loader, API, and existing Champion identity checks.
- Produces: regression evidence required to close PR-18.

- [ ] **Step 1: Add the final negative regression tests**

Add assertions that:

```ts
expect(DUAL_HORIZON_PROTOCOL.championChanged).toBe(false);
expect(championConfigDigest()).toBe('17ad1ca8854b0fbd8e56d6255b7ee2f4fe8a85ae1a95a328ade46ffdff02a0cf');
expect(CHAMPION_MODEL_VERSION).toBe('champion-v1.0.0');
expect(await db.prepare('SELECT COUNT(*) AS n FROM nowcast_snapshot_daily').first())
  .toEqual({ n: 1 });
expect(resultBeforeLateRevision).toEqual(resultAfterLateRevisionAtOldCutoff);
expect(formalSnapshotAfterShadowRead).toEqual(formalSnapshotBeforeShadowRead);
```

The D1 test must insert a later vintage and a later override, replay the old cutoff, and compare the complete loader result. The governance test must assert that production imports do not call `buildDualHorizonShadow`; only `worker.ts` may expose it through the challenger route.

- [ ] **Step 2: Run the new regression set**

Run:

```bash
env -u NODE_OPTIONS PATH=/home/ubuntu/.nvm/versions/node/v22.22.0/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin npx vitest run test/dual-horizon-confidence.test.ts test/dual-horizon-db.test.ts test/production-governance.test.ts test/service.test.ts
```

Expected: all selected tests PASS, including existing full/incremental rebuild consistency.

- [ ] **Step 3: Run the repository correctness gates**

Run:

```bash
env -u NODE_OPTIONS PATH=/home/ubuntu/.nvm/versions/node/v22.22.0/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin npm run test:correctness
env -u NODE_OPTIONS PATH=/home/ubuntu/.nvm/versions/node/v22.22.0/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin npm run test:no-lookahead
env -u NODE_OPTIONS PATH=/home/ubuntu/.nvm/versions/node/v22.22.0/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin npm run test:rebuild-consistency
```

Expected: every gate exits 0.

- [ ] **Step 4: Commit the regression evidence**

```bash
git add test/dual-horizon-confidence.test.ts test/dual-horizon-db.test.ts test/production-governance.test.ts
git commit -m "test: prove dual-horizon shadow isolation"
```

---

### Task 7: Final verification, independent review, and PR report

**Files:**
- Create: `docs/pr-reports/PR-18.md`
- Modify: `public/md/CODEX_PROFESSIONAL_UPGRADE_PLAN.md`

**Interfaces:**
- Consumes: reviewed implementation commits and fresh verification output.
- Produces: auditable PR-18 closure without deployment.

- [ ] **Step 1: Run the complete required verification from a clean tree**

Run:

```bash
env -u NODE_OPTIONS PATH=/home/ubuntu/.nvm/versions/node/v22.22.0/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin npm test
env -u NODE_OPTIONS PATH=/home/ubuntu/.nvm/versions/node/v22.22.0/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin npx tsc --noEmit
env -u NODE_OPTIONS PATH=/home/ubuntu/.nvm/versions/node/v22.22.0/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin npm run lint
```

Expected: all test files and tests PASS; TypeScript and lint exit 0.

- [ ] **Step 2: Request independent specification and code reviews**

Use the requesting-code-review workflow twice:

- specification review compares the implementation against the confirmed design and every Global Constraint;
- code review checks the full PR-18 commit range for correctness, security, PIT/no-lookahead behavior, Champion isolation, and test sufficiency.

Both reviews must report zero Critical and zero Important findings. Fix findings with a failing regression test first, rerun affected and full gates, commit each correction, and repeat both reviews until Ready.

- [ ] **Step 3: Write the PR report**

Create `docs/pr-reports/PR-18.md` with these sections. Populate the file list from `git diff --name-only 05a9aa8..HEAD`; populate every test count and review verdict from Step 1 and Step 2 output; copy the frozen values directly from the confirmed design:

```markdown
# PR-18 — Dual-Horizon Score and Confidence

## Summary
Shadow-only 13-week strategic / 4-week tactical analysis with five-component confidence.

## Files Changed
List every changed path and its responsibility.

## Frozen Behavior
Record the unchanged Champion identity, all eight literal weights, 4/13-week horizons, 40/60 tactical boundaries, five equal confidence components, strict PIT cutoff, and 40/60 confidence guards.

## Test Results
Record full and focused test totals, correctness/no-lookahead/rebuild totals, TypeScript, lint, and both final review verdicts.

## Known Limitations
Record heuristic thresholds, regime count not being forecast skill, PR-11 evidence-class distinction, no unseen OOS, no promotion, and any observed channel-mixing issue.

## Rollback
Revert the PR-18 commit range; there is no migration or data repair.

## Operations
No deployment, remote database command, production write, or real alert was executed.
```

- [ ] **Step 4: Update the professional plan status**

Add the PR-18 status row and detailed PR-18 section only after reviews are Ready. Record the exact commit range, test counts, `Champion 不变`, `未部署`, the Raw/Smooth PIT evidence-class limitation, and the absence of unseen OOS promotion evidence.

- [ ] **Step 5: Run documentation and diff hygiene checks**

Run:

```bash
rg -n '\[[^]]+\]' docs/pr-reports/PR-18.md
git diff --check
git status --short
```

Expected: the search returns no matches, `git diff --check` exits 0, and status lists only the intended report/plan edits.

- [ ] **Step 6: Commit closure documentation**

```bash
git add docs/pr-reports/PR-18.md public/md/CODEX_PROFESSIONAL_UPGRADE_PLAN.md
git commit -m "docs: record PR-18 verification"
```

- [ ] **Step 7: Re-run the complete verification after the documentation commit**

Run:

```bash
env -u NODE_OPTIONS PATH=/home/ubuntu/.nvm/versions/node/v22.22.0/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin npm test
env -u NODE_OPTIONS PATH=/home/ubuntu/.nvm/versions/node/v22.22.0/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin npx tsc --noEmit
env -u NODE_OPTIONS PATH=/home/ubuntu/.nvm/versions/node/v22.22.0/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin npm run lint
git status --short
```

Expected: all commands exit 0 and the worktree is clean. Stop without deploying or touching any remote database.
