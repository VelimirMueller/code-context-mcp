#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { initSchema } from './schema.js';
import { indexDirectory } from './indexer.js';
import {
  initScrumSchema,
  runMigrations,
  LATEST_SCHEMA_VERSION,
  peekSchemaVersion,
} from '../scrum/schema.js';
import { seedDefaults } from '../scrum/defaults.js';
import { applyStatuslineSetting } from './statusline.js';
import { ensureDbGitignored, DB_IGNORE_PATTERN } from './gitignore.js';
import { openDbSecure, copyFileSecure, restrictFile } from '../secure-file.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = path.resolve(__dirname);

const args = process.argv.slice(2);

if (args.includes('--help') || args.includes('-h')) {
  console.log(`
code-context-mcp — Pre-index your codebase for AI agents

Usage:
  code-context-mcp [path]              Set up or update a project (default: current dir)
                                         fresh directory  → full setup: index + scrum seed + .mcp.json
                                         existing context.db → update mode: migrate schema +
                                         refresh client config (no re-index, data preserved)
  code-context-mcp setup [path]        Same as above (explicit alias)
  code-context-mcp --help              Show this help

Options:
  --force                              Fresh start even if context.db exists — the old DB is
                                       renamed to context.db.bak-<timestamp> first
  --name <name>                        Project name (default: directory name)
  --defaults                           Non-interactive: skip prompts, auto-create vision & milestone

Examples:
  code-context-mcp .                   Set up (or update) the current directory
  code-context-mcp setup ~/my-project  Full setup for a project
  code-context-mcp --defaults .        Non-interactive setup/update (CI-friendly)
  code-context-mcp --force .           Re-initialize from scratch (old DB backed up)

After setup:
  code-context-dashboard               Open dashboard (default port: ${process.env.DASHBOARD_PORT || '3333'})

MCP Tools:
  code-context tools (index, search, file context, symbols, changes)
  scrum suite (sprints, tickets, retros, milestones, agents, bridge, dump/restore)
`);
  process.exit(0);
}

const FORCE = args.includes('--force');
const USE_DEFAULTS = args.includes('--defaults');

const nameIdx = args.indexOf('--name');
const nonFlagArgs = args.filter((a) => !a.startsWith('--') && !a.startsWith('-'));
const isSetupCommand = nonFlagArgs[0] === 'setup';
const targetPath = isSetupCommand ? nonFlagArgs[1] || '.' : nonFlagArgs[0] || '.';
const TARGET_DIR = path.resolve(targetPath);
const PROJECT_NAME =
  nameIdx >= 0 && args[nameIdx + 1] ? args[nameIdx + 1] : path.basename(TARGET_DIR);

const DB_PATH = path.resolve(TARGET_DIR, 'context.db');
const SERVER_ENTRY = path.resolve(SERVER_DIR, 'index.js');

// ─── Detect mode: fresh vs update ────────────────────────────────────────────
const dbExisted = fs.existsSync(DB_PATH);
const UPDATE_MODE = dbExisted && !FORCE;

if (UPDATE_MODE) {
  console.log(`=== Code Context MCP — Update (${PROJECT_NAME}) ===\n`);
} else {
  console.log(`=== Code Context MCP — Setup (${PROJECT_NAME}) ===\n`);
}
console.log(`  Target directory : ${TARGET_DIR}`);
console.log(`  Database         : ${DB_PATH}`);
console.log(`  MCP server       : ${SERVER_ENTRY}\n`);

if (UPDATE_MODE) {
  console.log('  Existing database detected → migration mode (use --force for a full reset)\n');
}

// ─── Step counter ─────────────────────────────────────────────────────────────
const totalSteps = UPDATE_MODE ? 2 : 7;
let stepNo = 1;
function step(label: string): void {
  console.log(`[${stepNo++}/${totalSteps}] ${label}`);
}

// ─── WAL checkpoint before file-level backups ────────────────────────────────
/**
 * Checkpoint the WAL into the main DB file so a rename/copy of dbPath alone
 * holds every committed write — un-checkpointed pages otherwise live only in
 * the -wal sibling and a naive restore of the backup silently loses them
 * (discovery #27). Warns instead of throwing: both callers proceed with a
 * backup of whatever state exists.
 */
