import { describe, expect, it } from 'vitest';
// @ts-ignore Vitest executes in Node.
import { execFileSync, spawnSync } from 'node:child_process';
// @ts-ignore Vitest executes in Node.
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
// @ts-ignore Vitest executes in Node.
import { tmpdir } from 'node:os';
// @ts-ignore Vitest executes in Node.
import { join } from 'node:path';
declare const process: { execPath: string; env: Record<string, string | undefined> };

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

  it('executes D1 backup and R2 upload through a fake npx without an invalid R2 remote flag', () => {
    const root = mkdtempSync(join(tmpdir(), 'backup-command-test-'));
    const fakeNpx = join(root, 'npx');
    const calls = join(root, 'calls.jsonl');
    const outputDir = join(root, 'output');
    writeFileSync(fakeNpx, `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.CALLS_FILE, JSON.stringify(args) + '\\n');
if (args.includes('execute')) process.stdout.write(JSON.stringify([{results:[]}]))
else if (args.includes('export')) fs.writeFileSync(args[args.indexOf('--output') + 1], '-- full backup');
`, { mode: 0o700 });
    chmodSync(fakeNpx, 0o700);
    try {
      const result = spawnSync(process.execPath, [
        'scripts/backup.mjs', '--execute', '--env=dev', '--scope=critical', `--output-dir=${outputDir}`,
      ], {
        encoding: 'utf8',
        env: {
          ...process.env, PATH: `${root}:${process.env.PATH}`, CALLS_FILE: calls,
          BACKUP_R2_BUCKET: 'test-backups',
        },
      });
      expect(result.status).toBe(0);
      const invocations: string[][] = readFileSync(calls, 'utf8').trim().split('\n')
        .map((line: string) => JSON.parse(line));
      const d1 = invocations.find((args: string[]) => args.includes('d1'));
      const r2 = invocations.find((args: string[]) => args.includes('r2'));
      expect(d1).toContain('--remote');
      expect(r2).toEqual(expect.arrayContaining(['wrangler', 'r2', 'object', 'put']));
      expect(r2).not.toContain('--remote');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
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
