#!/usr/bin/env node
import { readdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { Miniflare } from 'miniflare';

const migrationFiles = readdirSync('migrations')
  .filter(name => /^\d{4}_.+\.sql$/.test(name))
  .sort();
const corruptionMode = process.argv.find(arg => arg.startsWith('--corrupt-after-restore='))
  ?.slice('--corrupt-after-restore='.length);

// Split only on SQL statement boundaries. Unlike the old drill, this preserves
// every byte inside quoted values (including repeated spaces and newlines).
function splitSqlStatements(sql) {
  const statements = [];
  let current = '';
  let quote = null;
  let lineComment = false;
  let blockComment = false;
  for (let index = 0; index < sql.length; index += 1) {
    const char = sql[index];
    const next = sql[index + 1];
    current += char;
    if (lineComment) {
      if (char === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      if (char === '*' && next === '/') {
        current += next;
        index += 1;
        blockComment = false;
      }
      continue;
    }
    if (quote != null) {
      if (char === quote && next === quote) {
        current += next;
        index += 1;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === '-' && next === '-') {
      current += next;
      index += 1;
      lineComment = true;
      continue;
    }
    if (char === '/' && next === '*') {
      current += next;
      index += 1;
      blockComment = true;
      continue;
    }
    if (char === "'" || char === '"' || char === '`') {
      quote = char;
      continue;
    }
    if (char !== ';') continue;
    const trigger = /(?:^|\n)\s*CREATE\s+TRIGGER\b/i.test(current);
    if (trigger && !/\bEND\s*;\s*$/i.test(current)) continue;
    if (current.trim()) statements.push(current);
    current = '';
  }
  if (current.trim()) statements.push(current);
  return statements;
}

async function executeSql(db, sql) {
  for (const statement of splitSqlStatements(sql)) await db.prepare(statement).run();
}

function identifier(name) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`unsafe SQL identifier: ${name}`);
  return `"${name}"`;
}

function sqlValue(value) {
  if (value == null) return 'NULL';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('non-finite numeric export value');
    return String(value);
  }
  if (typeof value === 'boolean') return value ? '1' : '0';
  if (value instanceof ArrayBuffer) {
    return `X'${Buffer.from(value).toString('hex')}'`;
  }
  if (ArrayBuffer.isView(value)) {
    return `X'${Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString('hex')}'`;
  }
  return `'${String(value).replaceAll("'", "''")}'`;
}

async function createRuntime() {
  const mf = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response(); } }',
    d1Databases: ['DB'],
  });
  return { mf, db: await mf.getD1Database('DB') };
}

async function applyMigrations(db) {
  await executeSql(db, `CREATE TABLE d1_migrations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    applied_at TEXT NOT NULL
  );`);
  for (const file of migrationFiles) {
    await executeSql(db, readFileSync(`migrations/${file}`, 'utf8'));
    await db.prepare(
      "INSERT INTO d1_migrations(name,applied_at) VALUES (?, '2026-07-22T00:00:00Z')",
    ).bind(file).run();
  }
}

