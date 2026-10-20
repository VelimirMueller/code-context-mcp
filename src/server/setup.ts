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
import {
  ensureDbGitignored,
  ensureDumpGitignored,
  DB_IGNORE_PATTERN,
  DUMP_IGNORE_PATTERN,
} from './gitignore.js';
import { PROFILES, type Profile } from './tool-wrap.js';
import { openDbSecure, copyFileSecure, restrictFile } from '../secure-file.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = path.resolve(__dirname);

const args = process.argv.slice(2);

if (args.includes('--help') || args.includes('-h')) {
  console.log(`
code-context-mcp — Set up code-context in a project (index + sprint process)

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
  --profile <code|full|all>            Tool profile written to .mcp.json (CODE_CONTEXT_PROFILE).
                                       Default: full (the sprint process, 97 tools) on the
                                       code-context-sprint entry. code = the 6 reading tools on
                                       the code-context (index) entry. An existing setting is
                                       kept unless --profile is given.

Examples:
  code-context-mcp .                   Set up (or update) the current directory
  code-context-mcp setup ~/my-project  Full setup for a project
  code-context-mcp --defaults .        Non-interactive setup/update (CI-friendly)
  code-context-mcp --force .           Re-initialize from scratch (old DB backed up)
  code-context-mcp --profile code .    Set up for code reading only (no sprint tools)

After setup:
  code-context-dashboard               Open dashboard (default port: ${process.env.DASHBOARD_PORT || '3333'})

MCP entries (one package, one context.db):
  code-context         The code index. 6 tools by default (profile code).
  code-context-sprint  The sprint process on top: profile full by default.

MCP Tools (by profile):
  code   find_symbol, get_file_context, who_imports, exports_in, search_files, query
  full   + index maintenance + scrum suite (sprints, tickets, retros, milestones, agents,
         bridge, dump/restore)
  all    + fun and stream toolsets
`);
  process.exit(0);
}

const FORCE = args.includes('--force');
const USE_DEFAULTS = args.includes('--defaults');

const nameIdx = args.indexOf('--name');
const profileIdx = args.indexOf('--profile');
const profileEq = args.find((a) => a.startsWith('--profile='));
const PROFILE_ARG = (
  profileEq
    ? profileEq.slice('--profile='.length)
    : profileIdx >= 0
      ? args[profileIdx + 1]
      : undefined
)
  ?.trim()
  .toLowerCase();
if ((profileIdx >= 0 || profileEq) && !(PROFILE_ARG && PROFILE_ARG in PROFILES)) {
  console.error(
    `  ERROR: --profile takes one of ${Object.keys(PROFILES).join(', ')} (got ${JSON.stringify(PROFILE_ARG ?? '')}).`,
  );
  process.exit(1);
}
// Values of --name and --profile are not the target path.
const valueIdx = new Set([nameIdx + 1, profileIdx + 1].filter((i) => i > 0));
const nonFlagArgs = args.filter((a, i) => !a.startsWith('-') && !valueIdx.has(i));
const isSetupCommand = nonFlagArgs[0] === 'setup';
const targetPath = isSetupCommand ? nonFlagArgs[1] || '.' : nonFlagArgs[0] || '.';
const TARGET_DIR = path.resolve(targetPath);
const PROJECT_NAME =
  nameIdx >= 0 && args[nameIdx + 1] ? args[nameIdx + 1] : path.basename(TARGET_DIR);

const DB_PATH = path.resolve(TARGET_DIR, 'context.db');
// #179: two entries over the same server and context.db. setup installs the
// sprint entry (it seeds the sprint process); --profile code installs the index entry.
const INDEX_ENTRY = path.resolve(SERVER_DIR, 'index.js');
const SPRINT_ENTRY = path.resolve(SERVER_DIR, 'sprint.js');

// ─── Detect mode: fresh vs update ────────────────────────────────────────────
const dbExisted = fs.existsSync(DB_PATH);
const UPDATE_MODE = dbExisted && !FORCE;

if (UPDATE_MODE) {
  console.log(`=== Code Context MCP — Update (${PROJECT_NAME}) ===\n`);
} else {
  console.log(`=== Code Context MCP — Setup (${PROJECT_NAME}) ===\n`);
}
console.log(`  Target directory : ${TARGET_DIR}`);
console.log(`  Database         : ${DB_PATH}\n`);

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

/**
 * The tool profile for this project (#178). The server's own default is the
 * lean `code` profile; setup installs the sprint process (scrum seed, /kickoff,
 * bridge hook), so it writes `CODE_CONTEXT_PROFILE=full` unless the entry
 * already says what it wants. Precedence: --profile; else an existing
 * CODE_CONTEXT_PROFILE; else an existing CODE_CONTEXT_TOOLSETS that lists
 * `code` (a 2.x lean install, kept lean); else `full`, which is also what a
 * 2.x install without a setting had.
 */
