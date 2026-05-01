/**
 * Schema audit — diff the live Postgres schema against what's defined in the repo.
 *
 * Read-only. Issues only SELECTs against information_schema and pg_catalog.
 * Reports tables/columns/enums present in the DB but not in any repo file
 * (and vice versa), so we can see manual ALTERs, drift, and unapplied migrations.
 *
 * Run:  node schema-audit.js
 * Or:   node schema-audit.js --json    (machine-readable output)
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const REPO_DIR = __dirname;
const SQL_FILES = ['schema.sql', 'schema-scraper-runs.sql', 'schema-security.sql', 'schema-ml.sql', 'conversations.sql'];

// ─── Repo parsing ────────────────────────────────────────────────────────

function readRepoSources() {
  const sources = [];
  for (const f of SQL_FILES) {
    const p = path.join(REPO_DIR, f);
    if (fs.existsSync(p)) sources.push({ file: f, text: fs.readFileSync(p, 'utf8') });
  }
  for (const f of fs.readdirSync(REPO_DIR)) {
    if (/^migrate-.*\.js$/.test(f)) {
      sources.push({ file: f, text: fs.readFileSync(path.join(REPO_DIR, f), 'utf8') });
    }
  }
  return sources;
}

function extractCreateTableBlocks(text) {
  const blocks = [];
  const re = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["`]?(\w+)["`]?\s*\(/gi;
  let m;
  while ((m = re.exec(text)) !== null) {
    const tableName = m[1];
    let depth = 1;
    let i = m.index + m[0].length;
    while (i < text.length && depth > 0) {
      const ch = text[i];
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
      i++;
    }
    if (depth === 0) blocks.push({ table: tableName.toLowerCase(), body: text.substring(m.index + m[0].length, i - 1) });
  }
  return blocks;
}

function extractColumnsFromBody(body) {
  // Strip line comments, then split on top-level commas.
  const stripped = body.replace(/--.*$/gm, '');
  const segments = [];
  let depth = 0;
  let buf = '';
  for (const ch of stripped) {
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      if (buf.trim()) segments.push(buf.trim());
      buf = '';
    } else {
      buf += ch;
    }
  }
  if (buf.trim()) segments.push(buf.trim());

  const skip = new Set(['PRIMARY', 'FOREIGN', 'UNIQUE', 'CONSTRAINT', 'CHECK', 'EXCLUDE', 'LIKE']);
  const cols = [];
  for (const seg of segments) {
    const m = seg.match(/^["`]?([A-Za-z_]\w*)["`]?/);
    if (!m) continue;
    const name = m[1];
    if (skip.has(name.toUpperCase())) continue;
    cols.push(name.toLowerCase());
  }
  return cols;
}

function extractAlterAddColumns(text) {
  const adds = [];
  const re = /ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?["`]?(\w+)["`]?\s+ADD\s+(?:COLUMN\s+)?(?:IF\s+NOT\s+EXISTS\s+)?["`]?(\w+)["`]?/gi;
  let m;
  while ((m = re.exec(text)) !== null) {
    adds.push({ table: m[1].toLowerCase(), column: m[2].toLowerCase() });
  }
  return adds;
}

function extractCreateTypes(text) {
  const types = [];
  const re = /CREATE\s+TYPE\s+["`]?(\w+)["`]?\s+AS\s+ENUM\s*\(([^)]*)\)/gi;
  let m;
  while ((m = re.exec(text)) !== null) {
    const values = m[2].split(',').map(s => s.trim().replace(/^['"]|['"]$/g, ''));
    types.push({ name: m[1].toLowerCase(), values });
  }
  return types;
}

function buildRepoSchema() {
  const sources = readRepoSources();
  const tables = new Map(); // tableName -> { columns: Set, definedIn: Set<file> }
  const types = new Map();  // typeName -> { values: [], definedIn: Set<file> }

  for (const { file, text } of sources) {
    for (const block of extractCreateTableBlocks(text)) {
      if (!tables.has(block.table)) tables.set(block.table, { columns: new Set(), definedIn: new Set() });
      const entry = tables.get(block.table);
      for (const c of extractColumnsFromBody(block.body)) entry.columns.add(c);
      entry.definedIn.add(file);
    }
    for (const { table, column } of extractAlterAddColumns(text)) {
      if (!tables.has(table)) tables.set(table, { columns: new Set(), definedIn: new Set() });
      tables.get(table).columns.add(column);
      tables.get(table).definedIn.add(file);
    }
    for (const t of extractCreateTypes(text)) {
      if (!types.has(t.name)) types.set(t.name, { values: t.values, definedIn: new Set() });
      types.get(t.name).definedIn.add(file);
    }
  }

  return { tables, types };
}

// ─── Live DB introspection ───────────────────────────────────────────────

async function fetchLiveSchema(pool) {
  const tablesRes = await pool.query(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
     ORDER BY table_name`
  );
  const colsRes = await pool.query(
    `SELECT table_name, column_name, data_type, is_nullable
     FROM information_schema.columns
     WHERE table_schema = 'public'
     ORDER BY table_name, ordinal_position`
  );
  const typesRes = await pool.query(
    `SELECT t.typname AS name, e.enumlabel AS value
     FROM pg_type t
     JOIN pg_enum e ON e.enumtypid = t.oid
     JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
     WHERE n.nspname = 'public'
     ORDER BY t.typname, e.enumsortorder`
  );

  const tables = new Map(); // tableName -> Set<column>
  for (const r of tablesRes.rows) tables.set(r.table_name.toLowerCase(), new Set());
  for (const r of colsRes.rows) {
    const t = r.table_name.toLowerCase();
    if (!tables.has(t)) tables.set(t, new Set());
    tables.get(t).add(r.column_name.toLowerCase());
  }
  const types = new Map(); // typeName -> [values]
  for (const r of typesRes.rows) {
    const n = r.name.toLowerCase();
    if (!types.has(n)) types.set(n, []);
    types.get(n).push(r.value);
  }
  return { tables, types };
}

// ─── Diff + report ───────────────────────────────────────────────────────

function diff(repo, live) {
  const repoTables = new Set(repo.tables.keys());
  const liveTables = new Set(live.tables.keys());

  const tablesOnlyInDB = [...liveTables].filter(t => !repoTables.has(t)).sort();
  const tablesOnlyInRepo = [...repoTables].filter(t => !liveTables.has(t)).sort();
  const tablesInBoth = [...liveTables].filter(t => repoTables.has(t)).sort();

  const columnDiffs = [];
  for (const t of tablesInBoth) {
    const repoCols = repo.tables.get(t).columns;
    const liveCols = live.tables.get(t);
    const onlyInDB = [...liveCols].filter(c => !repoCols.has(c)).sort();
    const onlyInRepo = [...repoCols].filter(c => !liveCols.has(c)).sort();
    if (onlyInDB.length || onlyInRepo.length) {
      columnDiffs.push({ table: t, onlyInDB, onlyInRepo });
    }
  }

  const repoTypes = new Set(repo.types.keys());
  const liveTypes = new Set(live.types.keys());
  const typesOnlyInDB = [...liveTypes].filter(t => !repoTypes.has(t)).sort();
  const typesOnlyInRepo = [...repoTypes].filter(t => !liveTypes.has(t)).sort();

  return { tablesOnlyInDB, tablesOnlyInRepo, tablesInBoth, columnDiffs, typesOnlyInDB, typesOnlyInRepo };
}

function renderText(repo, live, d) {
  const lines = [];
  const push = (s = '') => lines.push(s);

  push('=== SUREPATH SCHEMA AUDIT ===');
  push(`Generated: ${new Date().toISOString()}`);
  push(`Repo files scanned: ${SQL_FILES.length} SQL + ${[...new Set([].concat(...[...repo.tables.values()].map(v => [...v.definedIn])))].filter(f => f.startsWith('migrate-')).length} migrate-*.js`);
  push(`DB tables: ${live.tables.size}   Repo tables: ${repo.tables.size}`);
  push('');

  push('── TABLES ──────────────────────────────────────────');
  push(`Matched (in both): ${d.tablesInBoth.length}`);
  push('');
  push(`In DB but NOT in any repo file (${d.tablesOnlyInDB.length}):`);
  if (d.tablesOnlyInDB.length === 0) push('  (none — clean)');
  else for (const t of d.tablesOnlyInDB) {
    const cols = [...live.tables.get(t)];
    push(`  • ${t}  (${cols.length} cols)`);
  }
  push('');
  push(`In repo but NOT in DB (${d.tablesOnlyInRepo.length}):`);
  if (d.tablesOnlyInRepo.length === 0) push('  (none — clean)');
  else for (const t of d.tablesOnlyInRepo) {
    const definedIn = [...repo.tables.get(t).definedIn].join(', ');
    push(`  • ${t}  (defined in: ${definedIn})`);
  }
  push('');

  push('── COLUMN DIFFS (tables in both) ──────────────────');
  if (d.columnDiffs.length === 0) push('All matched tables have identical column sets. ✓');
  else for (const cd of d.columnDiffs) {
    push(`  TABLE: ${cd.table}`);
    if (cd.onlyInDB.length) {
      push(`    + In DB only (${cd.onlyInDB.length}): ${cd.onlyInDB.join(', ')}`);
    }
    if (cd.onlyInRepo.length) {
      push(`    - In repo only (${cd.onlyInRepo.length}): ${cd.onlyInRepo.join(', ')}`);
    }
  }
  push('');

  push('── ENUM TYPES ─────────────────────────────────────');
  push(`In DB but NOT in repo (${d.typesOnlyInDB.length}): ${d.typesOnlyInDB.join(', ') || '(none)'}`);
  push(`In repo but NOT in DB (${d.typesOnlyInRepo.length}): ${d.typesOnlyInRepo.join(', ') || '(none)'}`);
  push('');

  push('── SUMMARY ────────────────────────────────────────');
  const orphanCols = d.columnDiffs.reduce((s, c) => s + c.onlyInDB.length, 0);
  const missingCols = d.columnDiffs.reduce((s, c) => s + c.onlyInRepo.length, 0);
  push(`Orphan tables (DB only):   ${d.tablesOnlyInDB.length}`);
  push(`Missing tables (repo only): ${d.tablesOnlyInRepo.length}`);
  push(`Orphan columns (DB only):   ${orphanCols}    ← these are likely manual ALTERs not in the repo`);
  push(`Missing columns (repo only): ${missingCols}    ← code may reference these and silently fail`);

  return lines.join('\n');
}

// ─── Main ────────────────────────────────────────────────────────────────

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is not set. Aborting.');
    process.exit(2);
  }
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const repo = buildRepoSchema();
    const live = await fetchLiveSchema(pool);
    const d = diff(repo, live);

    if (process.argv.includes('--json')) {
      const json = {
        generated_at: new Date().toISOString(),
        live_tables: live.tables.size,
        repo_tables: repo.tables.size,
        tables_only_in_db: d.tablesOnlyInDB,
        tables_only_in_repo: d.tablesOnlyInRepo.map(t => ({ table: t, defined_in: [...repo.tables.get(t).definedIn] })),
        column_diffs: d.columnDiffs,
        types_only_in_db: d.typesOnlyInDB,
        types_only_in_repo: d.typesOnlyInRepo,
      };
      console.log(JSON.stringify(json, null, 2));
    } else {
      console.log(renderText(repo, live, d));
    }
  } finally {
    await pool.end();
  }
}

main().catch(err => {
  console.error('Audit failed:', err.message);
  process.exit(1);
});