async function seedRepresentativeData(db) {
  const hash = 'a'.repeat(64);
  const sha = '0123456789abcdef0123456789abcdef01234567';
  await db.batch([
    db.prepare(`INSERT INTO ingest_runs
      (run_id,state,mode,started_at,completed_at,row_count,series_count,activated_at)
      VALUES ('restore-run','ACTIVE','FULL','2024-01-10T00:00:00Z','2024-01-10T00:01:00Z',3,3,'2024-01-10T00:01:00Z')`),
    db.prepare("INSERT INTO observations(series_id,date,value) VALUES ('WALCL','2024-01-03',5800)"),
    db.prepare("INSERT INTO meta(key,value) VALUES ('restore_whitespace','alpha  beta\n gamma')"),
    db.prepare(`INSERT INTO model_snapshot_weekly
      (date,decision_week,walcl,verdict,score,spx,factors_json,decision_status,
       data_run_id,data_cutoff,decision_at,tradable_at,release_resolution_at,pit_status,
       model_version,config_hash,code_commit_sha,created_at,recorded_at)
      VALUES ('2024-01-03','2024-01-01',5800,'BULLISH',60,4700,'{}','OK',
       'restore-run','2024-01-04T23:59:59Z','2024-01-05T00:00:00Z','2024-01-05T14:30:00Z',
       '2024-01-10T00:00:00Z','PIT','champion-v1.0.0',?,?,
       '2024-01-10T00:01:00Z','2024-01-10T00:01:00Z')`).bind(hash, sha),
    db.prepare(`INSERT INTO nowcast_snapshot_daily
      (date,channel_status,verdict,score,factors_json,decision_status,data_run_id,data_cutoff,
       decision_at,tradable_at,release_resolution_at,pit_status,model_version,config_hash,
       code_commit_sha,created_at)
      VALUES ('2024-01-04','PROVISIONAL','BULLISH',60,'{}','OK','restore-run',
       '2024-01-04T23:59:59Z','2024-01-05T00:00:00Z','2024-01-05T14:30:00Z',
       '2024-01-10T00:00:00Z','PIT','champion-v1.0.0',?,?,'2024-01-10T00:01:00Z')`).bind(hash, sha),
    db.prepare(`INSERT INTO snapshot_inputs
      (snapshot_channel,decision_week,snapshot_date,data_run_id,series_id,input_status,
       observation_date,vintage_date,released_at,tradable_at,value,source,checksum)
      VALUES ('OFFICIAL','2024-01-01','2024-01-03','restore-run','WALCL','AVAILABLE',
       '2024-01-03','2024-01-04','2024-01-04T23:59:59Z','2024-01-05T14:30:00Z',5800,'ALFRED','walcl')`),
    db.prepare(`INSERT INTO market_prices_daily
      (symbol,date,close,adjusted_close,source,fetched_at,data_run_id,activation_run_id,activated_at,provenance_status)
      VALUES ('SPX','2024-01-05',4700,4700,'TEST','2024-01-10T00:00:00Z','restore-run','restore-run','2024-01-10T00:01:00Z','PIT_RAW')`),
    db.prepare(`INSERT INTO cash_rates_daily
      (rate_id,date,rate,source,fetched_at,data_run_id,activation_run_id,activated_at,provenance_status)
      VALUES ('SOFR','2024-01-04',5.3,'TEST','2024-01-10T00:00:00Z','restore-run','restore-run','2024-01-10T00:01:00Z','PIT_RAW')`),
  ]);
}

async function exportSql(db) {
  const schema = await db.prepare(`SELECT type,name,tbl_name,sql FROM sqlite_schema
    WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'
    ORDER BY name`).all();
  const objects = schema.results;
  const tables = objects.filter(row => row.type === 'table');
  const createTables = tables.map(row => `${row.sql};`).join('\n');
  const inserts = [];
  const tablePriority = ['ingest_runs', 'ingest_series_attempts'];
  tables.sort((a, b) => {
    const left = tablePriority.indexOf(a.name);
    const right = tablePriority.indexOf(b.name);
    if (left !== right) return (left < 0 ? 999 : left) - (right < 0 ? 999 : right);
    return a.name.localeCompare(b.name);
  });
  for (const table of tables) {
    const columns = await db.prepare(`PRAGMA table_info(${identifier(table.name)})`).all();
    const names = columns.results.map(column => column.name);
    const order = names.length > 0 ? ` ORDER BY ${names.map(identifier).join(',')}` : '';
    const rows = await db.prepare(`SELECT * FROM ${identifier(table.name)}${order}`).all();
    for (const row of rows.results) {
      inserts.push(`INSERT INTO ${identifier(table.name)} (${names.map(identifier).join(',')}) VALUES (${names.map(name => sqlValue(row[name])).join(',')});`);
    }
  }
  const deferredSchema = objects
    .filter(row => row.type !== 'table')
    .sort((a, b) => ({ index: 0, view: 1, trigger: 2 }[a.type] ?? 9)
      - ({ index: 0, view: 1, trigger: 2 }[b.type] ?? 9) || a.name.localeCompare(b.name))
    .map(row => `${row.sql};`)
    .join('\n');
  const sql = `${createTables}\n${inserts.join('\n')}\n${deferredSchema}\n`;
  return { sql, contentHash: createHash('sha256').update(sql).digest('hex') };
}

