/**
 * C1: Replay a canned kickoff ceremony tool sequence against a copy of context.db
 * and report output-token estimates per call (chars/4 heuristic).
 *
 * Usage: pnpm exec tsx scripts/measure-tokens.mts [path/to/context.db]
 * Run on main vs. a branch to compare before/after totals.
 */
import Database from 'better-sqlite3';
import { copyFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runMigrations } from '../src/scrum/schema.js';
import { registerScrumTools } from '../src/scrum/tools.js';

type Handler = (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>;

/** Captures tool handlers the same way McpServer would register them. */
class FakeServer {
  tools = new Map<string, Handler>();
  tool(name: string, _desc: string, _schema: unknown, handler: Handler): void {
    this.tools.set(name, handler);
  }
}

const sourceDb = process.argv[2] || 'context.db';
const tmp = mkdtempSync(join(tmpdir(), 'measure-'));
const dbPath = join(tmp, 'context.db');
copyFileSync(sourceDb, dbPath);

const db = new Database(dbPath);
runMigrations(db);
const server = new FakeServer();
registerScrumTools(server as never, db);

const latestSprint =
  (
    db.prepare(`SELECT id FROM sprints WHERE deleted_at IS NULL ORDER BY id DESC LIMIT 1`).get() as
      | { id: number }
      | undefined
  )?.id ?? 1;

const SEQUENCE: Array<{ tool: string; args: Record<string, unknown> }> = [
  { tool: 'get_resume_state', args: {} },
  { tool: 'load_phase_context', args: { phase: 'tickets' } },
  { tool: 'get_sprint_playbook', args: { sprint_id: latestSprint } },
  { tool: 'get_burndown', args: { sprint_id: latestSprint } },
  { tool: 'get_velocity_trends', args: {} },
  { tool: 'list_discoveries', args: {} },
  { tool: 'load_phase_context', args: { phase: 'implementation', sprint_id: latestSprint } },
  { tool: 'load_phase_context', args: { phase: 'retro', sprint_id: latestSprint } },
  { tool: 'list_tickets', args: { sprint_id: latestSprint } },
  { tool: 'export_sprint_report', args: { sprint_id: latestSprint } },
];

const tokens = (s: string): number => Math.ceil(s.length / 4);
let total = 0;
const rows: string[] = [];
for (const step of SEQUENCE) {
  const handler = server.tools.get(step.tool);
  if (!handler) {
    rows.push(`${step.tool.padEnd(28)} MISSING`);
    continue;
  }
  const res = await handler(step.args);
  const text = res.content.map((c) => c.text).join('\n');
  const t = tokens(text);
  total += t;
  rows.push(
    `${(step.tool + JSON.stringify(step.args)).slice(0, 60).padEnd(62)} ${String(t).padStart(6)} tok`,
  );
}
console.log(rows.join('\n'));
console.log(''.padEnd(70, '─'));
console.log(`TOTAL ceremony output: ${total} tokens (chars/4 estimate, db=${sourceDb})`);
db.close();
