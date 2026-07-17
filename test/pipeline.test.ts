import { describe, it, expect } from 'vitest';
import { shouldRetryIngest, shouldAlert, buildAlertEmail } from '../src/pipeline';

const NOW = '2026-07-17T14:00:00Z';

describe('shouldRetryIngest', () => {
  it('retries when last status is error', () => {
    expect(shouldRetryIngest({
      lastStatus: 'error', lastIngestAt: '2026-07-17T13:00:00Z', now: NOW, maxAgeHours: 4,
    })).toBe(true);
  });
  it('retries when there has never been a successful ingest', () => {
    expect(shouldRetryIngest({
      lastStatus: null, lastIngestAt: null, now: NOW, maxAgeHours: 4,
    })).toBe(true);
  });
  it('retries when last success is older than maxAgeHours (silently missed cron)', () => {
    expect(shouldRetryIngest({
      lastStatus: 'ok', lastIngestAt: '2026-07-17T09:00:00Z', now: NOW, maxAgeHours: 4,
    })).toBe(true);
  });
  it('does not retry when healthy and fresh', () => {
    expect(shouldRetryIngest({
      lastStatus: 'ok', lastIngestAt: '2026-07-17T12:05:00Z', now: NOW, maxAgeHours: 4,
    })).toBe(false);
  });
});

describe('shouldAlert', () => {
  it('alerts on second consecutive failure', () => {
    expect(shouldAlert({
      prevStatus: 'error', attemptOk: false, lastAlertAt: null, now: NOW, minIntervalHours: 12,
    })).toBe(true);
  });
  it('does not alert on first failure (retry cron gets a chance)', () => {
    expect(shouldAlert({
      prevStatus: 'ok', attemptOk: false, lastAlertAt: null, now: NOW, minIntervalHours: 12,
    })).toBe(false);
  });
  it('does not alert on success', () => {
    expect(shouldAlert({
      prevStatus: 'error', attemptOk: true, lastAlertAt: null, now: NOW, minIntervalHours: 12,
    })).toBe(false);
  });
  it('rate-limits: no second alert within minIntervalHours', () => {
    expect(shouldAlert({
      prevStatus: 'error', attemptOk: false, lastAlertAt: '2026-07-17T08:00:00Z', now: NOW, minIntervalHours: 12,
    })).toBe(false);
  });
  it('alerts again after the rate-limit window passes', () => {
    expect(shouldAlert({
      prevStatus: 'error', attemptOk: false, lastAlertAt: '2026-07-17T01:00:00Z', now: NOW, minIntervalHours: 12,
    })).toBe(true);
  });
});

describe('buildAlertEmail', () => {
  it('includes error and last success time', () => {
    const m = buildAlertEmail({ error: 'FRED RRPONTSYD 502', lastIngestAt: '2026-07-17T06:01:00Z', now: NOW });
    expect(m.subject).toContain('macro-liq');
    expect(m.text).toContain('FRED RRPONTSYD 502');
    expect(m.text).toContain('2026-07-17T06:01:00Z');
  });
  it('handles missing last success', () => {
    const m = buildAlertEmail({ error: 'boom', lastIngestAt: null, now: NOW });
    expect(m.text).toContain('never');
  });
});