async function inspect(db) {
  const schema = await db.prepare(`SELECT type,name FROM sqlite_schema
    WHERE name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name`).all();
  const names = type => schema.results.filter(row => row.type === type).map(row => row.name);
  const tables = names('table');
  const rowCounts = {};
  for (const table of tables) {
    rowCounts[table] = (await db.prepare(`SELECT COUNT(*) AS n FROM ${identifier(table)}`).first()).n;
  }
  const latestSnapshot = await db.prepare(
    `SELECT date,model_version,config_hash,code_commit_sha,data_run_id,data_cutoff,decision_at,created_at
     FROM model_snapshot_weekly ORDER BY date DESC LIMIT 1`,
  ).first();
  const backtestRows = await db.prepare(
    `SELECT date,score,spx FROM model_snapshot_weekly
     WHERE decision_status='OK' AND score IS NOT NULL AND spx IS NOT NULL ORDER BY date`,
  ).all();
  const whitespaceValue = (await db.prepare(
    "SELECT value FROM meta WHERE key='restore_whitespace'",
  ).first()).value;
  const migrations = (await db.prepare('SELECT COUNT(*) AS n FROM d1_migrations').first()).n;
  return {
    tables, indexes: names('index'), triggers: names('trigger'), rowCounts, latestSnapshot,
    migrations, whitespaceValue,
    applicationQueries: { latestSnapshot: latestSnapshot != null, backtestRows: backtestRows.results.length > 0 },
  };
}

const source = await createRuntime();
const restored = await createRuntime();
try {
  await applyMigrations(source.db);
  await seedRepresentativeData(source.db);
  const exported = await exportSql(source.db);
  await executeSql(restored.db, exported.sql);
  if (corruptionMode === 'release-calendar-source-url') {
    await restored.db.prepare(`UPDATE release_calendar
      SET source_url=source_url || '#corrupted' WHERE series_id='WALCL'`).run();
  } else if (corruptionMode != null) {
    throw new Error(`unsupported restore corruption mode: ${corruptionMode}`);
  }
  const restoredExport = await exportSql(restored.db);
  if (restoredExport.contentHash !== exported.contentHash) {
    throw new Error('restored export content hash mismatch');
  }
  const first = await inspect(source.db);
  const second = await inspect(restored.db);
  if (JSON.stringify(first) !== JSON.stringify(second)) throw new Error('restored schema/data metadata mismatch');
  if (second.whitespaceValue !== 'alpha  beta\n gamma') throw new Error('SQL whitespace value changed during restore');
  if (second.latestSnapshot?.model_version !== 'champion-v1.0.0'
    || !/^[a-f0-9]{64}$/.test(second.latestSnapshot.config_hash)) {
    throw new Error('latest snapshot governance metadata invalid');
  }
  process.stdout.write(JSON.stringify({
    status: 'PASS', remoteAccess: false, contentHash: exported.contentHash,
    restoredContentHash: restoredExport.contentHash,
    migrations: { first: first.migrations, restored: second.migrations },
    tables: second.tables, indexes: second.indexes, triggers: second.triggers,
    rowCounts: second.rowCounts, latestSnapshot: second.latestSnapshot,
    applicationQueries: second.applicationQueries, whitespaceValue: second.whitespaceValue,
  }) + '\n');
} finally {
  await Promise.all([source.mf.dispose(), restored.mf.dispose()]);
}
