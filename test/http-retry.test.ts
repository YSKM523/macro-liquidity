import { describe, expect, it, vi } from 'vitest';
import { HttpAttemptTimeoutError, fetchWithRetry } from '../src/http-retry';

describe('bounded HTTP retry policy', () => {
  it('retries 5xx and 429 with bounded exponential delays', async () => {
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(new Response('', { status: 503 }))
      .mockResolvedValueOnce(new Response('', { status: 429 }))
      .mockResolvedValueOnce(new Response('ok', { status: 200 }));
    const sleep = vi.fn(async (_delayMs: number) => undefined);

    const response = await fetchWithRetry(fetchFn, 'https://example.test', undefined, {
      maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 500, random: () => 1, sleep,
    });

    expect(response.status).toBe(200);
    expect(fetchFn).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls.map(([delay]) => delay)).toEqual([100, 200]);
  });

  it('caps delay and attempts even when callers request excessive values', async () => {
    const fetchFn = vi.fn(async () => new Response('', { status: 503 }));
    const sleep = vi.fn(async (_delayMs: number) => undefined);

    const response = await fetchWithRetry(fetchFn, 'https://example.test', undefined, {
      maxAttempts: 100, baseDelayMs: 20_000, maxDelayMs: 999_999, random: () => 1, sleep,
    });

    expect(response.status).toBe(503);
    expect(fetchFn).toHaveBeenCalledTimes(5);
    expect(sleep.mock.calls.map(([delay]) => delay)).toEqual([20_000, 30_000, 30_000, 30_000]);
  });

  it('honors a caller delay cap below the requested base delay', async () => {
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(new Response('', { status: 503 }))
      .mockResolvedValueOnce(new Response('', { status: 503 }))
      .mockResolvedValueOnce(new Response('', { status: 200 }));
    const sleep = vi.fn(async (_delayMs: number) => undefined);

    await fetchWithRetry(fetchFn, 'https://example.test', undefined, {
      baseDelayMs: 100, maxDelayMs: 25, random: () => 1, sleep,
    });

    expect(sleep.mock.calls.map(([delay]) => delay)).toEqual([25, 25]);
  });

  it('retries transport errors and rethrows the terminal error after exhaustion', async () => {
    const terminal = new TypeError('network unavailable');
    const fetchFn = vi.fn(async () => { throw terminal; });
    const sleep = vi.fn(async (_delayMs: number) => undefined);

    await expect(fetchWithRetry(fetchFn, 'https://example.test', undefined, {
      maxAttempts: 3, sleep, random: () => 0,
    })).rejects.toBe(terminal);
    expect(fetchFn).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it('returns a non-retryable 4xx immediately', async () => {
    const fetchFn = vi.fn(async () => new Response('', { status: 404 }));
    const sleep = vi.fn(async (_delayMs: number) => undefined);

    const response = await fetchWithRetry(fetchFn, 'https://example.test', undefined, { sleep });

    expect(response.status).toBe(404);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('gives every hung attempt an independent hard timeout and rejects after the bounded maximum', async () => {
    const signals: AbortSignal[] = [];
    const fetchFn = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      signals.push(init!.signal as AbortSignal);
      return new Promise<Response>(() => {});
    });
    const setTimeoutFn = vi.fn((callback: () => void) => {
      queueMicrotask(callback);
      return Symbol('timer');
    });
    const clearTimeoutFn = vi.fn();

    await expect(fetchWithRetry(fetchFn as typeof fetch, 'https://example.test', undefined, {
      maxAttempts: 3,
      attemptTimeoutMs: 500,
      sleep: async () => undefined,
      setTimeoutFn,
      clearTimeoutFn,
    })).rejects.toBeInstanceOf(HttpAttemptTimeoutError);

    expect(fetchFn).toHaveBeenCalledTimes(3);
    expect(new Set(signals).size).toBe(3);
    expect(signals.every(signal => signal.aborted)).toBe(true);
    expect(setTimeoutFn).toHaveBeenCalledTimes(3);
    expect(clearTimeoutFn).toHaveBeenCalledTimes(3);
  });

  it('keeps helper-owned timeout provenance when an abort-aware fetch rejects synchronously', async () => {
    const fetchFn = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init!.signal!.addEventListener('abort', () => {
          reject(new DOMException('fetch observed abort', 'AbortError'));
        }, { once: true });
      }));

    await expect(fetchWithRetry(fetchFn as typeof fetch, 'https://example.test', undefined, {
      maxAttempts: 1,
      attemptTimeoutMs: 100,
      setTimeoutFn: (callback) => { queueMicrotask(callback); return 1; },
      clearTimeoutFn: vi.fn(),
    })).rejects.toBeInstanceOf(HttpAttemptTimeoutError);
  });

  it('cancels retryable response bodies before retrying', async () => {
    const cancel = vi.fn(async () => undefined);
    const retryable = new Response(new ReadableStream({ cancel }), { status: 503 });
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(retryable)
      .mockResolvedValueOnce(new Response('ok', { status: 200 }));

    const response = await fetchWithRetry(fetchFn, 'https://example.test', undefined, {
      sleep: async () => undefined,
    });

    expect(response.status).toBe(200);
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('does not let response body cancellation failures mask a retry', async () => {
    const cancel = vi.fn(async () => { throw new Error('cancel failed'); });
    const retryable = new Response(new ReadableStream({ cancel }), { status: 429 });
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(retryable)
      .mockResolvedValueOnce(new Response('ok', { status: 200 }));

    await expect(fetchWithRetry(fetchFn, 'https://example.test', undefined, {
      sleep: async () => undefined,
    })).resolves.toMatchObject({ status: 200 });
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('leaves the terminal response body readable', async () => {
    const response = await fetchWithRetry(
      vi.fn(async () => new Response('terminal detail', { status: 503 })),
      'https://example.test',
      undefined,
      { maxAttempts: 1 },
    );

    expect(await response.text()).toBe('terminal detail');
  });

  it('rejects non-idempotent methods before issuing a request', async () => {
    const fetchFn = vi.fn(async () => new Response('ok'));

    await expect(fetchWithRetry(fetchFn, 'https://example.test', { method: 'POST' }))
      .rejects.toThrow(/GET or HEAD/i);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('does not retry a caller-initiated abort', async () => {
    const caller = new AbortController();
    const abortError = new DOMException('caller cancelled', 'AbortError');
    const fetchFn = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => {
      queueMicrotask(() => caller.abort(abortError));
      return new Promise<Response>(() => {});
    });
    const sleep = vi.fn(async () => undefined);

    await expect(fetchWithRetry(fetchFn as typeof fetch, 'https://example.test', {
      signal: caller.signal,
    }, {
      sleep,
      setTimeoutFn: () => Symbol('timer'),
      clearTimeoutFn: vi.fn(),
    })).rejects.toBe(abortError);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('does not mistake a caller-supplied timeout-shaped abort reason for a helper timeout', async () => {
    const caller = new AbortController();
    const callerReason = new HttpAttemptTimeoutError(123);
    const fetchFn = vi.fn(async () => {
      queueMicrotask(() => caller.abort(callerReason));
      return new Promise<Response>(() => {});
    });
    const sleep = vi.fn(async () => undefined);

    await expect(fetchWithRetry(fetchFn as typeof fetch, 'https://example.test', {
      signal: caller.signal,
    }, {
      sleep,
      setTimeoutFn: () => Symbol('timer'),
      clearTimeoutFn: vi.fn(),
    })).rejects.toBe(callerReason);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });
});
