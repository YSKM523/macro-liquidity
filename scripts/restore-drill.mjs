#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { Miniflare } from 'miniflare';

const fixture = process.argv.find(arg => arg.startsWith('--fixture='))?.slice('--fixture='.length)
  ?? 'test/fixtures/restore-drill.sql';
const manifestPath = process.argv.find(arg => arg.startsWith('--manifest='))?.slice('--manifest='.length)
  ?? 'test/fixtures/restore-drill-manifest.json';
const sql = readFileSync(fixture, 'utf8');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const hash = createHash('sha256').update(sql).digest('hex');
if (hash !== manifest.sqlSha256) throw new Error('restore fixture content hash mismatch');

const mf = new Miniflare({
  modules: true,
  script: 'export default { fetch() { return new Response(); } }',
  d1Databases: ['DB'],
});
try {
  const db = await mf.getD1Database('DB');
  const executableSql = sql.replace(/^\s*--.*$/gm, '').replace(/\s+/g, ' ');
  await db.exec(executableSql);
  const expectedTables = Object.keys(manifest.rowCounts);
  const present = await db.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").all();
  const tables = present.results.map(row => row.name);
  for (const table of expectedTables) {
    if (!tables.includes(table)) throw new Error(`required table missing: ${table}`);
    if (!/^[a-z_]+$/.test(table)) throw new Error('unsafe manifest table name');
    const count = await db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first();
    if (count.n !== manifest.rowCounts[table]) throw new Error(`row count mismatch: ${table}`);
  }
  const latestSnapshot = await db.prepare(
    `SELECT date,model_version,config_hash,code_commit_sha,data_run_id,data_cutoff,decision_at,created_at
     FROM model_snapshot_weekly ORDER BY date DESC LIMIT 1`,
  ).first();
  if (!latestSnapshot || latestSnapshot.date !== manifest.latestSnapshotDate
    || latestSnapshot.model_version === 'LEGACY_UNVERSIONED'
    || !/^[a-f0-9]{64}$/.test(latestSnapshot.config_hash)) {
    throw new Error('latest snapshot governance metadata invalid');
  }
  process.stdout.write(JSON.stringify({
    status: 'PASS', remoteAccess: false, contentHash: hash, tables: expectedTables,
    rowCounts: manifest.rowCounts, latestSnapshot,
  }) + '\n');
} finally {
  await mf.dispose();
}
