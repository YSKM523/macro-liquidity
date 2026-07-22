import type { LivePrices, LiveStress } from './prices';

export class TypedLiveDataFailure<T> extends Error {
  constructor(message: string, public readonly payload: T) {
    super(message);
    this.name = 'TypedLiveDataFailure';
  }
}

export function assertCacheableLivePrices(prices: LivePrices): LivePrices {
  const failed = Object.entries(prices.quotes)
    .filter(([, quote]) => quote.status !== 'OK')
    .map(([symbol, quote]) => `${symbol}:${quote.status}`);
  if (failed.length > 0) {
    throw new TypedLiveDataFailure(`live provider failure: ${failed.join(',')}`, prices);
  }
  return prices;
}

export function assertCacheableStress(stress: LiveStress): LiveStress {
  if (stress.status === 'UNKNOWN') {
    throw new TypedLiveDataFailure('live stress is UNKNOWN and cannot refresh cache', stress);
  }
  return stress;
}

export function failClosedCachedStress(
  stress: LiveStress,
  cacheStatus: 'FRESH' | 'STALE' | 'FAILED',
): LiveStress {
  if (cacheStatus === 'FRESH') return stress;
  const marker = cacheStatus === 'STALE' ? 'LIVE_STRESS_CACHE_STALE' : 'LIVE_STRESS_REFRESH_FAILED';
  return {
    ...stress,
    status: 'UNKNOWN',
    stressed: false,
    reasons: [],
    unavailable: [...new Set([...stress.unavailable, marker])],
  };
}
