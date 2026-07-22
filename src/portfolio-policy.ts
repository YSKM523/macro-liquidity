import { STRESS, STRESS_SCORE_CEILING } from './config';

export type PortfolioVerdict = 'BULLISH' | 'NEUTRAL' | 'BEARISH';
export type PortfolioDirection = 'UP' | 'DOWN' | 'FLAT';
export type PortfolioStressStatus = 'NORMAL' | 'STRESSED' | 'UNKNOWN';
export type PortfolioTier =
  | 'STRONG_TAILWIND'
  | 'ORDINARY_TAILWIND'
  | 'NEUTRAL'
  | 'CAUTIOUS'
  | 'HEADWIND'
  | 'STRESS_BRAKE'
  | 'UNKNOWN_CAPPED';

export interface PortfolioPolicyInput {
  score: number;
  verdict: PortfolioVerdict;
  netliqDir: PortfolioDirection;
  stressStatus: PortfolioStressStatus;
}

export interface PortfolioPolicy {
  methodology: 'DASHBOARD_EXPOSURE_TIERS_V1';
  targetExposure: number;
  tier: PortfolioTier;
  stressApplied: boolean;
}

export function isPortfolioVerdict(value: unknown): value is PortfolioVerdict {
  return value === 'BULLISH' || value === 'NEUTRAL' || value === 'BEARISH';
}

export function isPortfolioDirection(value: unknown): value is PortfolioDirection {
  return value === 'UP' || value === 'DOWN' || value === 'FLAT';
}

export function officialPortfolioFieldIssue(input: {
  score: unknown;
  verdict: unknown;
  netliqDir: unknown;
  snapshotVixEod: unknown;
}): 'invalid official portfolio field' | null {
  if (typeof input.score !== 'number' || !Number.isFinite(input.score)) return 'invalid official portfolio field';
  if (!isPortfolioVerdict(input.verdict) || !isPortfolioDirection(input.netliqDir)) {
    return 'invalid official portfolio field';
  }
  if (input.snapshotVixEod !== null &&
    (typeof input.snapshotVixEod !== 'number' || !Number.isFinite(input.snapshotVixEod) || input.snapshotVixEod < 0)) {
    return 'invalid official portfolio field';
  }
  return null;
}

function basePolicy(input: PortfolioPolicyInput): Pick<PortfolioPolicy, 'targetExposure' | 'tier'> {
  if (input.verdict === 'BULLISH') {
    return input.netliqDir === 'DOWN'
      ? { targetExposure: 0.9, tier: 'ORDINARY_TAILWIND' }
      : { targetExposure: 1, tier: 'STRONG_TAILWIND' };
  }
  if (input.verdict === 'BEARISH') return { targetExposure: 0.25, tier: 'HEADWIND' };
  return input.score < 50
    ? { targetExposure: 0.5, tier: 'CAUTIOUS' }
    : { targetExposure: 0.75, tier: 'NEUTRAL' };
}

export function mapPortfolioPolicy(input: PortfolioPolicyInput): PortfolioPolicy {
  if (!Number.isFinite(input.score)) throw new Error('invalid portfolio policy score');
  const base = basePolicy(input);
  const stressApplied = input.stressStatus === 'STRESSED' && input.score < STRESS_SCORE_CEILING;
  if (stressApplied) {
    return { methodology: 'DASHBOARD_EXPOSURE_TIERS_V1', targetExposure: 0.25, tier: 'STRESS_BRAKE', stressApplied };
  }
  if (input.stressStatus === 'UNKNOWN' && base.targetExposure > 0.75) {
    return { methodology: 'DASHBOARD_EXPOSURE_TIERS_V1', targetExposure: 0.75, tier: 'UNKNOWN_CAPPED', stressApplied: false };
  }
  return { methodology: 'DASHBOARD_EXPOSURE_TIERS_V1', ...base, stressApplied: false };
}

export function snapshotVixStressStatus(vixEod: number | null): PortfolioStressStatus {
  if (vixEod == null || !Number.isFinite(vixEod)) return 'UNKNOWN';
  return vixEod >= STRESS.vix ? 'STRESSED' : 'NORMAL';
}
