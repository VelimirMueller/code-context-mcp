/**
 * Generate a legacy context.db fixture from a historical schema version.
 *
 * Usage: pnpm exec tsx scripts/make-legacy-fixture.mts <git-ref> <out-name>
 *   pnpm exec tsx scripts/make-legacy-fixture.mts cc8c557 pre-versioning   # before schema_versions existed
 *   pnpm exec tsx scripts/make-legacy-fixture.mts v1.2.1 v1.2.1
 *   pnpm exec tsx scripts/make-legacy-fixture.mts v1.3.1 v1.3.1
 *   pnpm exec tsx scripts/make-legacy-fixture.mts v2.5.1 v2.5.1     # last schema before milestone/epic archived_at
 *
 * Extracts src/scrum/schema.ts (+ src/server/schema.ts when present) at <git-ref>,
 * runs the era's init/migrate functions against a temp DB, seeds deterministic data,
 * and dumps SQL to test/fixtures/legacy-dbs/<out-name>.sql.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';

const [ref, outName] = process.argv.slice(2);
if (!ref || !outName) {
  console.error('Usage: pnpm exec tsx scripts/make-legacy-fixture.mts <git-ref> <out-name>');
  process.exit(1);
}

function gitShow(p: string): string | null {
  try {
    return execFileSync('git', ['show', `${ref}:${p}`], { encoding: 'utf-8' });
  } catch {
    return null;
  }
}

// The extracted schema modules import better-sqlite3 at runtime (v2.x+), so the temp dir
// must sit under the repo's node_modules for bare-specifier resolution to work.
const cacheDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../node_modules/.cache',
);
fs.mkdirSync(cacheDir, { recursive: true });
const tmp = fs.mkdtempSync(path.join(cacheDir, 'legacy-fixture-'));
const scrumSrc = gitShow('src/scrum/schema.ts');
if (!scrumSrc) {
  console.error(`No src/scrum/schema.ts at ${ref}`);
  process.exit(1);
}
const serverSrc = gitShow('src/server/schema.ts');
fs.writeFileSync(path.join(tmp, 'scrum-schema.ts'), scrumSrc);
if (serverSrc) fs.writeFileSync(path.join(tmp, 'server-schema.ts'), serverSrc);

const scrum = await import(pathToFileURL(path.join(tmp, 'scrum-schema.ts')).href);
const server = serverSrc
  ? await import(pathToFileURL(path.join(tmp, 'server-schema.ts')).href)
  : null;

const db = new Database(path.join(tmp, 'context.db'));
if (server?.initSchema) server.initSchema(db);
scrum.initScrumSchema(db);
if (typeof scrum.runMigrations === 'function') scrum.runMigrations(db); // pre-versioning eras lack it

// Deterministic seed data — uses only columns that exist in every supported era.
// If an era rejects a statement, FAIL LOUDLY: adjust here, never silently skip.
db.exec(`
  INSERT INTO sprints (name, goal, status) VALUES ('Fixture Sprint 1', 'Legacy fixture goal', 'planning');
  INSERT INTO tickets (sprint_id, ticket_ref, title, priority, status, story_points)
    VALUES (1, 'T-1', 'Legacy ticket one', 'P1', 'DONE', 3),
           (1, 'T-2', 'Legacy ticket two', 'P2', 'TODO', 5);
  INSERT INTO retro_findings (sprint_id, category, finding) VALUES (1, 'try_next', 'Legacy try-next finding');
  INSERT INTO agents (role, name) VALUES ('legacy-dev', 'Legacy Dev');
  INSERT INTO skills (name, content) VALUES ('LEGACY_SKILL', 'legacy content');
`);
const has = (t: string) =>
  !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t);
if (has('decisions')) db.exec("INSERT INTO decisions (title) VALUES ('Legacy decision')");
if (has('discoveries'))
  db.exec("INSERT INTO discoveries (discovery_sprint_id, finding) VALUES (1, 'Legacy discovery')");
// Milestone + epic rows (v2.6.0 archive migration must preserve them and default archived_at to NULL)
if (has('milestones'))
  db.exec("INSERT INTO milestones (name, status) VALUES ('Legacy milestone', 'completed')");
if (has('epics'))
  db.exec("INSERT INTO epics (name, status, milestone_id) VALUES ('Legacy epic', 'completed', 1)");
if (has('event_log'))
  db.exec("INSERT INTO event_log (entity_type, entity_id, action) VALUES ('ticket', 1, 'created')");

function sqlLit(v: unknown): string {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number' || typeof v === 'bigint') return String(v);
  if (Buffer.isBuffer(v)) return `X'${v.toString('hex')}'`;
  return `'${String(v).replace(/'/g, "''")}'`;
}

const lines: string[] = ['PRAGMA foreign_keys=OFF;', 'BEGIN TRANSACTION;'];
const objs = db
  .prepare(
    `SELECT type, name, sql FROM sqlite_master
     WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'
     ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 WHEN 'view' THEN 2 ELSE 3 END, rowid`,
  )
  .all() as Array<{ type: string; name: string; sql: string }>;
for (const o of objs.filter((o) => o.type === 'table')) {
  lines.push(o.sql + ';');
  const rows = db.prepare(`SELECT * FROM "${o.name}"`).all() as Array<Record<string, unknown>>;
  for (const row of rows) {
    const cols = Object.keys(row);
    lines.push(
      `INSERT INTO "${o.name}" (${cols.map((c) => `"${c}"`).join(', ')}) VALUES (${cols.map((c) => sqlLit(row[c])).join(', ')});`,
    );
  }
}
try {
  for (const r of db.prepare('SELECT name, seq FROM sqlite_sequence').all() as any[]) {
    lines.push(
      `INSERT OR REPLACE INTO sqlite_sequence (name, seq) VALUES ('${r.name}', ${r.seq});`,
    );
  }
} catch {
  /* no AUTOINCREMENT tables in this era */
}
for (const o of objs.filter((o) => o.type !== 'table')) lines.push(o.sql + ';');
lines.push('COMMIT;');

// Resolve output directory relative to this script's location.
// import.meta.dirname requires Node 20.11+; fall back to fileURLToPath for older runtimes.
const scriptDir: string =
  typeof import.meta.dirname === 'string'
    ? import.meta.dirname
    : path.dirname(fileURLToPath(import.meta.url));

const outDir = path.resolve(scriptDir, '../test/fixtures/legacy-dbs');
fs.mkdirSync(outDir, { recursive: true });
const outPath = path.join(outDir, `${outName}.sql`);
fs.writeFileSync(outPath, lines.join('\n') + '\n');
db.close();
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`Wrote ${outPath} (${lines.length} statements) from ${ref}`);
