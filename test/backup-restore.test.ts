import { describe, expect, it } from 'vitest';
// @ts-ignore Vitest executes in Node.
import { execFileSync, spawnSync } from 'node:child_process';
declare const process: { execPath: string };

describe('backup and restore tooling', () => {
  it('is dry-run by default and prints no secret-bearing command', () => {
    const output = execFileSync(process.execPath, ['scripts/backup.mjs', '--scope=critical'], { encoding: 'utf8' });
    const result = JSON.parse(output);
    expect(result).toMatchObject({ mode: 'DRY_RUN', scope: 'critical', remoteWrites: false });
    expect(output).not.toMatch(/api[_-]?key|secret|bearer/i);
  });

  it('rejects execute without an environment and exact production confirmation', () => {
    const missing = spawnSync(process.execPath, ['scripts/backup.mjs', '--execute'], { encoding: 'utf8' });
    expect(missing.status).not.toBe(0);
    expect(missing.stderr).toMatch(/environment/i);

    const production = spawnSync(process.execPath, [
      'scripts/backup.mjs', '--execute', '--env=production', '--scope=full',
    ], { encoding: 'utf8' });
    expect(production.status).not.toBe(0);
    expect(production.stderr).toMatch(/BACKUP_PRODUCTION/);
  });

  it('restores a full-schema export into a second ephemeral D1 without rewriting SQL data', () => {
    const output = execFileSync(process.execPath, ['scripts/restore-drill.mjs'], { encoding: 'utf8' });
    const result = JSON.parse(output);
    expect(result).toMatchObject({ status: 'PASS', remoteAccess: false });
    expect(result.migrations).toEqual({ first: 10, restored: 10 });
    expect(result.tables).toEqual(expect.arrayContaining([
      'model_snapshot_weekly', 'nowcast_snapshot_daily', 'snapshot_inputs',
      'observations', 'ingest_runs', 'market_prices_daily', 'cash_rates_daily',
    ]));
    expect(result.indexes).toEqual(expect.arrayContaining([
      'ingest_runs_started_at', 'idx_market_prices_daily_asof',
    ]));
    expect(result.triggers).toEqual(expect.arrayContaining([
      'market_prices_daily_no_update', 'cash_rates_daily_no_delete',
    ]));
    expect(result.rowCounts.model_snapshot_weekly).toBeGreaterThan(0);
    expect(result.latestSnapshot).toMatchObject({ model_version: 'champion-v1.0.0' });
    expect(result.applicationQueries).toEqual({ latestSnapshot: true, backtestRows: true });
    expect(result.whitespaceValue).toBe('alpha  beta\n gamma');
  });
});
