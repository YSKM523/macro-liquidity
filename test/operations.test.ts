import { describe, expect, it, vi } from 'vitest';
import {
  LiveDataCache,
  authenticateAdmin,
  deliverAlert,
  fullRebuildConfirmed,
  structuredLog,
} from '../src/operations';
import { assertCacheableLivePrices, assertCacheableStress, failClosedCachedStress } from '../src/live-data';

describe('production operations controls', () => {
  it('emits bounded JSON logs and redacts secret-shaped fields', () => {
    const sink = vi.fn();
    const record = structuredLog('request_failure', {
      request_id: 'r1', authorization: 'Bearer secret', error: 'x'.repeat(900), status: 500,
    }, sink);
    expect(sink).toHaveBeenCalledOnce();
    expect(JSON.parse(sink.mock.calls[0][0])).toEqual(record);
    expect(record.authorization).toBe('[REDACTED]');
    expect(String(record.error).length).toBeLessThanOrEqual(512);
  });

  it('redacts credentials embedded in values and nested error content', () => {
    const sink = vi.fn();
    const record = structuredLog('request_failure', {
      error_code: 'UPSTREAM_FAILURE',
      error: 'authorization=Bearer abc.def api_key=sk-live password=hunter2',
      context: { url: 'https://x.test?token=top-secret', nested: ['Bearer another-secret'] },
    }, sink);
    const serialized = JSON.stringify(record);
    expect(serialized).toContain('UPSTREAM_FAILURE');
    expect(serialized).not.toMatch(/abc\.def|sk-live|hunter2|top-secret|another-secret/);
    expect(serialized).toContain('[REDACTED]');
  });

  it('supports legacy bearer and exact Access service-token credentials', () => {
    const bindings = { ADMIN_TOKEN: 'legacy', ACCESS_CLIENT_ID: 'id', ACCESS_CLIENT_SECRET: 'secret' };
    expect(authenticateAdmin(new Request('https://x', { headers: { authorization: 'Bearer legacy' } }), bindings))
      .toBe('LEGACY_BEARER');
    expect(authenticateAdmin(new Request('https://x', { headers: {
      'cf-access-client-id': 'id', 'cf-access-client-secret': 'secret',
    } }), bindings)).toBe('ACCESS_SERVICE_TOKEN');
    expect(authenticateAdmin(new Request('https://x', { headers: {
      'cf-access-client-id': 'id', 'cf-access-client-secret': 'wrong',
    } }), bindings)).toBeNull();
  });

  it('requires the exact second confirmation for a full rebuild', () => {
    expect(fullRebuildConfirmed(new Request('https://x', {
      headers: { 'x-confirm-full-rebuild': 'FULL_REBUILD' },
    }))).toBe(true);
    expect(fullRebuildConfirmed(new Request('https://x'))).toBe(false);
  });

  it('serves bounded stale data during a short failure and fails closed after the stale limit', async () => {
    const cache = new LiveDataCache<number>({ freshMs: 100, staleMs: 300, failureThreshold: 2, openMs: 100 });
    await expect(cache.get(async () => 7, 0)).resolves.toMatchObject({ value: 7, status: 'FRESH' });
    await expect(cache.get(async () => { throw new Error('upstream'); }, 150))
      .resolves.toMatchObject({ value: 7, status: 'STALE' });
    await expect(cache.get(async () => { throw new Error('upstream'); }, 400)).rejects.toThrow(/upstream|circuit/i);
  });

  it('makes alert delivery injectable and returns auditable outcomes without throwing', async () => {
    await expect(deliverAlert({}, { subject: 'x', text: 'y' }, vi.fn()))
      .resolves.toMatchObject({ outcome: 'SKIPPED' });
    await expect(deliverAlert({ apiKey: 'k', from: 'a@example.com', to: 'b@example.com' },
      { subject: 'x', text: 'y' }, vi.fn(async () => new Response('', { status: 202 }))))
      .resolves.toMatchObject({ outcome: 'SENT' });
    await expect(deliverAlert({ apiKey: 'k', from: 'a@example.com', to: 'b@example.com' },
      { subject: 'x', text: 'y' }, vi.fn(async () => { throw new Error('network'); })))
      .resolves.toMatchObject({ outcome: 'FAILED' });
  });
});

describe('live data fail-closed cache policy', () => {
  it('counts typed provider failures and UNKNOWN stress as cache loader failures', () => {
    expect(() => assertCacheableLivePrices({
      quotes: { spx: { status: 'FAILED' }, vix: { status: 'OK' }, dxy: { status: 'OK' }, us10y: { status: 'OK' } },
    } as any)).toThrow(/provider/i);
    expect(() => assertCacheableStress({ status: 'UNKNOWN' } as any)).toThrow(/stress/i);
  });

  it('never reuses stale NORMAL stress as actionable NORMAL guidance', () => {
    const stale = failClosedCachedStress({
      status: 'NORMAL', stressed: false, reasons: [], unavailable: [], signals: {}, thresholds: {},
    } as any, 'STALE');
    expect(stale.status).toBe('UNKNOWN');
    expect(stale.unavailable).toContain('LIVE_STRESS_CACHE_STALE');
  });

  it('turns a failed stress refresh backed by stale NORMAL cache into UNKNOWN', async () => {
    const cache = new LiveDataCache<any>({ freshMs: 100, staleMs: 300, failureThreshold: 2, openMs: 100 });
    await cache.get(async () => assertCacheableStress({
      status: 'NORMAL', stressed: false, reasons: [], unavailable: [], signals: {}, thresholds: {},
    } as any), 0);
    const cached = await cache.get(async () => assertCacheableStress({ status: 'UNKNOWN' } as any), 150);
    expect(cached.status).toBe('STALE');
    expect(failClosedCachedStress(cached.value, cached.status).status).toBe('UNKNOWN');
  });

  it('counts typed provider outcomes toward the circuit threshold', async () => {
    const cache = new LiveDataCache<any>({ freshMs: 0, staleMs: 0, failureThreshold: 2, openMs: 100 });
    const failed = { quotes: {
      spx: { status: 'FAILED' }, vix: { status: 'OK' }, dxy: { status: 'OK' }, us10y: { status: 'OK' },
    } } as any;
    await expect(cache.get(async () => assertCacheableLivePrices(failed), 1)).rejects.toThrow(/provider/i);
    await expect(cache.get(async () => assertCacheableLivePrices(failed), 2)).rejects.toThrow(/provider/i);
    const loader = vi.fn(async () => ({ quotes: {} }));
    await expect(cache.get(loader, 3)).rejects.toThrow(/provider/i);
    expect(loader).not.toHaveBeenCalled();
  });
});
