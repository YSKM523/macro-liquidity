import { sha256Hex } from './model-version';

export type AdminAuthMethod = 'LEGACY_BEARER' | 'ACCESS_SERVICE_TOKEN';

export interface AdminBindings {
  ADMIN_TOKEN: string;
  ACCESS_CLIENT_ID?: string;
  ACCESS_CLIENT_SECRET?: string;
}

export function authenticateAdmin(req: Request, env: AdminBindings): AdminAuthMethod | null {
  const bearer = req.headers.get('authorization');
  if (env.ADMIN_TOKEN.length > 0 && bearer === `Bearer ${env.ADMIN_TOKEN}`) return 'LEGACY_BEARER';
  const id = req.headers.get('cf-access-client-id');
  const secret = req.headers.get('cf-access-client-secret');
  if (env.ACCESS_CLIENT_ID && env.ACCESS_CLIENT_SECRET
    && id === env.ACCESS_CLIENT_ID && secret === env.ACCESS_CLIENT_SECRET) {
    return 'ACCESS_SERVICE_TOKEN';
  }
  return null;
}

export function fullRebuildConfirmed(req: Request): boolean {
  return req.headers.get('x-confirm-full-rebuild') === 'FULL_REBUILD';
}

export function adminRateLimitBucket(req: Request): string {
  const source = (req.headers.get('cf-connecting-ip') ?? 'unknown').trim().slice(0, 128);
  return `admin-source:${sha256Hex(source || 'unknown')}`;
}

const SECRET_KEY = /(?:authorization|token|secret|api.?key|password)/i;

export function redactText(value: string): string {
  return value
    .replace(
      /(["']?(?:authorization|access[_-]?token|refresh[_-]?token|token|api[_-]?key|password|secret)["']?\s*[:=]\s*["']?)(?:Bearer\s+)?([^"'\s,;}&]+)/gi,
      '$1[REDACTED]',
    )
    .replace(/\bBearer\s+[^"'\s,;}&]+/gi, 'Bearer [REDACTED]');
}

function safeField(key: string, value: unknown, depth = 0): unknown {
  if (SECRET_KEY.test(key)) return '[REDACTED]';
  if (typeof value === 'string') return redactText(value).slice(0, 512);
  if (typeof value === 'number' || typeof value === 'boolean' || value == null) return value;
  if (depth >= 4) return '[TRUNCATED]';
  if (Array.isArray(value)) return value.slice(0, 32).map(child => safeField('', child, depth + 1));
  if (typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).slice(0, 64)
      .map(([childKey, child]) => [childKey, safeField(childKey, child, depth + 1)]));
  }
  return redactText(String(value)).slice(0, 512);
}

export function structuredLog(
  event: string,
  fields: Record<string, unknown> = {},
  sink: (line: string) => void = console.log,
): Record<string, unknown> {
  const record: Record<string, unknown> = {
    timestamp: new Date().toISOString(),
    event: event.slice(0, 80),
  };
  for (const [key, value] of Object.entries(fields)) record[key] = safeField(key, value);
  sink(JSON.stringify(record));
  return record;
}

export interface CachePolicy {
  freshMs: number;
  staleMs: number;
  failureThreshold: number;
  openMs: number;
}

export type CacheResult<T> = { value: T; status: 'FRESH' | 'STALE'; ageMs: number };

export class LiveDataCache<T> {
  private value?: T;
  private loadedAt = 0;
  private failures = 0;
  private openUntil = 0;
  private pending?: Promise<T>;
  private lastError?: unknown;
  private lastAttemptAt = 0;

  constructor(private readonly policy: CachePolicy) {
    if (policy.freshMs < 0 || policy.staleMs < policy.freshMs
      || policy.failureThreshold < 1 || policy.openMs < 1) throw new Error('invalid cache policy');
  }

  async get(loader: () => Promise<T>, now = Date.now()): Promise<CacheResult<T>> {
    if (now < this.lastAttemptAt) {
      this.failures = 0;
      this.openUntil = 0;
      this.lastError = undefined;
    }
    this.lastAttemptAt = now;
    const hasValue = this.value !== undefined;
    const age = hasValue ? now - this.loadedAt : Number.POSITIVE_INFINITY;
    if (hasValue && age >= 0 && age <= this.policy.freshMs) return { value: this.value!, status: 'FRESH', ageMs: age };
    if (now < this.openUntil) {
      if (hasValue && age >= 0 && age <= this.policy.staleMs) return { value: this.value!, status: 'STALE', ageMs: age };
      throw this.lastError ?? new Error('live data circuit open');
    }
    try {
      this.pending ??= loader();
      const loaded = await this.pending;
      this.value = loaded;
      this.loadedAt = now;
      this.failures = 0;
      this.openUntil = 0;
      this.lastError = undefined;
      return { value: loaded, status: 'FRESH', ageMs: 0 };
    } catch (error) {
      this.lastError = error;
      this.failures++;
      if (this.failures >= this.policy.failureThreshold) this.openUntil = now + this.policy.openMs;
      if (hasValue && age >= 0 && age <= this.policy.staleMs) return { value: this.value!, status: 'STALE', ageMs: age };
      throw error;
    } finally {
      this.pending = undefined;
    }
  }

  async getSWR(
    loader: () => Promise<T>,
    waitUntil: (promise: Promise<unknown>) => void,
    now = Date.now(),
  ): Promise<CacheResult<T>> {
    if (now < this.lastAttemptAt) {
      this.failures = 0;
      this.openUntil = 0;
      this.lastError = undefined;
    }
    this.lastAttemptAt = now;
    const hasValue = this.value !== undefined;
    const age = hasValue ? now - this.loadedAt : Number.POSITIVE_INFINITY;
    if (hasValue && age >= 0 && age <= this.policy.freshMs) {
      return { value: this.value!, status: 'FRESH', ageMs: age };
    }
    if (hasValue && age >= 0 && age <= this.policy.staleMs && now >= this.openUntil) {
      const refresh = this.get(loader, now).then(() => undefined).catch(() => undefined);
      waitUntil(refresh);
      return { value: this.value!, status: 'STALE', ageMs: age };
    }
    return this.get(loader, now);
  }
}

export interface AlertConfig { apiKey?: string; from?: string; to?: string }
export interface AlertMessage { subject: string; text: string }
export type AlertOutcome = { outcome: 'SENT' | 'FAILED' | 'SKIPPED'; status?: number; error?: string };

export async function deliverAlert(
  config: AlertConfig,
  message: AlertMessage,
  fetcher: typeof fetch = fetch,
): Promise<AlertOutcome> {
  if (!config.apiKey || !config.from || !config.to) return { outcome: 'SKIPPED' };
  try {
    const response = await fetcher('https://api.resend.com/emails', {
      method: 'POST',
      headers: { authorization: `Bearer ${config.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ from: config.from, to: [config.to], subject: message.subject, text: message.text }),
    });
    return response.ok
      ? { outcome: 'SENT', status: response.status }
      : { outcome: 'FAILED', status: response.status, error: `HTTP_${response.status}` };
  } catch (error) {
    return { outcome: 'FAILED', error: redactText(String((error as Error).message)).slice(0, 512) };
  }
}

export const SLO_TARGETS = {
  pageAvailability: 0.999,
  postReleaseIngestSuccess: 0.99,
  criticalSnapshotAlerting: 'MANDATORY',
} as const;