function profileEnv(existing: Record<string, string>): {
  env: Record<string, string>;
  profile: string;
  source: string;
} {
  const env = { ...existing };
  if (PROFILE_ARG) {
    env.CODE_CONTEXT_PROFILE = PROFILE_ARG;
    return { env, profile: PROFILE_ARG, source: '--profile' };
  }
  const kept = env.CODE_CONTEXT_PROFILE?.trim().toLowerCase();
  if (kept && kept in PROFILES) {
    return { env, profile: kept, source: 'kept from .mcp.json' };
  }
  if (kept) {
    // The server would ignore it and fall back to `code`: repair it like a missing setting.
    console.warn(
      `  Warning: unknown CODE_CONTEXT_PROFILE=${JSON.stringify(kept)} in .mcp.json, replaced.`,
    );
  }
  const toolsets = (env.CODE_CONTEXT_TOOLSETS ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase().replace(/^\+/, ''));
  if (!kept && toolsets.includes('code') && !toolsets.includes('all')) {
    return { env, profile: 'code', source: 'kept: CODE_CONTEXT_TOOLSETS lists code' };
  }
  const profile: Profile = 'full';
  env.CODE_CONTEXT_PROFILE = profile;
  return { env, profile, source: 'setup default for the sprint process' };
}

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
const existingEntry = mcpConfig.mcpServers['code-context'];
const previous: { env?: unknown; [key: string]: unknown } =
  existingEntry && typeof existingEntry === 'object' && !Array.isArray(existingEntry)
    ? (existingEntry as Record<string, unknown>)
    : {};
const previousEnv: Record<string, string> = {};
if (previous.env && typeof previous.env === 'object' && !Array.isArray(previous.env)) {
  for (const [k, v] of Object.entries(previous.env as Record<string, unknown>)) {
    if (typeof v === 'string') previousEnv[k] = v;
  }
}
const toolProfile = profileEnv(previousEnv);
// The entry matches the profile: `code` = the index entry, `full`/`all` = the
// sprint entry. CODE_CONTEXT_PROFILE stays in env too: explicit, shown by
// `health`, and the same .mcp.json entry still works if pointed at index.js.
const sprintEntry = toolProfile.profile !== 'code';
const serverEntry = sprintEntry ? SPRINT_ENTRY : INDEX_ENTRY;
const relServer = './' + path.relative(TARGET_DIR, serverEntry).split(path.sep).join('/');
// Other keys of an existing entry (type, cwd, …) pass through; command/args are repaired.
mcpConfig.mcpServers['code-context'] = {
  ...previous,
  command: 'node',
  args: [relServer, DB_PATH],
  env: toolProfile.env,
};
fs.writeFileSync(mcpConfigPath, JSON.stringify(mcpConfig, null, 2) + '\n');
console.log(`  Wrote ${mcpConfigPath}`);
console.log(`  MCP entry: ${sprintEntry ? 'code-context-sprint' : 'code-context'} (${relServer})`);
console.log(`  Tool profile: ${toolProfile.profile} (${toolProfile.source})`);
console.log(
  toolProfile.profile === 'code'
    ? '  Sprint tools are off. Turn them on with --profile full or CODE_CONTEXT_PROFILE=full (the code-context-sprint entry).\n'
    : '  Code reading only? Use --profile code (the code-context entry, 6 tools instead of 97).\n',
);

// Keep the index (it stores file contents) and the export dump (it holds
// every table) out of the project's git history
if (ensureDbGitignored(TARGET_DIR) === 'added') {
  console.log(`  Added ${DB_IGNORE_PATTERN} to ${path.join(TARGET_DIR, '.gitignore')}\n`);
}
if (ensureDumpGitignored(TARGET_DIR) === 'added') {
  console.log(`  Added ${DUMP_IGNORE_PATTERN} to ${path.join(TARGET_DIR, '.gitignore')}\n`);
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

// Always write the correct bridge hook (repairs broken configs from older versions).
// Pass the absolute db path so the hook never has to walk directories for it (#245).
/** Single-quote a path for the hook command (POSIX); a quote inside becomes '\\''. */
const shQuote = (v: string): string => `'${v.replace(/'/g, `'\\''`)}'`;
const bridgeHookCmd = `node ${shQuote(hookScript)} --db ${shQuote(DB_PATH)}`;
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
console.log(`Restart your AI client to load the MCP tools (profile: ${toolProfile.profile}).`);
console.log('All data lives in context.db — no .claude/ files needed.');
console.log('');
