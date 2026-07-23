import { describe, expect, it } from 'vitest';
import * as ts from 'typescript';
// @ts-ignore Vitest executes in Node.
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
// @ts-ignore Vitest executes in Node.
import { execFileSync, spawnSync } from 'node:child_process';
// @ts-ignore Vitest executes in Node.
import { tmpdir } from 'node:os';
// @ts-ignore Vitest executes in Node.
import { dirname, join, normalize, resolve } from 'node:path';
declare const process: { execPath: string; env: Record<string, string | undefined> };

const read = (path: string) => readFileSync(path, 'utf8');

function productionTypeScriptFiles(directory = 'src'): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry: {
    name: string;
    isDirectory(): boolean;
    isFile(): boolean;
  }) => {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) return productionTypeScriptFiles(path);
    return entry.isFile() && path.endsWith('.ts') ? [path] : [];
  });
}

type ShadowViolationKind = 'NAMESPACE_IMPORT' | 'DEFAULT_IMPORT' | 'DYNAMIC_IMPORT';

interface ShadowUsageAnalysis {
  imports: Array<{ file: string; localName: string }>;
  calls: Array<{ file: string; localName: string; inDualHorizonRoute: boolean }>;
  references: Array<{ file: string; localName: string; inDualHorizonRoute: boolean; isDirectCall: boolean }>;
  routes: Array<{ file: string; start: number; end: number }>;
  violations: Array<{ file: string; kind: ShadowViolationKind }>;
}

function isDualHorizonModule(file: string, moduleSpecifier: string): boolean {
  if (!moduleSpecifier.startsWith('.')) return false;
  const candidate = resolve(dirname(file), moduleSpecifier);
  return normalize(candidate.endsWith('.ts') ? candidate : `${candidate}.ts`)
    .endsWith('/dual-horizon-confidence.ts');
}

function isDualHorizonRouteCondition(condition: ts.Expression): boolean {
  if (!ts.isBinaryExpression(condition) || condition.operatorToken.kind !== ts.SyntaxKind.EqualsEqualsEqualsToken) {
    return false;
  }
  return [condition.left, condition.right].some(operand =>
    ts.isStringLiteral(operand) && operand.text === '/api/v1/challengers/dual-horizon');
}

