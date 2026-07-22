#!/usr/bin/env node
// Production-only fail-closed deployment wrapper. It deliberately reapplies
// migrations so invoking `npm run deploy` outside Actions cannot skip schema.
import { spawnSync } from 'node:child_process';

const args = new Set(process.argv.slice(2));
const execute = args.has('--execute');
const confirmed = args.has('--confirm-production=DEPLOY_PRODUCTION');
const schemaConfirmed = args.has('--schema-confirmed=0010');
const commitSha = process.env.CODE_COMMIT_SHA?.trim().toLowerCase() ?? '';
const immutableCommit = /^[a-f0-9]{40}$/.test(commitSha);
const credentialsPresent = Boolean(
  process.env.CLOUDFLARE_API_TOKEN?.trim() && process.env.CLOUDFLARE_ACCOUNT_ID?.trim(),
);

if (!execute || !confirmed || !schemaConfirmed || !immutableCommit || !credentialsPresent) {
  console.error(JSON.stringify({
    outcome: 'REFUSED',
    execute,
    productionConfirmed: confirmed,
    schemaConfirmed,
    immutableCommit,
    credentialsPresent,
  }));
  process.exitCode = 1;
} else {
  const run = (commandArgs) => spawnSync('npx', commandArgs, {
    stdio: 'inherit',
    env: process.env,
  });

  const migration = run([
    'wrangler', 'd1', 'migrations', 'apply', 'macro_liquidity',
    '--remote', '--env', 'production',
  ]);
  if (migration.status !== 0) {
    console.error(JSON.stringify({ outcome: 'MIGRATION_FAILED', status: migration.status }));
    process.exitCode = migration.status ?? 1;
  } else {
    const deploy = run([
      'wrangler', 'deploy', '--env', 'production', '--var', `CODE_COMMIT_SHA:${commitSha}`,
    ]);
    if (deploy.status !== 0) {
      console.error(JSON.stringify({ outcome: 'DEPLOY_FAILED', status: deploy.status }));
      process.exitCode = deploy.status ?? 1;
    }
  }
}
