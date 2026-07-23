import { describe, expect, it } from 'vitest';
// @ts-ignore Vitest executes in Node.
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
// @ts-ignore Vitest executes in Node.
import { execFileSync, spawnSync } from 'node:child_process';
// @ts-ignore Vitest executes in Node.
import { tmpdir } from 'node:os';
// @ts-ignore Vitest executes in Node.
import { join, resolve } from 'node:path';
declare const process: { execPath: string; env: Record<string, string | undefined> };

const read = (path: string) => readFileSync(path, 'utf8');

function deployFixture() {
  const root = mkdtempSync(join(tmpdir(), 'deploy-git-gate-'));
  writeFileSync(join(root, 'tracked.txt'), 'clean\n');
  const fakeNpx = join(root, 'npx');
  writeFileSync(fakeNpx, '#!/bin/sh\necho unexpected-npx >&2\nexit 99\n', { mode: 0o700 });
  chmodSync(fakeNpx, 0o700);
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'test@example.invalid'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root });
  execFileSync('git', ['add', 'tracked.txt', 'npx'], { cwd: root });
  execFileSync('git', ['commit', '-qm', 'fixture'], { cwd: root });
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const run = (sha: string, schema = '0011') => spawnSync(process.execPath, [
    resolve('scripts/deploy-production.mjs'), '--execute',
    '--confirm-production=DEPLOY_PRODUCTION', `--schema-confirmed=${schema}`,
  ], {
    cwd: root, encoding: 'utf8',
    env: {
      ...process.env, PATH: `${root}:${process.env.PATH}`, CODE_COMMIT_SHA: sha,
      CLOUDFLARE_API_TOKEN: 'fake', CLOUDFLARE_ACCOUNT_ID: 'fake',
    },
  });
  return { root, head, run };
}

describe('production governance configuration', () => {
  it('defines reproducible local engineering gates', () => {
    const pkg = JSON.parse(read('package.json'));
    for (const script of [
      'typecheck','lint','test:correctness','test:no-lookahead','test:rebuild-consistency',
      'migrate:verify','restore:drill','backup:dry','deploy:dry',
    ]) expect(pkg.scripts[script]).toBeTruthy();
    expect(pkg.scripts.lint).toMatch(/^eslint\b/);
    expect(pkg.devDependencies.eslint).toBeTruthy();
    expect(pkg.scripts['deploy:dry']).toMatch(/--dry-run.*--env staging/);
  });

  it('keeps dev/staging/production D1 bindings explicit and staging unmistakably unconfigured', () => {
    const config = read('wrangler.toml');
    expect(config).toContain('[env.dev]');
    expect(config).toContain('[env.staging]');
    expect(config).toContain('[env.production]');
    expect(config).toContain('REPLACE_WITH_STAGING_D1');
    expect(config).toMatch(/\[env\.production\][\s\S]+5ee92b9b-eb8e-4c34-9479-b0838fa113fb/);
  });

  it('makes production deployment manual and protected, while CI runs every local gate', () => {
    const ci = read('.github/workflows/ci.yml');
    for (const command of ['npm ci','npm run typecheck','npm run lint','npm test','npm run migrate:verify','npm run restore:drill','npm run deploy:dry']) {
      expect(ci).toContain(command);
    }
    const production = read('.github/workflows/deploy-production.yml');
    expect(production).toContain('workflow_dispatch:');
    expect(production).toContain('environment: production');
    expect(production).not.toMatch(/schedule:|push:/);
    expect(production).toContain('--env production');
    const migration = production.indexOf('d1 migrations apply macro_liquidity --remote --env production');
    const deploy = production.indexOf('npm run deploy -- --execute');
    expect(migration).toBeGreaterThan(-1);
    expect(deploy).toBeGreaterThan(migration);
    expect(production).toContain('CODE_COMMIT_SHA: ${{ github.sha }}');

    const pkg = JSON.parse(read('package.json'));
    expect(pkg.scripts.deploy).toBe('node scripts/deploy-production.mjs');
    const guard = read('scripts/deploy-production.mjs');
    expect(guard).toContain('--confirm-production=DEPLOY_PRODUCTION');
    expect(guard).toContain('--schema-confirmed=0011');
    expect(guard).toContain('CODE_COMMIT_SHA');
  });

  it('refuses the superseded 0010 schema confirmation before invoking Wrangler', () => {
    const fixture = deployFixture();
    try {
      const result = fixture.run(fixture.head, '0010');
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('"schemaConfirmed":false');
      expect(result.stderr).not.toContain('unexpected-npx');
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it('refuses a valid-looking deployment SHA that is not the checked-out HEAD', () => {
    const fixture = deployFixture();
    try {
      const mismatch = fixture.head === 'a'.repeat(40) ? 'b'.repeat(40) : 'a'.repeat(40);
      const result = fixture.run(mismatch);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toMatch(/CODE_COMMIT_SHA.*HEAD/i);
      expect(result.stderr).not.toContain('unexpected-npx');
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it('refuses deployment from a dirty tracked worktree', () => {
    const fixture = deployFixture();
    try {
      writeFileSync(join(fixture.root, 'tracked.txt'), 'dirty\n');
      const result = fixture.run(fixture.head);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toMatch(/tracked worktree.*clean/i);
      expect(result.stderr).not.toContain('unexpected-npx');
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it('refuses deployment when an untracked public asset could enter the Wrangler bundle', () => {
    const fixture = deployFixture();
    try {
      mkdirSync(join(fixture.root, 'public'));
      writeFileSync(join(fixture.root, 'public', 'untracked.js'), 'globalThis.injected = true;\n');
      const result = fixture.run(fixture.head);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toMatch(/worktree.*clean/i);
      expect(result.stderr).not.toContain('unexpected-npx');
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it('publishes model governance and operations documentation', () => {
    const modelCard = read('docs/MODEL_CARD.md');
    for (const section of ['Purpose','Exclusions','Weights','Thresholds','Evidence','Known limitations','Rollback']) {
      expect(modelCard).toContain(section);
    }
    const registry = read('docs/CHALLENGER_REGISTRY.md');
    expect(registry).toMatch(/PR-11[\s\S]+DROP_RESEARCH/);
    expect(registry).toMatch(/PR-12[\s\S]+DROP_RESEARCH/);
    expect(read('docs/OPERATIONS_RUNBOOK.md')).toContain('FULL_REBUILD');
  });
});
