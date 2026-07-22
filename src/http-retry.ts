export type HttpFetcher = typeof fetch;

export interface HttpRetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  sleep?: (delayMs: number) => Promise<void>;
  random?: () => number;
}

const DEFAULT_MAX_ATTEMPTS = 3;
const MAX_ATTEMPTS = 5;
const DEFAULT_BASE_DELAY_MS = 10;
const DEFAULT_MAX_DELAY_MS = 100;
const MAX_DELAY_MS = 30_000;

const defaultSleep = (delayMs: number) => new Promise<void>(resolve => setTimeout(resolve, delayMs));

function boundedInteger(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.floor(value!)));
}

function retryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

function delayForAttempt(failedAttempt: number, options: HttpRetryOptions): number {
  const base = boundedInteger(options.baseDelayMs, DEFAULT_BASE_DELAY_MS, 0, MAX_DELAY_MS);
  const requestedCap = boundedInteger(options.maxDelayMs, DEFAULT_MAX_DELAY_MS, 0, MAX_DELAY_MS);
  const cap = Math.max(base, requestedCap);
  const exponential = Math.min(cap, base * 2 ** (failedAttempt - 1));
  const random = Math.min(1, Math.max(0, options.random?.() ?? Math.random()));
  return Math.floor(exponential * random);
}

export async function fetchWithRetry(
  fetchFn: HttpFetcher,
  input: RequestInfo | URL,
  init?: RequestInit,
  options: HttpRetryOptions = {},
): Promise<Response> {
  const maxAttempts = boundedInteger(options.maxAttempts, DEFAULT_MAX_ATTEMPTS, 1, MAX_ATTEMPTS);
  const sleep = options.sleep ?? defaultSleep;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const response = await fetchFn(input, init);
      if (!retryableStatus(response.status) || attempt === maxAttempts) return response;
    } catch (error) {
      if (attempt === maxAttempts) throw error;
    }
    await sleep(delayForAttempt(attempt, options));
  }
  throw new Error('unreachable HTTP retry state');
}
