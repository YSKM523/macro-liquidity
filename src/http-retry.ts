export type HttpFetcher = typeof fetch;

export interface HttpAttemptBudget {
  readonly limit: number;
  readonly used: number;
  tryConsume(): boolean;
}

export class HttpAttemptBudgetExhaustedError extends Error {
  constructor(limit: number) {
    super(`HTTP attempt budget exhausted after ${limit} requests`);
    this.name = 'HttpAttemptBudgetExhaustedError';
  }
}

export class HttpAttemptTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`HTTP attempt timeout after ${timeoutMs}ms`);
    this.name = 'HttpAttemptTimeoutError';
  }
}

export interface HttpRetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  sleep?: (delayMs: number) => Promise<void>;
  random?: () => number;
  attemptTimeoutMs?: number;
  attemptBudget?: HttpAttemptBudget;
  setTimeoutFn?: (callback: () => void, delayMs: number) => unknown;
  clearTimeoutFn?: (timer: unknown) => void;
}

const DEFAULT_MAX_ATTEMPTS = 3;
const MAX_ATTEMPTS = 5;
const DEFAULT_BASE_DELAY_MS = 250;
const DEFAULT_MAX_DELAY_MS = 2_000;
const MAX_DELAY_MS = 30_000;
const DEFAULT_ATTEMPT_TIMEOUT_MS = 10_000;
const MAX_ATTEMPT_TIMEOUT_MS = 30_000;

const defaultSleep = (delayMs: number) => new Promise<void>(resolve => setTimeout(resolve, delayMs));

function boundedInteger(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  const candidate = Number.isFinite(value) ? Math.floor(value!) : fallback;
  return Math.min(maximum, Math.max(minimum, candidate));
}

function retryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

export async function releaseResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Connection cleanup is best-effort and must not replace the caller's HTTP outcome.
  }
}

export function createHttpAttemptBudget(limit: number): HttpAttemptBudget {
  const boundedLimit = boundedInteger(limit, 1, 1, 10_000);
  let used = 0;
  return {
    limit: boundedLimit,
    get used() { return used; },
    tryConsume() {
      if (used >= boundedLimit) return false;
      used += 1;
      return true;
    },
  };
}

function requestMethod(input: RequestInfo | URL, init?: RequestInit): string {
  if (init?.method) return init.method.toUpperCase();
  if (typeof Request !== 'undefined' && input instanceof Request) return input.method.toUpperCase();
  return 'GET';
}

async function fetchAttempt(
  fetchFn: HttpFetcher,
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  options: HttpRetryOptions,
): Promise<Response> {
  const timeoutMs = boundedInteger(
    options.attemptTimeoutMs, DEFAULT_ATTEMPT_TIMEOUT_MS, 1, MAX_ATTEMPT_TIMEOUT_MS,
  );
  const setTimer = options.setTimeoutFn ?? ((callback, delayMs) => setTimeout(callback, delayMs));
  const clearTimer = options.clearTimeoutFn ?? (timer => clearTimeout(timer as ReturnType<typeof setTimeout>));
  const controller = new AbortController();
  const callerSignal = init?.signal;
  if (callerSignal?.aborted) {
    throw callerSignal.reason ?? new DOMException('The operation was aborted', 'AbortError');
  }
  let rejectCallerAbort: ((reason?: unknown) => void) | undefined;
  const callerAbort = new Promise<Response>((_resolve, reject) => { rejectCallerAbort = reject; });
  const abortFromCaller = () => {
    const reason = callerSignal?.reason ?? new DOMException('The operation was aborted', 'AbortError');
    controller.abort(reason);
    rejectCallerAbort?.(reason);
  };
  callerSignal?.addEventListener('abort', abortFromCaller, { once: true });
  let timer: unknown;
  let ownedTimeoutReason: HttpAttemptTimeoutError | undefined;
  const timeout = new Promise<Response>((_resolve, reject) => {
    timer = setTimer(() => {
      const reason = new HttpAttemptTimeoutError(timeoutMs);
      ownedTimeoutReason = reason;
      // Settle timeout provenance first; abort-aware fetch implementations then reject with the same reason.
      reject(reason);
      controller.abort(reason);
    }, timeoutMs);
  });
  try {
    const request = fetchFn(input, { ...init, signal: controller.signal }).catch(error => {
      if (ownedTimeoutReason && controller.signal.reason === ownedTimeoutReason) throw ownedTimeoutReason;
      throw error;
    });
    return await Promise.race([
      request,
      timeout,
      callerAbort,
    ]);
  } finally {
    clearTimer(timer);
    callerSignal?.removeEventListener('abort', abortFromCaller);
  }
}

function delayForAttempt(failedAttempt: number, options: HttpRetryOptions): number {
  const cap = boundedInteger(options.maxDelayMs, DEFAULT_MAX_DELAY_MS, 0, MAX_DELAY_MS);
  const base = boundedInteger(options.baseDelayMs, DEFAULT_BASE_DELAY_MS, 0, cap);
  const exponential = Math.min(cap, base * 2 ** (failedAttempt - 1));
  const sample = options.random?.() ?? Math.random();
  const random = Number.isFinite(sample) ? Math.min(1, Math.max(0, sample)) : 0;
  return Math.floor(exponential * random);
}

export async function fetchWithRetry(
  fetchFn: HttpFetcher,
  input: RequestInfo | URL,
  init?: RequestInit,
  options: HttpRetryOptions = {},
): Promise<Response> {
  const method = requestMethod(input, init);
  if (method !== 'GET' && method !== 'HEAD') {
    throw new TypeError('fetchWithRetry supports GET or HEAD requests only');
  }
  const maxAttempts = boundedInteger(options.maxAttempts, DEFAULT_MAX_ATTEMPTS, 1, MAX_ATTEMPTS);
  const sleep = options.sleep ?? defaultSleep;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      if (options.attemptBudget && !options.attemptBudget.tryConsume()) {
        throw new HttpAttemptBudgetExhaustedError(options.attemptBudget.limit);
      }
      const response = await fetchAttempt(fetchFn, input, init, options);
      if (!retryableStatus(response.status) || attempt === maxAttempts) return response;
      await releaseResponseBody(response);
    } catch (error) {
      if (error instanceof HttpAttemptBudgetExhaustedError) throw error;
      if (init?.signal?.aborted) throw error;
      if (attempt === maxAttempts) throw error;
    }
    await sleep(delayForAttempt(attempt, options));
  }
  throw new Error('unreachable HTTP retry state');
}