function checkpointWalForBackup(dbPath: string): void {
  try {
    const checkpointDb = openDbSecure(dbPath);
    // better-sqlite3 returns [{ busy, log, checkpointed }] for this pragma.
    const ckptResult = checkpointDb.pragma('wal_checkpoint(TRUNCATE)') as Array<{
      busy: number;
      log: number;
      checkpointed: number;
    }>;
    checkpointDb.close();
    const ckpt = Array.isArray(ckptResult) ? ckptResult[0] : ckptResult;
    if (ckpt && (ckpt.busy === 1 || ckpt.checkpointed < ckpt.log)) {
      console.warn(
        `  Warning: WAL checkpoint incomplete (${ckpt.checkpointed}/${ckpt.log} pages) — ` +
          `another process may be writing to this database (running dashboard or MCP server?). ` +
          `The backup may lag the latest writes.`,
      );
    }
  } catch (err) {
    console.warn(
      `  Warning: WAL checkpoint failed (${err instanceof Error ? err.message : String(err)}) — backing up files as-is.`,
    );
  }
}

// ─── --force: rename existing DB (instead of deleting) ───────────────────────
if (FORCE && dbExisted) {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const bakPath = `${DB_PATH}.bak-${ts}`;
  // Checkpoint first so the renamed context.db alone holds every committed write.
  checkpointWalForBackup(DB_PATH);
  fs.renameSync(DB_PATH, bakPath);
  console.log(`  Renamed existing database to ${path.basename(bakPath)}`);
  // Rename WAL/SHM siblings preserving SQLite's pairing convention
  // (context.db.bak-<ts>-wal), so opening the .bak re-pairs any residue.
  for (const ext of ['-wal', '-shm']) {
    const sib = DB_PATH + ext;
    if (fs.existsSync(sib)) {
      fs.renameSync(sib, bakPath + ext);
      restrictFile(bakPath + ext);
    }
  }
  // The backup holds the full db content: 0600 even when the renamed db was
  // group/world-readable (rename keeps the old mode).
  restrictFile(bakPath);
  console.log(`  Backup location: ${bakPath}\n`);
}

