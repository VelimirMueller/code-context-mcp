#!/usr/bin/env node
/**
 * Claude Code PreToolUse hook — Bridge between dashboard and Claude.
 *
 * This hook fires before every tool call. It checks the pending_actions table
 * in context.db for actions queued by the dashboard, and injects them as
 * additionalContext so Claude picks them up naturally.
 *
 * The db path comes from configuration only — never from a directory walk
 * (a `context.db` planted in a subdirectory would otherwise become a
 * prompt-injection channel, #245). Resolution order:
 *   1. the `CODE_CONTEXT_DB` environment variable,
 *   2. the `--db <path>` argument (setup writes it into the hook command),
 *
 * Install in .claude/settings.json (written by setup):
 * {
 *   "hooks": {
 *     "PreToolUse": [{ "type": "command", "command": "node dist/bridge/hook.js --db /abs/context.db" }]
 *   }
 * }
 */

import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { pathToFileURL } from 'url';

interface PendingAction {
  id: number;
  action: string;
  entity_type: string | null;
  entity_id: number | null;
  payload: string | null;
  source: string;
  created_at: string;
}

const POSIX = process.platform !== 'win32';

/** Parse `--db <path>` (also `--db=<path>`) from the hook's argv. */
export function dbFromArgs(args: string[]): string | null {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--db' && i + 1 < args.length) return args[i + 1];
    if (args[i].startsWith('--db=')) return args[i].slice('--db='.length);
  }
  return null;
}

export interface ResolveDbOpts {
  args: string[];
  env: NodeJS.ProcessEnv;
  cwd: string;
}

/** Resolve the configured db path — configuration only, never a directory walk. */
export function resolveDbPath(opts: ResolveDbOpts): string | null {
  const fromEnv = opts.env.CODE_CONTEXT_DB;
  if (fromEnv && fromEnv.trim().length > 0) return path.resolve(opts.cwd, fromEnv);
  const fromArgs = dbFromArgs(opts.args);
  if (fromArgs) return path.resolve(opts.cwd, fromArgs);
  // No cwd-relative fallback: a planted .mcp.json in a subdirectory would point the
  // hook at a planted db, the channel #245 closes. Setup writes --db.
  return null;
}

export type DbRefusal =
  | { ok: true }
  | { ok: false; reason: 'symlink' | 'owner' | 'not-a-file' | 'stat-failed' };

/**
 * Refuse a symlink, a non-regular file, or a db not owned by the current user
 * (POSIX only — Windows has no per-file uid). A db that is not the current
 * user's own could be planted by another account on the same machine.
 */
export function validateDbPath(dbPath: string): DbRefusal {
  let lstat: fs.Stats;
  try {
    lstat = fs.lstatSync(dbPath);
  } catch {
    return { ok: false, reason: 'stat-failed' };
  }
  if (lstat.isSymbolicLink()) return { ok: false, reason: 'symlink' };
  if (!lstat.isFile()) return { ok: false, reason: 'not-a-file' };
  if (POSIX) {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(dbPath);
    } catch {
      return { ok: false, reason: 'stat-failed' };
    }
    const uid = process.getuid?.();
    if (typeof stat.uid === 'number' && typeof uid === 'number' && stat.uid !== uid) {
      return { ok: false, reason: 'owner' };
    }
  }
  return { ok: true };
}

