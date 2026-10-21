// Seed a throwaway database, then start the built dashboard on it (Playwright webServer).
// Usage: node test/e2e/serve.mjs <db-path> <port>. Needs `pnpm run build` first.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { initSchema } from '../../dist/server/schema.js';
import { initScrumSchema, runMigrations } from '../../dist/scrum/schema.js';
import { seedDefaults } from '../../dist/scrum/defaults.js';
import { indexDirectory } from '../../dist/server/indexer.js';

const [dbPath, port] = process.argv.slice(2);
if (!dbPath || !port) {
  console.error('usage: node test/e2e/serve.mjs <db-path> <port>');
  process.exit(64);
}
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
initSchema(db);
initScrumSchema(db);
runMigrations(db, { freshDb: true });
seedDefaults(db);

// Code index: a real, small part of this repo.
indexDirectory(db, path.join(root, 'src/server'));

// Scrum data: one milestone, one epic, one sprint in implementation, tickets,
// discoveries and retro findings, so every tab has something to show.
const ms = db
  .prepare(
    `INSERT INTO milestones (name, description, status) VALUES ('E2E milestone', 'seed', 'active')`,
  )
  .run().lastInsertRowid;
const epic = db
  .prepare(`INSERT INTO epics (name, status, milestone_id) VALUES ('E2E epic', 'active', ?)`)
  .run(ms).lastInsertRowid;
const prev = db
  .prepare(
    `INSERT INTO sprints (name, goal, status, velocity_committed, velocity_completed, milestone_id) VALUES ('E2E Sprint 0', 'done before', 'rest', 5, 5, ?)`,
  )
  .run(ms).lastInsertRowid;
const sprint = db
  .prepare(
    `INSERT INTO sprints (name, goal, status, velocity_committed, milestone_id) VALUES ('E2E Sprint 1', 'Ship the e2e seed', 'implementation', 8, ?)`,
  )
  .run(ms).lastInsertRowid;
const ticket = db.prepare(
  `INSERT INTO tickets (sprint_id, ticket_ref, title, priority, status, story_points, assigned_to, epic_id, milestone_id) VALUES (?, ?, ?, 'P1', ?, ?, ?, ?, ?)`,
);
const t1 = ticket.run(
  sprint,
  'T-1',
  'Seed ticket done',
  'DONE',
  3,
  'developer',
  epic,
  ms,
).lastInsertRowid;
const t2 = ticket.run(
  sprint,
  'T-2',
  'Seed ticket in progress',
  'IN_PROGRESS',
  5,
  'developer',
  epic,
  ms,
).lastInsertRowid;
ticket.run(prev, 'T-0', 'Earlier ticket', 'DONE', 5, 'developer', epic, ms);
const disc = db.prepare(
  `INSERT INTO discoveries (discovery_sprint_id, finding, category, status, implementation_ticket_id) VALUES (?, ?, 'architecture', ?, ?)`,
);
disc.run(prev, 'Seed discovery planned', 'planned', t2);
disc.run(prev, 'Seed discovery implemented', 'implemented', t1);
const rf = db.prepare(
  `INSERT INTO retro_findings (sprint_id, category, finding, role) VALUES (?, ?, ?, 'developer')`,
);
rf.run(prev, 'went_well', 'Seed: tests were fast');
rf.run(prev, 'try_next', 'Seed: try smaller tickets');
db.close();

const child = spawn(
  process.execPath,
  [path.join(root, 'dist/dashboard/dashboard.js'), dbPath, String(port)],
  {
    stdio: 'inherit',
    env: process.env,
  },
);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig));
child.on('error', (e) => {
  console.error(`e2e serve: cannot start the dashboard: ${e.message}`);
  process.exit(1);
});
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
