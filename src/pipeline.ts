// Ingest resilience: retry-cron decision + failure alerting.
// The 3h cron always ingests; the hourly retry cron only backfills when the
// pipeline is unhealthy, and alerts (via Resend) on the 2nd consecutive failure.

export interface RetryInput {
  lastStatus: string | null;   // meta.last_status
  lastIngestAt: string | null; // meta.last_ingest_at (last SUCCESS)
  now: string;
  maxAgeHours: number;
}

export function shouldRetryIngest(i: RetryInput): boolean {
  if (i.lastStatus !== 'ok') return true;
  if (i.lastIngestAt == null) return true;
  const ageHours = (Date.parse(i.now) - Date.parse(i.lastIngestAt)) / 3600000;
  return ageHours > i.maxAgeHours;
}

export interface AlertInput {
  prevStatus: string | null;  // status BEFORE this attempt
  attemptOk: boolean;
  lastAlertAt: string | null; // meta.last_alert_at
  now: string;
  minIntervalHours: number;
}

export function shouldAlert(i: AlertInput): boolean {
  if (i.attemptOk) return false;
  if (i.prevStatus !== 'error') return false; // 1st failure: let the retry cron fix it silently
  if (i.lastAlertAt != null) {
    const ageHours = (Date.parse(i.now) - Date.parse(i.lastAlertAt)) / 3600000;
    if (ageHours < i.minIntervalHours) return false;
  }
  return true;
}

export function buildAlertEmail(i: { error: string; lastIngestAt: string | null; now: string }): { subject: string; text: string } {
  return {
    subject: '[macro-liq] ingest failing — data is going stale',
    text: [
      `Ingest has failed at least twice in a row.`,
      `Latest error: ${i.error}`,
      `Last successful ingest: ${i.lastIngestAt ?? 'never'}`,
      `Time now: ${i.now}`,
      `Manual fix: POST /api/admin/refresh (Bearer ADMIN_TOKEN).`,
    ].join('\n'),
  };
}
