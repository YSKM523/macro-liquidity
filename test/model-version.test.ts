import { describe, expect, it } from 'vitest';
// @ts-ignore Vitest executes in Node.
import { readFileSync } from 'node:fs';
// @ts-ignore Vitest executes in Node.
import { createHash } from 'node:crypto';
import { CHAMPION_MODEL_CONFIG, EVENT_BACKTEST_ASSUMPTIONS } from '../src/config';
import {
  CHAMPION_MODEL_VERSION,
  canonicalChampionConfig,
  championConfigDigest,
  hashChampionConfig,
  resolveModelIdentity,
  validateCommitSha,
} from '../src/model-version';

describe('Champion model identity', () => {
  it('canonicalizes deterministically and produces a SHA-256 config hash', async () => {
    const first = await resolveModelIdentity({ CODE_COMMIT_SHA: '0123456789abcdef0123456789abcdef01234567' });
    const second = await resolveModelIdentity({ CODE_COMMIT_SHA: '0123456789abcdef0123456789abcdef01234567' });

    expect(canonicalChampionConfig()).toBe(canonicalChampionConfig());
    expect(first).toEqual(second);
    expect(first.modelVersion).toBe(CHAMPION_MODEL_VERSION);
    expect(first.configHash).toMatch(/^[a-f0-9]{64}$/);
    expect(first.codeCommitSha).toBe('0123456789abcdef0123456789abcdef01234567');
  });

  it('locks the complete Champion descriptor to a golden digest and Node crypto', () => {
    const canonical = canonicalChampionConfig();
    const nodeDigest = createHash('sha256').update(canonical).digest('hex');
    expect(championConfigDigest()).toBe(nodeDigest);
    expect(championConfigDigest()).toBe('17ad1ca8854b0fbd8e56d6255b7ee2f4fe8a85ae1a95a328ade46ffdff02a0cf');
    expect(Object.isFrozen(CHAMPION_MODEL_CONFIG)).toBe(true);
    expect(Object.isFrozen(CHAMPION_MODEL_CONFIG.scoring.credit)).toBe(true);
  });

  it('changes identity when any governed scoring input drifts', () => {
    const clone = JSON.parse(canonicalChampionConfig());
    clone.scoring.credit.fragilityPenalty += 1;
    expect(hashChampionConfig(clone)).not.toBe(championConfigDigest());
  });

  it('hashes every event-backtest behavior constant and reporting convention', () => {
    const governedNumbers = {
      legacyCompatibilityBullishScoreExclusive: 55,
      volatilityTargetLookbackSessions: 20,
      volatilityTargetAnnual: 0.10,
      volatilityTargetMaximumExposure: 1,
      movingAverageLookbackSessions: 200,
      annualizationSessions: 252,
      cashRatePercentDenominator: 100,
      cashDayCountDenominator: 360,
      basisPointsDenominator: 10_000,
    } as const;
    expect(EVENT_BACKTEST_ASSUMPTIONS).toMatchObject({
      ...governedNumbers,
      metricReturnConvention: 'CLOSE_TO_CLOSE_NET_NAV',
      volatilityEstimator: 'POPULATION_STANDARD_DEVIATION',
      downsideDeviationConvention: 'NEGATIVE_RETURNS_RMS_OVER_ALL_SESSIONS',
      riskAdjustedReturnConvention: 'ZERO_RISK_FREE_DAILY_MEAN',
      strategyMethodology: 'DASHBOARD_EXPOSURE_TIERS_V1',
      snapshotStressMethodology: 'PIT_SNAPSHOT_VIX_PROXY',
      timingComparisonMethodology: 'CUMULATIVE_RETURN_DIFFERENCE_VS_BETA_MATCHED_STATIC',
      buyHoldBenchmarkMethodology: 'SPX_BUY_HOLD',
      betaMatchedBenchmarkMethodology: 'STATIC_SPX_CASH_AVERAGE_BETA',
      volatilityTargetBenchmarkMethodology: 'PRIOR_20_SESSION_10PCT_VOL_TARGET_CAP_100',
      movingAverageBenchmarkMethodology: 'PRIOR_CLOSE_200DMA_RISK_CONTROL',
    });
    for (const [field, value] of Object.entries(governedNumbers)) {
      const clone = JSON.parse(canonicalChampionConfig());
      clone.eventBacktest[field] = value + 1;
      expect(hashChampionConfig(clone), field).not.toBe(championConfigDigest());
    }
  });

  it('never impersonates a commit when the deployment binding is absent or malformed', async () => {
    expect(validateCommitSha(undefined)).toBe('LOCAL_UNCONFIGURED');
    expect(validateCommitSha('main')).toBe('LOCAL_UNCONFIGURED');
    await expect(resolveModelIdentity({ CODE_COMMIT_SHA: 'main' })).resolves.toMatchObject({
      codeCommitSha: 'LOCAL_UNCONFIGURED',
    });
  });

  it('adds and conservatively backfills the complete snapshot identity contract', () => {
    const sql = readFileSync('migrations/0010_model_governance.sql', 'utf8');
    for (const table of ['model_snapshot_weekly', 'nowcast_snapshot_daily']) {
      expect(sql).toContain(`ALTER TABLE ${table} ADD COLUMN model_version`);
      expect(sql).toContain(`ALTER TABLE ${table} ADD COLUMN config_hash`);
      expect(sql).toContain(`ALTER TABLE ${table} ADD COLUMN code_commit_sha`);
      expect(sql).toContain(`ALTER TABLE ${table} ADD COLUMN created_at`);
      expect(sql).toMatch(new RegExp(`UPDATE ${table}[^;]+LEGACY_UNVERSIONED`, 's'));
    }
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS admin_audit_log');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS admin_rate_limit_buckets');
  });
});