function analyzeDualHorizonShadowUsage(files: Map<string, string>): ShadowUsageAnalysis {
  const sources = new Map([...files].map(([file, text]) => [normalize(file), text]));
  const options: ts.CompilerOptions = {
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Node10,
    target: ts.ScriptTarget.ESNext,
    skipLibCheck: true,
  };
  const baseHost = ts.createCompilerHost(options, true);
  const host: ts.CompilerHost = {
    ...baseHost,
    fileExists: file => sources.has(normalize(file)) || baseHost.fileExists(file),
    readFile: file => sources.get(normalize(file)) ?? baseHost.readFile(file),
    getSourceFile: (file, languageVersion) => {
      const text = sources.get(normalize(file)) ?? baseHost.readFile(file);
      return text == null ? undefined : ts.createSourceFile(file, text, languageVersion, true);
    },
  };
  const program = ts.createProgram({ rootNames: [...sources.keys()], options, host });
  const checker = program.getTypeChecker();
  const imports: ShadowUsageAnalysis['imports'] = [];
  const calls: ShadowUsageAnalysis['calls'] = [];
  const references: ShadowUsageAnalysis['references'] = [];
  const routes: ShadowUsageAnalysis['routes'] = [];
  const violations: ShadowUsageAnalysis['violations'] = [];
  const bindings: Array<{ file: string; localName: string; symbol: ts.Symbol }> = [];
  const sourceFiles = [...sources.keys()].map(file => program.getSourceFile(file)!).filter(Boolean);

  for (const sourceFile of sourceFiles) {
    const file = normalize(sourceFile.fileName);
    const visit = (node: ts.Node): void => {
      if (file.endsWith('/worker.ts') && ts.isIfStatement(node)
        && isDualHorizonRouteCondition(node.expression)) {
        routes.push({ file, start: node.thenStatement.getStart(sourceFile), end: node.thenStatement.end });
      }
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)
        && isDualHorizonModule(file, node.moduleSpecifier.text)) {
        const clause = node.importClause;
        if (clause?.name) violations.push({ file, kind: 'DEFAULT_IMPORT' });
        if (clause?.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
          violations.push({ file, kind: 'NAMESPACE_IMPORT' });
        }
        if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
          for (const specifier of clause.namedBindings.elements) {
            const importedName = specifier.propertyName?.text ?? specifier.name.text;
            if (importedName !== 'buildDualHorizonShadow') continue;
            const symbol = checker.getSymbolAtLocation(specifier.name);
            if (!symbol) continue;
            imports.push({ file, localName: specifier.name.text });
            bindings.push({ file, localName: specifier.name.text, symbol });
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }

  for (const sourceFile of sourceFiles) {
    const file = normalize(sourceFile.fileName);
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
          violations.push({ file, kind: 'DYNAMIC_IMPORT' });
        } else if (ts.isIdentifier(node.expression)) {
          const symbol = checker.getSymbolAtLocation(node.expression);
          const binding = bindings.find(candidate => candidate.symbol === symbol);
          if (binding) {
            const start = node.getStart(sourceFile);
            calls.push({
              file,
              localName: binding.localName,
              inDualHorizonRoute: routes.some(route => route.file === file && start >= route.start && start < route.end),
            });
          }
        }
      } else if (ts.isIdentifier(node) && !ts.isImportSpecifier(node.parent)) {
        const symbol = checker.getSymbolAtLocation(node);
        const binding = bindings.find(candidate => candidate.symbol === symbol);
        if (binding) {
          const start = node.getStart(sourceFile);
          references.push({
            file,
            localName: binding.localName,
            inDualHorizonRoute: routes.some(route => route.file === file && start >= route.start && start < route.end),
            isDirectCall: ts.isCallExpression(node.parent) && node.parent.expression === node,
          });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }

  return { imports, calls, references, routes, violations };
}

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

  it('detects aliased, namespace, and dynamic Shadow imports with the compiler AST', () => {
    const analysis = analyzeDualHorizonShadowUsage(new Map([
      ['/virtual/src/dual-horizon-confidence.ts', 'export function buildDualHorizonShadow() {}'],
      ['/virtual/src/worker.ts', `
        import { buildDualHorizonShadow as compose } from "./dual-horizon-confidence";
        const p = '/api/v1/challengers/dual-horizon';
        if (p === '/api/v1/challengers/dual-horizon') compose();
      `],
      ['/virtual/src/rogue-alias.ts', `
        import { buildDualHorizonShadow as compose } from './dual-horizon-confidence';
        compose();
      `],
      ['/virtual/src/rogue-forward.ts', `
        import { buildDualHorizonShadow as compose } from './dual-horizon-confidence';
        const forwarded = compose;
        forwarded();
      `],
      ['/virtual/src/rogue-namespace.ts', `
        import * as shadow from './dual-horizon-confidence';
        shadow.buildDualHorizonShadow();
      `],
      ['/virtual/src/rogue-dynamic.ts', 'void import("./dual-horizon-confidence");'],
    ]));

    expect(analysis.imports).toEqual(expect.arrayContaining([
      { file: '/virtual/src/worker.ts', localName: 'compose' },
      { file: '/virtual/src/rogue-alias.ts', localName: 'compose' },
    ]));
    expect(analysis.calls).toEqual(expect.arrayContaining([
      expect.objectContaining({ file: '/virtual/src/worker.ts', localName: 'compose', inDualHorizonRoute: true }),
      expect.objectContaining({ file: '/virtual/src/rogue-alias.ts', localName: 'compose', inDualHorizonRoute: false }),
    ]));
    expect(analysis.references).toEqual(expect.arrayContaining([
      expect.objectContaining({ file: '/virtual/src/rogue-forward.ts', localName: 'compose', isDirectCall: false }),
    ]));
    expect(analysis.violations).toEqual(expect.arrayContaining([
      { file: '/virtual/src/rogue-namespace.ts', kind: 'NAMESPACE_IMPORT' },
      { file: '/virtual/src/rogue-dynamic.ts', kind: 'DYNAMIC_IMPORT' },
    ]));
  });

  it('confines dual-horizon Shadow composition to its challenger route', () => {
    const worker = normalize(resolve('src/worker.ts'));
    const analysis = analyzeDualHorizonShadowUsage(new Map(
      productionTypeScriptFiles().map(path => [normalize(resolve(path)), read(path)]),
    ));
    const [route] = analysis.routes.filter(candidate => candidate.file === worker);

    expect(analysis.violations).toEqual([]);
    expect(analysis.imports).toEqual([{ file: worker, localName: 'buildDualHorizonShadow' }]);
    expect(analysis.calls).toEqual([
      { file: worker, localName: 'buildDualHorizonShadow', inDualHorizonRoute: true },
    ]);
    expect(analysis.references).toEqual([
      { file: worker, localName: 'buildDualHorizonShadow', inDualHorizonRoute: true, isDirectCall: true },
    ]);
    expect(route?.start).toBeGreaterThanOrEqual(0);
    expect(route?.end).toBeGreaterThan(route?.start ?? Infinity);
  });
});
