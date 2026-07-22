import { describe, expect, it } from 'vitest';
// @ts-ignore Vitest executes in Node.
import { readFileSync } from 'node:fs';

const read = (path: string) => readFileSync(path, 'utf8');

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
    expect(guard).toContain('--schema-confirmed=0010');
    expect(guard).toContain('CODE_COMMIT_SHA');
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
