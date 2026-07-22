import { describe, expect, it, vi } from 'vitest';
import { fetchWithRetry } from '../src/http-retry';

describe('bounded HTTP retry policy', () => {
  it('retries 5xx and 429 with bounded exponential delays', async () => {
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(new Response('', { status: 503 }))
      .mockResolvedValueOnce(new Response('', { status: 429 }))
      .mockResolvedValueOnce(new Response('ok', { status: 200 }));
    const sleep = vi.fn(async () => undefined);

    const response = await fetchWithRetry(fetchFn, 'https://example.test', undefined, {
      maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 500, random: () => 1, sleep,
    });

    expect(response.status).toBe(200);
    expect(fetchFn).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls.map(([delay]) => delay)).toEqual([100, 200]);
  });

  it('caps delay and attempts even when callers request excessive values', async () => {
    const fetchFn = vi.fn(async () => new Response('', { status: 503 }));
    const sleep = vi.fn(async () => undefined);

    const response = await fetchWithRetry(fetchFn, 'https://example.test', undefined, {
      maxAttempts: 100, baseDelayMs: 20_000, maxDelayMs: 999_999, random: () => 1, sleep,
    });

    expect(response.status).toBe(503);
    expect(fetchFn).toHaveBeenCalledTimes(5);
    expect(sleep.mock.calls.map(([delay]) => delay)).toEqual([20_000, 30_000, 30_000, 30_000]);
  });

  it('retries transport errors and rethrows the terminal error after exhaustion', async () => {
    const terminal = new TypeError('network unavailable');
    const fetchFn = vi.fn(async () => { throw terminal; });
    const sleep = vi.fn(async () => undefined);

    await expect(fetchWithRetry(fetchFn, 'https://example.test', undefined, {
      maxAttempts: 3, sleep, random: () => 0,
    })).rejects.toBe(terminal);
    expect(fetchFn).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it('returns a non-retryable 4xx immediately', async () => {
    const fetchFn = vi.fn(async () => new Response('', { status: 404 }));
    const sleep = vi.fn(async () => undefined);

    const response = await fetchWithRetry(fetchFn, 'https://example.test', undefined, { sleep });

    expect(response.status).toBe(404);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });
});