if (UPDATE_MODE) {
  // ─── UPDATE MODE ──────────────────────────────────────────────────────────

  // [1/2] Migrate
  step('Migrating database schema...');

  // Peek current schema version (pre-versioning DBs lack the table → current=0)
  const currentVersion = peekSchemaVersion(DB_PATH);

  if (currentVersion > LATEST_SCHEMA_VERSION) {
    console.error(
      `  ERROR: Database is at schema v${currentVersion}, but this code-context version only knows v${LATEST_SCHEMA_VERSION}.` +
        `\n  It was created by a newer code-context version — update the package (npm i -g vlm-code-context-mcp@latest).`,
    );
    process.exit(1);
  }

  if (currentVersion < LATEST_SCHEMA_VERSION) {
    // Backup before migrating: checkpoint the WAL so context.db alone holds all data.
    checkpointWalForBackup(DB_PATH);

    try {
      copyFileSecure(DB_PATH, DB_PATH + '.bak');
    } catch (err) {
      console.error(
        `  ERROR: Could not create the pre-migration backup (context.db.bak): ${err instanceof Error ? err.message : String(err)}`,
      );
      console.error(
        `  Migration aborted — nothing was changed. Fix disk space/permissions and re-run.`,
      );
      process.exit(1);
    }
    console.log(`  Backup created: context.db.bak`);

    // Open for migration
    const db = openDbSecure(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    try {
      initSchema(db);
      initScrumSchema(db);
      runMigrations(db, { freshDb: false });
    } catch (err) {
      console.error(`  Migration failed — your original database is backed up at context.db.bak`);
      console.error(`  ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
    db.close();

    console.log(
      `  Migrated v${currentVersion} → v${LATEST_SCHEMA_VERSION} (${LATEST_SCHEMA_VERSION - currentVersion} migrations). Backup: context.db.bak`,
    );
  } else {
    console.log(`  Schema up to date (v${LATEST_SCHEMA_VERSION}).`);
  }
  console.log('');

  // [2/2] Config repair (mcp.json, bridge hook, commands, statusline)
  step('Refreshing client config...');
  console.log('');
} else {
  // ─── FRESH SETUP MODE ─────────────────────────────────────────────────────

  // [1/7] Initialize database
  step('Initializing database...');

  const isFreshDb = !fs.existsSync(DB_PATH);
  const db = openDbSecure(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  initSchema(db);
  initScrumSchema(db);
  runMigrations(db, { freshDb: isFreshDb });
  console.log('  Code-context schema ready.');
  console.log('  Scrum schema ready.\n');

  // [2/7] Index the target directory
  step('Indexing target directory...');
  const stats = indexDirectory(db, TARGET_DIR);
  console.log(
    `  Indexed ${stats.files} files, ${stats.exports} exports, ${stats.deps} dependencies.\n`,
  );

  // [3/7] Seed factory defaults
  step('Seeding factory defaults...');
  const seeded = seedDefaults(db);
  if (seeded.agents + seeded.skills > 0) {
    console.log(`  Seeded ${seeded.agents} agents, ${seeded.skills} skills`);
  } else {
    console.log('  Defaults already present, skipping.');
  }
  console.log('');

  // ─── First-startup wizard: auto-create PRODUCT_VISION ────────────────────
  {
    const visionRow = db.prepare(`SELECT id FROM skills WHERE name = 'PRODUCT_VISION'`).get() as
      | { id: number }
      | undefined;
    if (!visionRow) {
      const defaultVision = [
        `# Product Vision — ${PROJECT_NAME}`,
        '',
        '## Mission',
        `Build and ship ${PROJECT_NAME} as a high-quality, well-documented project.`,
        '',
        '## Target Users',
        'Developers and teams who need a structured, AI-assisted development workflow.',
        '',
        '## Success Metrics',
        '- All milestones completed on schedule',
        '- Test coverage above 80%',
        '- Comprehensive documentation',
        '',
        '> Update this vision at any time with the `update_vision` MCP tool or via the dashboard.',
      ].join('\n');

      db.prepare(`INSERT INTO skills (name, content, owner_role) VALUES (?, ?, ?)`).run(
        'PRODUCT_VISION',
        defaultVision,
        'product-owner',
      );
      console.log('  Created default PRODUCT_VISION skill (update via MCP tools or dashboard).');
    } else {
      console.log('  PRODUCT_VISION skill already exists, skipping.');
    }

    // Milestones are created via /kickoff or MCP tools — not auto-seeded during setup.

    if (!USE_DEFAULTS) {
      console.log('\n  Tip: Run with --defaults to suppress this output on re-runs.');
    }
    console.log('');
  }

  db.close();

  // Advance the step counter past steps 4-7 (they come below, shared with update mode)
  // Steps 4-7 will be printed with their own headings in fresh mode
  stepNo = 4; // reset to 4 so [4/7], [5/7], [6/7], [7/7] print correctly
}

// ─── Config steps (shared: fresh mode = [4/7]..[7/7], update mode already stepped ─
// In update mode these run under the [2/2] heading already printed.
// In fresh mode we use individual step() calls.

const mcpConfigPath = path.resolve(TARGET_DIR, '.mcp.json');
const relServer = './' + path.relative(TARGET_DIR, SERVER_ENTRY).split(path.sep).join('/');
const serverEntry = {
  command: 'node',
  args: [relServer, DB_PATH],
};

// Configure MCP client (.mcp.json)
if (!UPDATE_MODE) step('Configuring MCP client...');
/** The parts of .mcp.json this script touches; other keys pass through unchanged. */
interface McpConfigFile {
  mcpServers: Record<string, unknown>;
  [key: string]: unknown;
}
let mcpConfig: McpConfigFile = { mcpServers: {} };
if (fs.existsSync(mcpConfigPath)) {
  try {
    mcpConfig = JSON.parse(fs.readFileSync(mcpConfigPath, 'utf-8'));
    if (!mcpConfig.mcpServers) mcpConfig.mcpServers = {};
  } catch {
    // Overwrite if corrupted
  }
}
mcpConfig.mcpServers['code-context'] = serverEntry;
fs.writeFileSync(mcpConfigPath, JSON.stringify(mcpConfig, null, 2) + '\n');
console.log(`  Wrote ${mcpConfigPath}\n`);

// Keep the index (it stores file contents) out of the project's git history
if (ensureDbGitignored(TARGET_DIR) === 'added') {
  console.log(`  Added ${DB_IGNORE_PATTERN} to ${path.join(TARGET_DIR, '.gitignore')}\n`);
}

// Configure bridge hook (.claude/settings.json)
if (!UPDATE_MODE) step('Configuring bridge hook...');
const hookScript =
  './' +
  path.relative(TARGET_DIR, path.resolve(__dirname, '../bridge/hook.js')).split(path.sep).join('/');
const claudeSettingsDir = path.resolve(TARGET_DIR, '.claude');
const claudeSettingsPath = path.join(claudeSettingsDir, 'settings.json');
if (!fs.existsSync(claudeSettingsDir)) fs.mkdirSync(claudeSettingsDir, { recursive: true });

/** A PreToolUse entry: a matcher group ({ matcher, hooks }) or an old flat { type, command } entry. */
interface PreToolUseEntry {
  type?: string;
  command?: string;
  matcher?: string;
  hooks?: Array<{ type?: string; command?: string }>;
  [key: string]: unknown;
}
/** The parts of .claude/settings.json this script touches; other keys pass through unchanged. */
interface ClaudeSettingsFile {
  hooks?: { PreToolUse?: PreToolUseEntry[]; [event: string]: unknown };
  [key: string]: unknown;
}
let claudeSettings: ClaudeSettingsFile = {};
if (fs.existsSync(claudeSettingsPath)) {
  try {
    claudeSettings = JSON.parse(fs.readFileSync(claudeSettingsPath, 'utf-8'));
  } catch {}
}
if (!claudeSettings.hooks) claudeSettings.hooks = {};
if (!claudeSettings.hooks.PreToolUse) claudeSettings.hooks.PreToolUse = [];

// Always write the correct bridge hook (repairs broken configs from older versions)
const bridgeHookCmd = `node ${hookScript}`;
// Remove any existing bridge hook entries (including old flat-format ones)
claudeSettings.hooks.PreToolUse = claudeSettings.hooks.PreToolUse.filter((entry) => {
  // Remove old flat-format entries: { type: "command", command: "...bridge/hook..." }
  if (entry.type === 'command' && entry.command?.includes('bridge/hook')) return false;
  // Remove existing matcher-group entries containing bridge hook
  if (Array.isArray(entry.hooks) && entry.hooks.some((h) => h.command?.includes('bridge/hook')))
    return false;
  return true;
});
claudeSettings.hooks.PreToolUse.push({
  matcher: '',
  hooks: [{ type: 'command', command: bridgeHookCmd }],
});
fs.writeFileSync(claudeSettingsPath, JSON.stringify(claudeSettings, null, 2) + '\n');
console.log(`  Bridge hook configured in ${claudeSettingsPath}`);
console.log('');

// Copy .claude/commands into target project
if (!UPDATE_MODE) step('Installing Claude commands...');
const pkgCommandsDir = path.resolve(__dirname, '../../.claude/commands');
const targetCommandsDir = path.resolve(TARGET_DIR, '.claude/commands');
if (fs.existsSync(pkgCommandsDir)) {
  if (!fs.existsSync(targetCommandsDir)) fs.mkdirSync(targetCommandsDir, { recursive: true });
  const commandFiles = fs.readdirSync(pkgCommandsDir).filter((f) => f.endsWith('.md'));
  for (const file of commandFiles) {
    const dest = path.join(targetCommandsDir, file);
    if (!fs.existsSync(dest)) {
      fs.copyFileSync(path.join(pkgCommandsDir, file), dest);
      console.log(`  Copied ${file}`);
    } else {
      console.log(`  Skipped ${file} (already exists)`);
    }
  }
  console.log(`  Commands installed to ${targetCommandsDir}`);
} else {
  console.log('  No commands directory found in package, skipping.');
}
console.log('');

// Statusline HUD
if (!UPDATE_MODE) step('Configuring statusline HUD...');
const statuslineResult = applyStatuslineSetting(TARGET_DIR);
if (statuslineResult === 'written') {
  console.log(
    `  Statusline HUD configured in ${claudeSettingsPath} (command: code-context-statusline)`,
  );
} else {
  console.log(`  Existing statusLine found in ${claudeSettingsPath} — left untouched.`);
}
console.log('');

if (UPDATE_MODE) {
  console.log(`=== Update complete! ===\n`);
} else {
  console.log(`=== Setup complete! (${PROJECT_NAME}) ===\n`);
}
const dashPort = process.env.DASHBOARD_PORT || '3333';
console.log('Dashboard:');
console.log(`  npx code-context-dashboard ${DB_PATH}  — Open at http://localhost:${dashPort}`);
console.log(`  npx code-context-dashboard ${DB_PATH} ${dashPort} .  — With file watcher`);
console.log('');
console.log('Restart your AI client to load the MCP tools (98 total).');
console.log('All data lives in context.db — no .claude/ files needed.');
console.log('');
