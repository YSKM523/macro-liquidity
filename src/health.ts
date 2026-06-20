export interface HealthInput {
  dataDate: string | null;
  snapshots: number;
  coverage: number | null;
  lastIngestAt: string | null;
  lastStatus: string | null;
  lastError: string | null;
  now: string;        // ISO timestamp
  staleHours: number;
}

export interface HealthResult {
  ok: boolean;
  data_date: string | null;
  data_age_days: number | null;
  ingest_at: string | null;
  ingest_age_hours: number | null;
  ingest_status: string | null;
  ingest_error: string | null;
  snapshots: number;
  coverage: number | null;
  stale: boolean;
}

export function assessHealth(i: HealthInput): HealthResult {
  const nowMs = Date.parse(i.now);
  const dataAgeDays = i.dataDate != null
    ? Math.floor((nowMs - Date.parse(i.dataDate + 'T00:00:00Z')) / 86400000)
    : null;
  const ingestAgeHours = i.lastIngestAt != null
    ? (nowMs - Date.parse(i.lastIngestAt)) / 3600000
    : null;

  const hasData = i.snapshots > 0 && i.dataDate != null;
  const ingestFresh = ingestAgeHours != null && ingestAgeHours < i.staleHours;
  const statusOk = i.lastStatus === 'ok';
  const ok = hasData && statusOk && ingestFresh;

  return {
    ok,
    data_date: i.dataDate,
    data_age_days: dataAgeDays,
    ingest_at: i.lastIngestAt,
    ingest_age_hours: ingestAgeHours,
    ingest_status: i.lastStatus,
    ingest_error: i.lastError || null,
    snapshots: i.snapshots,
    coverage: i.coverage,
    stale: !ok,
  };
}