/** Extract and inject queued actions from an open db; null when nothing is pending. */
function injectActions(db: Database.Database): string | null {
  // Check for pending actions (max 5 at a time to keep context small)
  // Skip request_input — those are handled by the dashboard wizard, not this hook
  // Skip ceremony actions — retro and review are UI-only, terminal should not initiate them
  // Note: run_kickoff is NOT in this list — it flows through the bridge to Claude
  const CEREMONY_ACTIONS = ['run_retro', 'run_review'];

  // Auto-complete ceremony actions that were queued by the UI.
  // Since the terminal no longer handles ceremonies, mark them completed immediately
  // so they don't pile up in pending state.
  db.prepare(
    `UPDATE pending_actions SET status = 'completed', completed_at = datetime('now')
     WHERE status = 'pending' AND action IN (${CEREMONY_ACTIONS.map(() => '?').join(',')})`,
  ).run(...CEREMONY_ACTIONS);

  const pending = db
    .prepare(
      `SELECT id, action, entity_type, entity_id, payload, source, created_at
     FROM pending_actions
     WHERE status = 'pending' AND action != 'request_input'
       AND action NOT IN (${CEREMONY_ACTIONS.map(() => '?').join(',')})
     ORDER BY created_at ASC
     LIMIT 5`,
    )
    .all(...CEREMONY_ACTIONS) as PendingAction[];

  if (pending.length === 0) return null;

  // Expire old actions (>1 hour)
  db.prepare(
    `UPDATE pending_actions SET status = 'expired'
     WHERE status = 'pending' AND created_at < datetime('now', '-1 hour')`,
  ).run();

  // Claim these actions
  const ids = pending.map((a) => a.id);
  db.prepare(
    `UPDATE pending_actions SET status = 'claimed', claimed_at = datetime('now')
     WHERE id IN (${ids.map(() => '?').join(',')})`,
  ).run(...ids);

  // Mark actions complete directly (don't delegate SQL to Claude)
  db.prepare(
    `UPDATE pending_actions SET status = 'completed', completed_at = datetime('now')
     WHERE id IN (${ids.map(() => '?').join(',')})`,
  ).run(...ids);

  // Sanitize strings to prevent prompt injection
  const sanitize = (s: string, maxLen = 200): string =>
    s.replace(/[\x00-\x09\x0b-\x1f]/g, '').slice(0, maxLen);

  // Build context string as structured JSON block (not free-form text)
  const actionList = pending.map((a) => ({
    id: a.id,
    action: sanitize(a.action, 50),
    entity_type: a.entity_type ? sanitize(a.entity_type, 30) : null,
    entity_id: a.entity_id,
    payload: a.payload
      ? (() => {
          try {
            return JSON.parse(a.payload!);
          } catch {
            return null;
          }
        })()
      : null,
    created_at: a.created_at,
  }));

  // Map actions to their MCP tool calls
  // Note: run_retro and run_review are filtered out above (UI-only ceremonies)
  // run_kickoff flows through here to Claude via handle_run_kickoff MCP tool
  const actionToolMap: Record<string, string> = {
    run_kickoff: 'Call handle_run_kickoff MCP tool to initiate the full project kickoff ceremony',
    advance_sprint: 'advance_sprint({ sprint_id: <entity_id>, ...payload })',
    assign_ticket:
      'Update ticket assignment via update_ticket({ ticket_id: <entity_id>, assigned_to: <agent> })',
    update_ticket: 'update_ticket({ ticket_id: <entity_id>, ...payload })',
    create_ticket: 'create_ticket({ sprint_id: <sprint_id>, title: <title>, ... })',
    plan_sprint: 'Use /sprint skill or plan_sprint MCP tool',
    custom: 'Execute custom action based on payload',
  };

  const toolInstructions = actionList
    .map((a) => {
      const toolCall = actionToolMap[a.action] || `Unknown action: ${a.action}`;
      return `- Action #${a.id} (${a.action}): ${toolCall}`;
    })
    .join('\n');

  return [
    '[DASHBOARD ACTION QUEUE] Execute these actions using the appropriate MCP tools:',
    '```json',
    JSON.stringify(actionList, null, 2),
    '```',
    '',
    'Tool mappings:',
    toolInstructions,
  ].join('\n');
}

export interface HookRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function refusalWarn(reason: 'symlink' | 'owner', dbPath: string): string {
  const why =
    reason === 'owner' ? 'database is not owned by the current user' : 'path is a symlink';
  return `WARN: bridge hook refusing ${dbPath} — ${why}\n`;
}

/** Run the hook against the given config and return its output (no process I/O). */
export function runHook(opts: ResolveDbOpts): HookRunResult {
  const dbPath = resolveDbPath(opts);
  if (!dbPath) {
    // No configured db — nothing to inject, exit cleanly
    return { exitCode: 0, stdout: '', stderr: '' };
  }

  const check = validateDbPath(dbPath);
  if (!check.ok) {
    const stderr =
      check.reason === 'owner' || check.reason === 'symlink'
        ? refusalWarn(check.reason, dbPath)
        : '';
    return { exitCode: 0, stdout: '', stderr };
  }

  let db: Database.Database;
  try {
    db = new Database(dbPath, { readonly: false });
    db.pragma('journal_mode = WAL');
  } catch {
    return { exitCode: 0, stdout: '', stderr: '' };
  }

  try {
    const context = injectActions(db);
    db.close();
    if (context === null) return { exitCode: 0, stdout: '', stderr: '' };

    const response = {
      hookSpecificOutput: {
        additionalContext: context,
      },
    };
    return { exitCode: 0, stdout: JSON.stringify(response), stderr: '' };
  } catch {
    try {
      db.close();
    } catch (_err: unknown) {
      // Ignore close errors
    }
    return { exitCode: 0, stdout: '', stderr: '' };
  }
}

function main(): void {
  const result = runHook({
    args: process.argv.slice(2),
    env: process.env,
    cwd: process.cwd(),
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exit(result.exitCode);
}

// Run only when executed directly (node dist/bridge/hook.js), not when
// imported by the tests.
const isMain = (() => {
  try {
    return (
      typeof process.argv[1] === 'string' &&
      import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href
    );
  } catch {
    return false;
  }
})();
if (isMain) main();
