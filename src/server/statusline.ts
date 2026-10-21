#!/usr/bin/env node
/**
 * code-context-statusline — Claude Code statusline HUD for the scrum DB.
 *
 * Claude Code invokes this bin with a JSON payload on stdin
 * ({ workspace: { current_dir } }) and renders the single line it prints.
 * The line summarizes the active sprint (day, points bar, ticket counts,
 * blockers, mood) straight from context.db — zero LLM involvement.
 *
 * Contract: a statusline must never break the host UI. Any failure —
 * no DB, unreadable DB, malformed stdin — prints nothing and exits 0.
 *
 * Install in .claude/settings.json (written by the setup "Statusline HUD" step):
 * {
 *   "statusLine": { "type": "command", "command": "code-context-statusline" }
 * }
 */

import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';

const DEFAULT_SPRINT_LENGTH_DAYS = 5;
const BAR_WIDTH = 8;
const MS_PER_DAY = 86_400_000;

// ─── DB discovery ────────────────────────────────────────────────────────────

/**
 * Find context.db — walk up from startDir looking for it (max 10 levels).
 * Mirrors the discovery pattern in src/bridge/hook.ts.
 */
export function findDb(startDir: string): string | null {
  let dir = path.resolve(startDir);
  for (let i = 0; i < 10; i++) {
    const candidate = path.join(dir, 'context.db');
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

// ─── Colors (raw ANSI, no deps) ──────────────────────────────────────────────

interface Palette {
  cyan: (s: string) => string;
  bold: (s: string) => string;
  green: (s: string) => string;
  yellow: (s: string) => string;
  red: (s: string) => string;
  dim: (s: string) => string;
}

function makePalette(useColor: boolean): Palette {
  const wrap = (code: string) => (s: string) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
  return {
    cyan: wrap('36'),
    bold: wrap('1'),
    green: wrap('32'),
    yellow: wrap('33'),
    red: wrap('31'),
    dim: wrap('2'),
  };
}

// ─── Sprint queries ──────────────────────────────────────────────────────────

interface SprintRow {
  id: number;
  name: string;
  status: string;
  start_date: string | null;
}

function findActiveSprint(db: Database.Database): SprintRow | null {
  const select = `SELECT id, name, status, start_date FROM sprints
    WHERE status NOT IN ('rest', 'done', 'closed') AND deleted_at IS NULL`;
  const order = ` ORDER BY id DESC LIMIT 1`;
  try {
    const row = db.prepare(`${select} AND archived_at IS NULL${order}`).get();
    return (row as SprintRow | undefined) ?? null;
  } catch {
    // archived_at landed in migration v20 — retry without it for older DBs
    const row = db.prepare(select + order).get();
    return (row as SprintRow | undefined) ?? null;
  }
}

/** Sprint length in days from the SPRINT_PROCESS_JSON skill; default 5 on any failure. */
function sprintLengthDays(db: Database.Database): number {
  try {
    const row = db
      .prepare(`SELECT content FROM skills WHERE name = 'SPRINT_PROCESS_JSON'`)
      .get() as { content: string | null } | undefined;
    if (!row?.content) return DEFAULT_SPRINT_LENGTH_DAYS;
    const config = JSON.parse(row.content) as Record<string, unknown>;
    const len = config.sprint_length_days ?? config.duration_days;
    if (typeof len === 'number' && Number.isFinite(len) && len > 0) {
      return Math.floor(len);
    }
    return DEFAULT_SPRINT_LENGTH_DAYS;
  } catch {
    return DEFAULT_SPRINT_LENGTH_DAYS;
  }
}

/** Days since start_date (1-based), clamped to [1, len]. Missing/invalid start → 1. */
function sprintDay(startDate: string | null, len: number): number {
  if (!startDate) return 1;
  const start = new Date(startDate).getTime();
  if (Number.isNaN(start)) return 1;
  const day = Math.floor((Date.now() - start) / MS_PER_DAY) + 1;
  return Math.min(Math.max(day, 1), len);
}

/** "S<n>" when the name carries a sprint number, else the first 18 chars. */
function shortSprintName(name: string): string {
  const match = /Sprint\s+(\d+)/.exec(name);
  return match ? `S${match[1]}` : name.slice(0, 18);
}

/** 8-wide ▰▱ progress bar of done points over total points. */
function progressBar(done: number, total: number): string {
  const ratio = total > 0 ? done / total : 0;
  const filled = Math.min(BAR_WIDTH, Math.max(0, Math.round(ratio * BAR_WIDTH)));
  return '▰'.repeat(filled) + '▱'.repeat(BAR_WIDTH - filled);
}

// ─── Statusline rendering ────────────────────────────────────────────────────

/**
 * Open the DB read-only, build the one-line HUD, close, return it.
 * Returns an empty string when there is nothing to show.
 */
export function buildStatusline(dbPath: string, opts?: { color?: boolean }): string {
  const useColor = opts?.color !== false && process.env.NO_COLOR === undefined;
  const c = makePalette(useColor);
  const project = path.basename(path.dirname(path.resolve(dbPath)));

  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const sprint = findActiveSprint(db);
    if (!sprint) {
      let line = `${c.cyan(`◆ ${project}`)} ${c.dim('▸')} no active sprint`;
      try {
        const row = db
          .prepare(`SELECT COUNT(*) AS n FROM discoveries WHERE status = 'discovered'`)
          .get() as { n: number };
        line += ` ${c.dim('·')} ${row.n} open discoveries`;
      } catch {
        // discoveries table missing on old DBs — omit the segment
      }
      return line;
    }

    const len = sprintLengthDays(db);
    const day = sprintDay(sprint.start_date, len);

    const counts: Record<string, number> = { DONE: 0, IN_PROGRESS: 0, TODO: 0, BLOCKED: 0 };
    let donePts = 0;
    let totalPts = 0;
    const ticketRows = db
      .prepare(
        `SELECT status, COUNT(*) AS n, COALESCE(SUM(story_points), 0) AS pts
         FROM tickets WHERE sprint_id = ? AND deleted_at IS NULL GROUP BY status`,
      )
      .all(sprint.id) as Array<{ status: string; n: number; pts: number }>;
    for (const row of ticketRows) {
      totalPts += row.pts;
      if (row.status === 'DONE') donePts = row.pts;
      if (row.status in counts) counts[row.status] = row.n;
    }

    let openBlockers = 0;
    try {
      const row = db
        .prepare(`SELECT COUNT(*) AS n FROM blockers WHERE sprint_id = ? AND status = 'open'`)
        .get(sprint.id) as { n: number };
      openBlockers = row.n;
    } catch {
      // blockers table missing — omit the segment
    }

    let moodSegment = '';
    try {
      const mood = db
        .prepare(
          `SELECT AVG(mood) AS avg, COUNT(*) AS n FROM agent_mood_history WHERE sprint_id = ?`,
        )
        .get(sprint.id) as { avg: number | null; n: number };
      if (mood.n > 0 && mood.avg !== null) moodSegment = `  ☀ ${mood.avg.toFixed(1)}`;
    } catch {
      // agent_mood_history table missing — omit the segment
    }

    const blockedCount = `✗${counts.BLOCKED}`;
    const segments = [
      `${c.cyan(`◆ ${project}`)} ${c.dim('▸')} ${c.bold(shortSprintName(sprint.name))} ${sprint.status} ${c.dim('·')} day ${day}/${len}`,
      `${progressBar(donePts, totalPts)} ${c.green(String(donePts))}/${totalPts}pt`,
      `${c.green(`✓${counts.DONE}`)} ${c.yellow(`⚙${counts.IN_PROGRESS}`)} ○${counts.TODO} ${counts.BLOCKED > 0 ? c.red(blockedCount) : blockedCount}`,
    ];
    if (openBlockers > 0) segments.push(c.red(`⛔${openBlockers}`));
    return segments.join('  ') + moodSegment;
  } finally {
    db.close();
  }
}

// ─── Setup integration ───────────────────────────────────────────────────────

export type StatuslineSetupResult = 'written' | 'kept-existing' | 'kept-user';

/** Directory of the user-scope Claude Code settings (honours CLAUDE_CONFIG_DIR). */
function defaultUserConfigDir(): string {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

/** True when the JSON file at `file` parses and has its own statusLine key. */
function hasStatusLine(file: string): boolean {
  try {
    return Object.hasOwn(JSON.parse(fs.readFileSync(file, 'utf-8')), 'statusLine');
  } catch {
    return false;
  }
}

/**
 * Merge { statusLine: { type: "command", command: "code-context-statusline" } }
 * into <projectDir>/.claude/settings.json. Creates the file/dir when missing,
 * preserves every existing key, and never clobbers an existing statusLine.
 * Project settings override user settings, so a statusLine in the user's
 * settings.json or the project's settings.local.json is kept too ("kept-user").
 * Called by the setup "Statusline HUD" step; exported so tests can cover the
 * merge logic without executing the setup script.
 */
export function applyStatuslineSetting(
  projectDir: string,
  userConfigDir: string = defaultUserConfigDir(),
): StatuslineSetupResult {
  const settingsDir = path.resolve(projectDir, '.claude');
  const settingsPath = path.join(settingsDir, 'settings.json');

  if (
    hasStatusLine(path.join(userConfigDir, 'settings.json')) ||
    hasStatusLine(path.join(settingsDir, 'settings.local.json'))
  ) {
    return 'kept-user';
  }

  let settings: Record<string, unknown> = {};
  if (fs.existsSync(settingsPath)) {
    try {
      settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    } catch {
      // Overwrite if corrupted (same policy as the .mcp.json setup step)
    }
  }

  if (Object.hasOwn(settings, 'statusLine')) return 'kept-existing';

  settings.statusLine = { type: 'command', command: 'code-context-statusline' };
  if (!fs.existsSync(settingsDir)) fs.mkdirSync(settingsDir, { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
  return 'written';
}

// ─── Entry point ─────────────────────────────────────────────────────────────

function main(): void {
  try {
    let startDir = process.cwd();
    if (!process.stdin.isTTY) {
      // Claude Code pipes a JSON payload; never block on interactive runs.
      try {
        const raw = fs.readFileSync(0, 'utf-8');
        const payload = JSON.parse(raw) as { workspace?: { current_dir?: unknown } };
        const dir = payload.workspace?.current_dir;
        if (typeof dir === 'string' && dir.length > 0) startDir = dir;
      } catch {
        // Malformed/empty payload — fall back to cwd
      }
    }

    const dbPath = findDb(startDir);
    if (!dbPath) return; // no DB found — print nothing, exit 0

    const line = buildStatusline(dbPath);
    if (line) process.stdout.write(line + '\n');
  } catch {
    // A statusline must never break the host UI — print nothing, exit 0
  }
}

// Run only when executed directly (bin / node dist/server/statusline.js),
// not when imported by setup.ts or tests.
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
