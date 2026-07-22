#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const args = new Map(process.argv.slice(2).map(arg => {
  const [key, ...rest] = arg.split('=');
  return [key, rest.length ? rest.join('=') : true];
}));
const execute = args.has('--execute');
const environment = args.get('--env');
const scope = args.get('--scope') ?? 'critical';

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}

if (scope !== 'critical' && scope !== 'full') fail('scope must be critical or full');
if (!execute) {
  process.stdout.write(JSON.stringify({
    mode: 'DRY_RUN', scope, environment: environment ?? null, remoteWrites: false,
    requires: ['--execute', '--env=dev|staging|production'],
    productionConfirmation: '--confirm-production=BACKUP_PRODUCTION',
  }) + '\n');
  process.exit(0);
}
if (!['dev', 'staging', 'production'].includes(environment)) {
  fail('execute requires an explicit environment: --env=dev|staging|production');
}
if (environment === 'production' && args.get('--confirm-production') !== 'BACKUP_PRODUCTION') {
  fail('production requires --confirm-production=BACKUP_PRODUCTION');
}
const bucket = process.env.BACKUP_R2_BUCKET;
if (!bucket) fail('BACKUP_R2_BUCKET is required for execute mode');

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const directory = String(args.get('--output-dir') ?? 'backups');
mkdirSync(directory, { recursive: true });
const extension = scope === 'full' ? 'sql' : 'json';
const output = join(directory, `${environment}-${scope}-${stamp}.${extension}`);
const base = ['wrangler', 'd1'];
let result;
if (scope === 'full') {
  result = spawnSync('npx', [...base, 'export', 'macro_liquidity', '--env', environment,
    '--remote', '--output', output], { encoding: 'utf8', stdio: 'inherit' });
} else {
  const query = `SELECT date,score,verdict,decision_status,model_version,config_hash,code_commit_sha,data_run_id,data_cutoff,decision_at,created_at FROM model_snapshot_weekly ORDER BY date DESC LIMIT 400`;
  result = spawnSync('npx', [...base, 'execute', 'macro_liquidity', '--env', environment,
    '--remote', '--json', '--command', query], { encoding: 'utf8' });
  if (result.status === 0) writeFileSync(output, result.stdout, { mode: 0o600 });
}
if (result.status !== 0) fail(`D1 backup failed with status ${result.status ?? 'unknown'}`);
const objectKey = `${environment}/${scope}/${output.split('/').at(-1)}`;
const upload = spawnSync('npx', ['wrangler', 'r2', 'object', 'put', `${bucket}/${objectKey}`,
  '--file', output], { stdio: 'inherit' });
if (upload.status !== 0) fail(`R2 upload failed with status ${upload.status ?? 'unknown'}`);
process.stdout.write(JSON.stringify({ mode: 'EXECUTED', environment, scope, output, objectKey }) + '\n');
