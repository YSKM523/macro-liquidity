const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

function validDate(value: string): boolean {
  if (!ISO_DATE.test(value)) return false;
  return new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
}

export function parseDateRange(url: URL): { from: string; to: string } {
  const from = url.searchParams.get('from') ?? '1900-01-01';
  const to = url.searchParams.get('to') ?? '2100-01-01';
  if (!validDate(from)) throw new Error('invalid from date');
  if (!validDate(to)) throw new Error('invalid to date');
  if (from > to) throw new Error('invalid date range');
  return { from, to };
}

function validInstant(value: unknown): value is string {
  return typeof value === 'string' && ISO_INSTANT.test(value) && Number.isFinite(Date.parse(value));
}

export interface SnapshotVersionMetadata {
  modelVersion: string;
  configHash: string;
  codeCommitSha: string;
  dataRunId: string;
  dataCutoff: string;
  decisionAt: string;
  createdAt: string;
}

export type SnapshotProvenanceStatus = 'GOVERNED' | 'LEGACY';
export type NormalizedSnapshotRow = Record<string, unknown> & { provenance_status: SnapshotProvenanceStatus };

export function normalizeSnapshotProvenance(row: unknown): NormalizedSnapshotRow {
  if (row == null || typeof row !== 'object') throw new Error('snapshot provenance row missing');
  const value = row as Record<string, unknown>;
  const legacyFields = ['model_version', 'config_hash', 'code_commit_sha'] as const;
  const legacyCount = legacyFields.filter(field => value[field] === 'LEGACY_UNVERSIONED').length;
  if (legacyCount > 0 && legacyCount < legacyFields.length) {
    throw new Error('mixed legacy/governed snapshot identity');
  }
  if (legacyCount === legacyFields.length) {
    return {
      ...value,
      provenance_status: 'LEGACY',
      model_version: 'LEGACY_UNVERSIONED',
      config_hash: null,
      code_commit_sha: null,
      data_run_id: null,
      data_cutoff: null,
      decision_at: null,
      created_at: null,
    };
  }
  assertSnapshotVersionMetadata(value);
  return { ...value, provenance_status: 'GOVERNED' };
}

export function summarizeSnapshotProvenance(rows: NormalizedSnapshotRow[]) {
  const governedCount = rows.filter(row => row.provenance_status === 'GOVERNED').length;
  const legacyCount = rows.filter(row => row.provenance_status === 'LEGACY').length;
  if (governedCount + legacyCount !== rows.length) throw new Error('invalid snapshot provenance status');
  return {
    totalCount: rows.length,
    governedCount,
    legacyCount,
    completeness: legacyCount === 0 ? 'COMPLETE' as const : 'PARTIAL_LEGACY' as const,
  };
}

export function assertSnapshotVersionMetadata(row: unknown): SnapshotVersionMetadata {
  if (row == null || typeof row !== 'object') throw new Error('snapshot version metadata missing');
  const value = row as Record<string, unknown>;
  if (typeof value.model_version !== 'string' || value.model_version === 'LEGACY_UNVERSIONED') {
    throw new Error('snapshot model version missing');
  }
  if (typeof value.config_hash !== 'string' || !/^[a-f0-9]{64}$/.test(value.config_hash)) {
    throw new Error('snapshot config hash invalid');
  }
  if (typeof value.code_commit_sha !== 'string'
    || !(value.code_commit_sha === 'LOCAL_UNCONFIGURED' || /^[a-f0-9]{40}$/.test(value.code_commit_sha))) {
    throw new Error('snapshot commit SHA invalid');
  }
  if (typeof value.data_run_id !== 'string' || value.data_run_id.length === 0) {
    throw new Error('snapshot data run id missing');
  }
  for (const field of ['data_cutoff', 'decision_at', 'created_at'] as const) {
    if (!validInstant(value[field])) throw new Error(`snapshot ${field} invalid`);
  }
  return {
    modelVersion: value.model_version,
    configHash: value.config_hash,
    codeCommitSha: value.code_commit_sha,
    dataRunId: value.data_run_id,
    dataCutoff: value.data_cutoff,
    decisionAt: value.decision_at,
    createdAt: value.created_at,
  } as SnapshotVersionMetadata;
}

const CSV_COLUMNS = [
  'date','score','verdict','decision_status','netliq','spx','reason','provenance_status','model_version','config_hash',
  'code_commit_sha','data_run_id','data_cutoff','decision_at','created_at',
] as const;

function csvCell(value: unknown): string {
  if (value == null) return '';
  let string = String(value);
  if (typeof value === 'string' && /^[=+\-@\t\r]/.test(string)) string = `'${string}`;
  return /[",\r\n]/.test(string) ? `"${string.replace(/"/g, '""')}"` : string;
}

export function snapshotsToCsv(rows: Array<Record<string, unknown>>): string {
  return [
    CSV_COLUMNS.join(','),
    ...rows.map(row => CSV_COLUMNS.map(column => csvCell(row[column])).join(',')),
  ].join('\r\n') + '\r\n';
}
