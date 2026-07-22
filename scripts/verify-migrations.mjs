#!/usr/bin/env node
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const directory = mkdtempSync(join(tmpdir(), 'macro-liquidity-migrations-'));
const command = ['wrangler', 'd1', 'migrations', 'apply', 'macro_liquidity_dev',
  '--local', '--persist-to', directory, '--env', 'dev'];
try {
  const runs = [];
  for (let attempt = 1; attempt <= 2; attempt++) {
    const result = spawnSync('npx', command, { encoding: 'utf8' });
    if (result.status !== 0) {
      process.stderr.write(result.stdout ?? '');
      process.stderr.write(result.stderr ?? '');
      process.exit(result.status ?? 1);
    }
    runs.push({ attempt, output: `${result.stdout ?? ''}${result.stderr ?? ''}`.slice(0, 2000) });
  }
  process.stdout.write(JSON.stringify({ status: 'PASS', localOnly: true, runs }) + '\n');
} finally {
  rmSync(directory, { recursive: true, force: true });
}
