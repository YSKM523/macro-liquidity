import { describe, expect, it, vi } from 'vitest';
import {
  LiveDataCache,
  authenticateAdmin,
  deliverAlert,
  fullRebuildConfirmed,
  structuredLog,
} from '../src/operations';

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
