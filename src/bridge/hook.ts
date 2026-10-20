#!/usr/bin/env node
/**
 * Claude Code PreToolUse hook — Bridge between dashboard and Claude.
 *
 * This hook fires before every tool call. It checks the pending_actions table
 * in context.db for actions queued by the dashboard, and injects them as
 * additionalContext so Claude picks them up naturally.
 *
 * Install in .claude/settings.json:
 * {
 *   "hooks": {
 *     "PreToolUse": [{ "type": "command", "command": "node dist/bridge/hook.js" }]
 *   }
 * }
 */

import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

interface PendingAction {
  id: number;
  action: string;
  entity_type: string | null;
  entity_id: number | null;
  payload: string | null;
  source: string;
  created_at: string;
}

// Find context.db — walk up from cwd looking for it
function findDb(): string | null {
  let dir = process.cwd();
  for (let i = 0; i < 10; i++) {
    const candidate = path.join(dir, 'context.db');
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function main() {
  const dbPath = findDb();
  if (!dbPath) {
    // No DB found — nothing to inject, exit cleanly
    process.exit(0);
  }

  let db: Database.Database;
  try {
    db = new Database(dbPath, { readonly: false });
    db.pragma('journal_mode = WAL');
  } catch {
    process.exit(0);
  }

  try {
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

    if (pending.length === 0) {
      db.close();
      process.exit(0);
    }

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

    const context = [
      '[DASHBOARD ACTION QUEUE] Execute these actions using the appropriate MCP tools:',
      '```json',
      JSON.stringify(actionList, null, 2),
      '```',
      '',
      'Tool mappings:',
      toolInstructions,
    ].join('\n');

    db.close();

    // Output hook response with additionalContext
    const response = {
      hookSpecificOutput: {
        additionalContext: context,
      },
    };
    process.stdout.write(JSON.stringify(response));
  } catch {
    try {
      db.close();
    } catch (_err: unknown) {
      // Ignore close errors
    }
    process.exit(0);
  }
}

main();
