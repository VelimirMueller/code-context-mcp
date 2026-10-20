import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import Database from 'better-sqlite3';
import { runWriteStatement } from './sql-guard.js';
import { QUERY_DESCRIPTION, runBoundedQuery } from './query-output.js';
import { z } from 'zod';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { initSchema } from './schema.js';
import { indexDirectory, migrateUnresolvedRoots } from './indexer.js';
import {
  initScrumSchema,
  runMigrations,
  LATEST_SCHEMA_VERSION,
  peekSchemaVersion,
} from '../scrum/schema.js';
import { checkDistFreshness, registerScrumTools, setDashboardDbPath } from '../scrum/tools.js';
import { seedDefaults } from '../scrum/defaults.js';
import { syncSkillsFromUpstream } from '../scrum/skill-sync.js';
import { log as slog, errorClass, logToolExceptions } from '../sessionlog.js';
import { openDbSecure } from '../secure-file.js';
import { FreshnessGuard, freshnessNotice, type FreshRow } from './freshness.js';
import { instrumentTools, toolFilter, serverInstructions, showTimestamps } from './tool-wrap.js';
import { formatIndexSummary } from './index-summary.js';
import { resolveToolPath, resolveDirPath, pathDisplay, canonicalPath } from './path-resolve.js';
import { declarationLines, hasSignatureParser, parseStoredImportLines } from './signatures.js';
import { whoImports, exportsIn } from './graph.js';
import { errorMessage, type CountRow } from '../scrum/rows.js';

// ─── Config ───────────────────────────────────────────────────────────────────
const DB_PATH = process.argv[2] ?? './context.db';
const resolvedDbPath = path.resolve(DB_PATH);
const isFreshDb = !fs.existsSync(resolvedDbPath);

// Refuse a downgrade BEFORE the read-write open: opening in WAL mode would
// litter empty -wal/-shm siblings next to a DB this version must not touch,
// and the runMigrations guard would surface as a raw stack trace (discovery #28).
if (!isFreshDb) {
  const stamped = peekSchemaVersion(resolvedDbPath);
  if (stamped > LATEST_SCHEMA_VERSION) {
    console.error(
      `ERROR: Database is at schema v${stamped}, but this code-context version only knows v${LATEST_SCHEMA_VERSION}.`,
    );
    console.error(
      `  It was created by a newer code-context version — update the package (npm i -g vlm-code-context-mcp@latest).`,
    );
    process.exit(1);
  }
}

let db: Database.Database;
let preMigrationVersion: number;
try {
  db = openDbSecure(resolvedDbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  // The reindex CLI and the dashboard write the same file; wait for their
  // transactions instead of failing a read-time refresh with SQLITE_BUSY.
  db.pragma('busy_timeout = 5000');

  initSchema(db);
  initScrumSchema(db);
  // Peek the stamped version before migrating so the report shows the delta
  preMigrationVersion =
    (db.prepare('SELECT MAX(version) v FROM schema_versions').get() as { v: number | null })?.v ??
    0;
  runMigrations(db, { freshDb: isFreshDb });
} catch (err) {
  slog(
    'CRITICAL',
    `server: db open/migration failed db=${path.basename(resolvedDbPath)} error=${errorClass(err)}`,
  );
  throw err;
}
if (!isFreshDb && preMigrationVersion < LATEST_SCHEMA_VERSION) {
  slog(
    'WARN',
    `server: migrations applied db=${path.basename(resolvedDbPath)} schema v${preMigrationVersion}→v${LATEST_SCHEMA_VERSION}`,
  );
}
console.error(
  isFreshDb
    ? `[schema] v${LATEST_SCHEMA_VERSION} (new database)`
    : preMigrationVersion < LATEST_SCHEMA_VERSION
      ? `[schema] migrated v${preMigrationVersion} → v${LATEST_SCHEMA_VERSION}`
      : `[schema] v${LATEST_SCHEMA_VERSION} (up to date)`,
);

// CCA-01: rows are keyed by realpath. Rebase roots an older version stored
// under a symlinked spelling (/var/folders/… on macOS) once, at boot.
try {
  const moved = migrateUnresolvedRoots(db);
  if (moved.roots > 0) {
    console.error(
      `[paths] rebased ${moved.roots} indexed root(s), ${moved.files} file rows, onto their realpath`,
    );
    slog('INFO', `server: rebased roots=${moved.roots} files=${moved.files} onto realpath`);
  }
} catch (err) {
  slog('WARN', `server: realpath migration failed error=${errorClass(err)}`);
}

// Seed factory defaults into empty tables (never overwrites existing data)
const seeded = seedDefaults(db);
if (seeded.agents + seeded.skills > 0) {
  console.error(
    `[seed] Seeded ${seeded.agents} agents, ${seeded.skills} skills from factory defaults`,
  );
}

// Best-effort refresh of fe:* skills from the latest upstream release.
// Non-blocking and offline-safe; baked defaults remain the fallback.
// Opt-in with CODE_CONTEXT_SKILLS_AUTOSYNC=1: synced skills land in agent
// prompts, so pulling remote content on every boot must be the user's choice.
if (process.env.CODE_CONTEXT_SKILLS_AUTOSYNC === '1') {
  void syncSkillsFromUpstream(db).then((r) => {
    if (r.ok && !r.skipped) {
      console.error(
        `[skills] Synced to ${r.tag}: ${r.inserted} new, ${r.updated} updated, ${r.preserved} user-edited preserved`,
      );
    }
  });
}

// src/server/ and dist/server/ both sit two levels below package.json.
const PKG_VERSION: string = (() => {
  try {
    const pkgPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../package.json');
    return JSON.parse(fs.readFileSync(pkgPath, 'utf-8')).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
})();

// CCA-06 (#121): short `instructions` naming only the listed code tools.
const hiddenToolFilter = toolFilter();
const instructions = serverInstructions(hiddenToolFilter);
const server = new McpServer(
  { name: 'code-context', version: PKG_VERSION },
  instructions ? { instructions } : undefined,
);

// Session log: an exception escaping any tool handler (core or scrum) is a
// CRITICAL breadcrumb — tool name + error class only, then rethrown unchanged.
logToolExceptions(server);
// Toolsets (CODE_CONTEXT_TOOLSETS), flair and the `done <tool> in N ms` line.
instrumentTools(server, hiddenToolFilter);

// Read-time freshness: every file-returning tool checks its rows against the
// disk (and each repo's HEAD) before answering. See freshness.ts.
const fresh = new FreshnessGuard(db);

// Shared by every path-printing tool. Kept short: it is in every tools/list.
// The env fallback (CODE_CONTEXT_ABSOLUTE_PATHS=1) is documented in REFERENCE.md.
const ABSOLUTE_PATHS_DESC = 'Print absolute paths';

/** `SELECT * FROM files`. */
interface FileRow {
  id: number;
  path: string;
  language: string | null;
  extension: string | null;
  size_bytes: number | null;
  line_count: number | null;
  summary: string | null;
  description: string | null;
  external_imports: string | null;
  import_lines: string | null;
  content: string | null;
  created_at: string | null;
  modified_at: string | null;
  indexed_at: string | null;
}

/** The columns of a `changes` row that get_file_context and get_changes render. */
interface ChangeRow {
  file_path: string;
  event: string;
  timestamp: string | null;
  old_summary: string | null;
  new_summary: string | null;
  old_line_count: number | null;
  new_line_count: number | null;
  old_size_bytes: number | null;
  new_size_bytes: number | null;
  old_exports: string | null;
  new_exports: string | null;
  diff_text: string | null;
  reason: string | null;
}

// ─── Tool: index_directory ───────────────────────────────────────────────────
server.tool(
  'index_directory',
  'Scan a directory, parse all files, extract metadata/exports and build a dependency graph. Rows for files deleted from disk are pruned (scoped to the indexed path). Use freshness_check=true to skip re-indexing if the index is recent (<5 min), returning only a summary (~20 tokens).',
  {
    path: z.string().describe('Absolute path to the directory to index'),
    freshness_check: z
      .boolean()
      .optional()
      .describe('If true, skip re-indexing when fresh (<5 min). Returns summary only.'),
  },
  async ({ path: dirPath, freshness_check }) => {
    try {
      const rootDir = path.resolve(dirPath);

      // Freshness check: skip full re-index if data is recent
      if (freshness_check) {
        const latest = db.prepare(`SELECT MAX(indexed_at) as last_indexed FROM files`).get() as {
          last_indexed: string | null;
        };
        if (latest?.last_indexed) {
          const lastTime = new Date(latest.last_indexed + 'Z').getTime();
          const ageMs = Date.now() - lastTime;
          const ageMin = Math.round(ageMs / 60000);
          if (ageMs < 5 * 60 * 1000) {
            // < 5 minutes
            const fileCount = (db.prepare('SELECT COUNT(*) as c FROM files').get() as CountRow).c;
            const exportCount = (db.prepare('SELECT COUNT(*) as c FROM exports').get() as CountRow)
              .c;
            const depCount = (
              db.prepare('SELECT COUNT(*) as c FROM dependencies').get() as CountRow
            ).c;
            return {
              content: [
                {
                  type: 'text',
                  text: `Index fresh (${ageMin}m ago): ${fileCount} files, ${exportCount} exports, ${depCount} deps. Skipped re-index.`,
                },
              ],
            };
          }
        }
      }

      const indexStart = Date.now();
      const stats = indexDirectory(db, rootDir);
      const root = stats.root; // realpath: rows are stored under it
      slog(
        'INFO',
        `index_directory: files=${stats.files} exports=${stats.exports} deps=${stats.deps} pruned=${stats.prunedFiles} duration_ms=${Date.now() - indexStart}`,
      );

      return { content: [{ type: 'text', text: formatIndexSummary(db, root, stats) }] };
    } catch (err) {
      slog('CRITICAL', `tool index_directory: failed error=${errorClass(err)}`);
      return { content: [{ type: 'text', text: `Error: ${errorMessage(err)}` }], isError: true };
    }
  },
);

// ─── Tool: find_symbol ───────────────────────────────────────────────────────
const findSymbolStmt = db.prepare(`
  SELECT e.name, e.kind, e.description, f.path, f.extension, f.summary, f.size_bytes, f.modified_at, f.indexed_at
  FROM exports e JOIN files f ON e.file_id = f.id
  WHERE e.name LIKE ?
  ORDER BY e.name
`);
// PHP (CCA-16): exports.description holds the namespace-qualified name, so
// `App\Models\User` (leading backslash optional, % wildcard) finds it too.
const findQualifiedStmt = db.prepare(`
  SELECT e.name, e.kind, e.description, f.path, f.extension, f.summary, f.size_bytes, f.modified_at, f.indexed_at
  FROM exports e JOIN files f ON e.file_id = f.id
  WHERE f.extension = '.php' AND e.description LIKE ?
  ORDER BY e.description
`);
server.tool(
  'find_symbol',
  'Where is symbol X defined? Lists the files that export a function, class, type or constant by that name.',
  {
    name: z.string().describe('Symbol name (PHP: short or namespace-qualified); % is a wildcard'),
    absolute_paths: z.boolean().optional().describe(ABSOLUTE_PATHS_DESC),
  },
  async ({ name, absolute_paths }) => {
    const show = pathDisplay(db, { absolute: absolute_paths });
    type Row = FreshRow & {
      name: string;
      kind: string;
      description: string | null;
      extension: string | null;
      summary: string;
      indexed_at: string;
    };
    const repo = fresh.checkRepos();
    const lookup = () =>
      (name.includes('\\')
        ? findQualifiedStmt.all(name.replace(/^\\/, ''))
        : findSymbolStmt.all(name)) as Row[];
    let rows = lookup();
    const files = fresh.checkFiles(rows);
    if (files.changed) rows = lookup();
    const notice = freshnessNotice(repo, files);

    if (rows.length === 0) {
      return { content: [{ type: 'text', text: `${notice}No exports matching "${name}" found.` }] };
    }

    const stamp = showTimestamps();
    const label = (r: Row) => (r.extension === '.php' && r.description ? r.description : r.name);
    const text = rows
      .map(
        (r) =>
          `${label(r)} (${r.kind}) — ${show(r.path)}\n  ${r.summary}${stamp ? ` | indexed ${r.indexed_at}` : ''}`,
      )
      .join('\n\n');
    return { content: [{ type: 'text', text: notice + text }] };
  },
);

// ─── Tool: get_file_context ──────────────────────────────────────────────────
// CCA-04 (#119): signatures, line numbers and import lines, so "how do I call
// X / what does it depend on" needs no follow-up read. Lists are capped so a
// big file stays small; snippets are opt-in and capped per export and in total.
const MAX_LISTED_EXPORTS = 40;
const MAX_LISTED_IMPORT_LINES = 30;
const MAX_LISTED_EDGES = 30;
const SNIPPET_MAX_LINES = 20;
const SNIPPET_MAX_CHARS = 2048;
server.tool(
  'get_file_context',
  'What does this file export (signatures, lines), what does it import, and who imports it?',
  {
    path: z.string().describe('Repo-relative or absolute file path'),
    snippet: z.boolean().optional().describe("Add each export's source"),
    include_changes: z.boolean().optional().describe('Add recent diffs'),
    change_limit: z.number().optional().describe('Max diffs (default 3)'),
    absolute_paths: z.boolean().optional().describe(ABSOLUTE_PATHS_DESC),
  },
  async ({ path: rawPath, snippet, include_changes, change_limit, absolute_paths }) => {
    const show = pathDisplay(db, { absolute: absolute_paths });
    const resolved = resolveToolPath(db, rawPath);
    if (resolved.kind === 'ambiguous') {
      return {
        content: [
          {
            type: 'text',
            text: `"${rawPath}" matches ${resolved.candidates.length} indexed files. Pass one of these paths:\n${resolved.candidates.map((c) => `- ${show(c)}`).join('\n')}`,
          },
        ],
        isError: true,
      };
    }
    const filePath = resolved.path;
    const getFile = () =>
      db.prepare(`SELECT * FROM files WHERE path = ?`).get(filePath) as FileRow | undefined;
    const getExports = (id: number) =>
      db
        .prepare(
          `SELECT name, kind, signature, line FROM exports WHERE file_id = ? ORDER BY COALESCE(line, 1e9), id`,
        )
        .all(id) as { name: string; kind: string; signature: string | null; line: number | null }[];
    const repo = fresh.checkRepos();
    let file = getFile();
    let files = { changed: false, reindexed: 0, dropped: 0 };
    if (file) {
      files = fresh.checkFiles([file]);
      if (files.changed) file = getFile();
    } else if (fresh.indexIfEligible(filePath)) {
      file = getFile();
      files = { changed: true, reindexed: 1, dropped: 0 };
    }
    const notice = freshnessNotice(repo, files);

    if (!file) {
      const gone =
        files.dropped > 0
          ? 'was deleted from disk and dropped from the index'
          : 'not in index. Index it with index_directory or code-context-reindex';
      return { content: [{ type: 'text', text: `${notice}File "${show(filePath)}" ${gone}.` }] };
    }

    let exports = getExports(file.id);
    // A row indexed before schema v25 (import_lines NULL) has no signatures or
    // import lines. Re-index that one file quietly (content unchanged, so no
    // notice); when it cannot be re-indexed it renders as name (kind).
    if (
      file.import_lines == null &&
      hasSignatureParser(file.extension ?? '') &&
      fresh.indexIfEligible(filePath)
    ) {
      file = getFile() ?? file;
      exports = getExports(file.id);
    }

    const deps = db
      .prepare(
        `
      SELECT f.path, f.summary, d.symbols
      FROM dependencies d JOIN files f ON d.target_id = f.id
      WHERE d.source_id = ?
    `,
      )
      .all(file.id) as { path: string; summary: string; symbols: string }[];

    const dependents = db
      .prepare(
        `
      SELECT f.path, f.summary, d.symbols
      FROM dependencies d JOIN files f ON d.source_id = f.id
      WHERE d.target_id = ?
    `,
      )
      .all(file.id) as { path: string; summary: string; symbols: string }[];

    function formatSize(bytes: number): string {
      if (bytes < 1024) return bytes + ' B';
      if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
      return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
    }
    /** First `max` items, then a "+N more" line. */
    function capped<T>(items: T[], max: number, render: (t: T) => string): string {
      const lines = items.slice(0, max).map(render);
      if (items.length > max) lines.push(`+${items.length - max} more`);
      return lines.join('\n');
    }

    // Snippets (opt-in): the declaration's source, capped per export and in total.
    let snippetBudget = SNIPPET_MAX_CHARS;
    const content: string | null = snippet ? (file.content ?? null) : null;
    const snippetOf = (line: number | null): string => {
      if (!content || line == null || snippetBudget <= 0) return '';
      const { lines, truncated } = declarationLines(
        content,
        line,
        file.extension ?? '',
        SNIPPET_MAX_LINES,
      );
      let body =
        lines.map((l) => (l.trim() ? '    ' + l.trimEnd() : '')).join('\n') +
        (truncated ? '\n    …' : '');
      if (body.length > snippetBudget)
        body = body.slice(0, snippetBudget) + '\n    … (snippet budget reached)';
      snippetBudget -= body.length;
      return body ? '\n' + body : '';
    };
    const renderExport = (e: {
      name: string;
      kind: string;
      signature: string | null;
      line: number | null;
    }) => {
      const at = e.line != null ? `L${e.line} ` : '';
      const head = e.signature ? `- ${at}${e.signature}` : `- ${at}${e.name} (${e.kind})`;
      return head + snippetOf(e.line);
    };
    const importLines = parseStoredImportLines(file.import_lines);

    const sections = [
      `# ${show(file.path)}`,
      `${file.language} | ${formatSize(file.size_bytes ?? 0)} | ${file.line_count} lines${showTimestamps() ? ` | modified ${file.modified_at} | indexed ${file.indexed_at}` : ''}`,
      file.summary,
      file.description && file.description !== file.summary ? file.description : '',
      exports.length > 0
        ? `## Exports (${exports.length})\n${capped(exports, MAX_LISTED_EXPORTS, renderExport)}`
        : '',
      importLines.length > 0
        ? `## Import lines (${importLines.length})\n${capped(importLines, MAX_LISTED_IMPORT_LINES, (l) => `L${l.line} ${l.text}`)}`
        : '',
      file.external_imports ? `## External packages\n${file.external_imports}` : '',
      deps.length > 0
        ? `## Imports from (${deps.length})\n${capped(deps, MAX_LISTED_EDGES, (d) => `- ${show(d.path)} [${d.symbols}]`)}`
        : '',
      dependents.length > 0
        ? `## Imported by (${dependents.length})\n${capped(dependents, MAX_LISTED_EDGES, (d) => `- ${show(d.path)} [${d.symbols}]`)}`
        : '',
    ].filter((s) => s);

    // C1 (#10): change history is opt-in — the +200-token diff payload only pays off when debugging
    const shouldIncludeChanges = include_changes === true;
    if (shouldIncludeChanges) {
      const maxChanges = change_limit ?? 3;
      const changes = db
        .prepare(
          `
        SELECT event, timestamp, old_summary, new_summary,
               old_line_count, new_line_count, old_size_bytes, new_size_bytes,
               old_exports, new_exports, diff_text, reason
        FROM changes WHERE file_path = ? ORDER BY timestamp DESC LIMIT ?
      `,
        )
        .all(filePath, maxChanges) as Omit<ChangeRow, 'file_path'>[];

      sections.push('', `## Recent changes (${changes.length})`);
      for (const c of changes) {
        const parts = [`- **${c.event}** at ${c.timestamp}`];
        if (c.old_line_count != null && c.new_line_count != null) {
          const delta = c.new_line_count - c.old_line_count;
          parts.push(
            `  Lines: ${c.old_line_count} → ${c.new_line_count} (${delta >= 0 ? '+' : ''}${delta})`,
          );
        }
        if (c.old_size_bytes != null && c.new_size_bytes != null) {
          const delta = c.new_size_bytes - c.old_size_bytes;
          parts.push(
            `  Size: ${c.old_size_bytes}B → ${c.new_size_bytes}B (${delta >= 0 ? '+' : ''}${delta})`,
          );
        }
        if (c.new_summary && c.new_summary !== c.old_summary) {
          parts.push(`  Summary: ${c.new_summary}`);
        }
        if (c.old_exports !== c.new_exports && (c.old_exports || c.new_exports)) {
          parts.push(`  Exports: ${c.old_exports ?? '(none)'} → ${c.new_exports ?? '(none)'}`);
        }
        if (c.reason) {
          parts.push(`  Reason: ${c.reason}`);
        }
        if (c.diff_text) {
          parts.push(
            `  Diff:\n${c.diff_text
              .split('\n')
              .map((l: string) => `    ${l}`)
              .join('\n')}`,
          );
        }
        sections.push(parts.join('\n'));
      }
    }

    return { content: [{ type: 'text', text: notice + sections.join('\n') }] };
  },
);

// ─── Tools: who_imports, exports_in (CCA-05, #120) ───────────────────────────
// Answers from the import graph (dependencies + exports); see graph.ts for the
// symbol rules and how re-exports and namespace imports count.
server.tool(
  'who_imports',
  'Which files import X (file path or exported symbol)? Complete list from the import graph, with symbols, lines and re-exports. No grep needed.',
  {
    target: z.string().describe('File path or symbol name'),
    absolute_paths: z.boolean().optional().describe(ABSOLUTE_PATHS_DESC),
  },
  async ({ target, absolute_paths }) => {
    const r = whoImports(db, target, {
      show: pathDisplay(db, { absolute: absolute_paths }),
      fresh,
    });
    return { content: [{ type: 'text', text: r.text }], ...(r.isError ? { isError: true } : {}) };
  },
);

server.tool(
  'exports_in',
  'What does directory D export, and which exports are unused (unused: true)? Signatures and lines, complete from the import graph.',
  {
    dir: z.string(),
    unused: z.boolean().optional(),
    absolute_paths: z.boolean().optional().describe(ABSOLUTE_PATHS_DESC),
  },
  async ({ dir, unused, absolute_paths }) => {
    const r = exportsIn(db, dir, unused === true, {
      show: pathDisplay(db, { absolute: absolute_paths }),
      fresh,
    });
    return { content: [{ type: 'text', text: r.text }], ...(r.isError ? { isError: true } : {}) };
  },
);

// ─── Tool: set_description ───────────────────────────────────────────────────
server.tool(
  'set_description',
  'Set a manual description for a file (persists across re-indexes)',
  {
    path: z.string().describe('File path: absolute, or relative to the project root'),
    description: z.string().describe('Description of what the file does'),
  },
  async ({ path: rawPath, description }) => {
    const show = pathDisplay(db);
    const resolved = resolveToolPath(db, rawPath);
    if (resolved.kind === 'ambiguous') {
      return {
        content: [
          {
            type: 'text',
            text: `"${rawPath}" matches ${resolved.candidates.length} indexed files. Pass one of these paths:\n${resolved.candidates.map((c) => `- ${show(c)}`).join('\n')}`,
          },
        ],
        isError: true,
      };
    }
    const filePath = resolved.path;
    const result = db
      .prepare(`UPDATE files SET description = ? WHERE path = ?`)
      .run(description, filePath);
    if (result.changes === 0) {
      return {
        content: [{ type: 'text', text: `File "${show(filePath)}" not in index.` }],
        isError: true,
      };
    }
    return { content: [{ type: 'text', text: `Description set for ${show(filePath)}` }] };
  },
);

// ─── Tool: set_directory_description ─────────────────────────────────────────
server.tool(
  'set_directory_description',
  'Set a manual description for a directory (persists across re-indexes)',
  {
    path: z.string().describe('Directory path: absolute, or relative to the project root'),
    description: z.string().describe('Description of what the directory contains'),
  },
  async ({ path: rawPath, description }) => {
    const dirPath = resolveDirPath(db, rawPath);
    const result = db
      .prepare(`UPDATE directories SET description = ? WHERE path = ?`)
      .run(description, dirPath);
    if (result.changes === 0) {
      return {
        content: [{ type: 'text', text: `Directory "${rawPath}" not in index.` }],
        isError: true,
      };
    }
    return { content: [{ type: 'text', text: `Description set for ${pathDisplay(db)(dirPath)}` }] };
  },
);

// ─── Tool: set_change_reason ─────────────────────────────────────────────────
server.tool(
  'set_change_reason',
  'Set a reason/explanation for a recorded file change',
  {
    id: z.number().describe('Change ID'),
    reason: z.string().describe('Why this change was made'),
  },
  async ({ id, reason }) => {
    const result = db.prepare(`UPDATE changes SET reason = ? WHERE id = ?`).run(reason, id);
    if (result.changes === 0) {
      return { content: [{ type: 'text', text: `Change ${id} not found.` }], isError: true };
    }
    return { content: [{ type: 'text', text: `Reason set for change ${id}` }] };
  },
);

// ─── Tool: get_changes ───────────────────────────────────────────────────────
server.tool(
  'get_changes',
  'Get recent file changes grouped by file path, showing what changed (size, lines, exports, summary diffs)',
  {
    file_path: z
      .string()
      .optional()
      .describe('Filter to a specific file path (supports % wildcards)'),
    limit: z.number().optional().describe('Max changes to return (default 50)'),
    absolute_paths: z.boolean().optional().describe(ABSOLUTE_PATHS_DESC),
  },
  async ({ file_path, limit, absolute_paths }) => {
    const show = pathDisplay(db, { absolute: absolute_paths });
    const maxRows = limit ?? 50;
    let rows: Omit<ChangeRow, 'diff_text'>[];

    if (file_path) {
      const term =
        path.isAbsolute(file_path) && !file_path.includes('%')
          ? canonicalPath(file_path)
          : file_path;
      const pattern = term.includes('%') ? term : `%${term}%`;
      rows = db
        .prepare(
          `
        SELECT file_path, event, timestamp,
               old_summary, new_summary,
               old_line_count, new_line_count,
               old_size_bytes, new_size_bytes,
               old_exports, new_exports, reason
        FROM changes
        WHERE file_path LIKE ?
        ORDER BY file_path, timestamp DESC
        LIMIT ?
      `,
        )
        .all(pattern, maxRows) as Omit<ChangeRow, 'diff_text'>[];
    } else {
      rows = db
        .prepare(
          `
        SELECT file_path, event, timestamp,
               old_summary, new_summary,
               old_line_count, new_line_count,
               old_size_bytes, new_size_bytes,
               old_exports, new_exports, reason
        FROM changes
        ORDER BY file_path, timestamp DESC
        LIMIT ?
      `,
        )
        .all(maxRows) as Omit<ChangeRow, 'diff_text'>[];
    }

    if (rows.length === 0) {
      return { content: [{ type: 'text', text: 'No changes recorded.' }] };
    }

    // Group by file
    const grouped = new Map<string, Omit<ChangeRow, 'diff_text'>[]>();
    for (const row of rows) {
      const arr = grouped.get(row.file_path) ?? [];
      arr.push(row);
      grouped.set(row.file_path, arr);
    }

    const sections: string[] = [];
    for (const [filePath, changes] of grouped) {
      const lines = [
        `## ${show(filePath)} (${changes.length} change${changes.length > 1 ? 's' : ''})`,
      ];
      for (const c of changes) {
        const parts = [`- **${c.event}** at ${c.timestamp}`];
        if (c.old_line_count != null && c.new_line_count != null) {
          const delta = c.new_line_count - c.old_line_count;
          parts.push(
            `  Lines: ${c.old_line_count} → ${c.new_line_count} (${delta >= 0 ? '+' : ''}${delta})`,
          );
        }
        if (c.old_size_bytes != null && c.new_size_bytes != null) {
          const delta = c.new_size_bytes - c.old_size_bytes;
          parts.push(
            `  Size: ${c.old_size_bytes}B → ${c.new_size_bytes}B (${delta >= 0 ? '+' : ''}${delta})`,
          );
        }
        if (c.new_summary && c.new_summary !== c.old_summary) {
          parts.push(`  Summary: ${c.new_summary}`);
        }
        if (c.old_exports !== c.new_exports && (c.old_exports || c.new_exports)) {
          parts.push(`  Exports: ${c.old_exports ?? '(none)'} → ${c.new_exports ?? '(none)'}`);
        }
        lines.push(parts.join('\n'));
      }
      sections.push(lines.join('\n'));
    }

    return { content: [{ type: 'text', text: sections.join('\n\n') }] };
  },
);

// ─── Tool: search_files ──────────────────────────────────────────────────────
const searchFilesStmt = db.prepare(`
  SELECT path, language, extension, size_bytes, line_count, summary, created_at, modified_at, indexed_at,
    (SELECT COUNT(*) FROM exports WHERE file_id = files.id) as export_count,
    (SELECT COUNT(*) FROM dependencies WHERE source_id = files.id) as dep_count
  FROM files
  WHERE path LIKE ? OR summary LIKE ?
  ORDER BY path
  LIMIT 25
`);
type SearchFileRow = Omit<
  FileRow,
  'id' | 'description' | 'external_imports' | 'import_lines' | 'content'
> & { export_count: number; dep_count: number };
server.tool(
  'search_files',
  'Which files have this text in their path or summary? Not file contents: grep for code. Max 25.',
  {
    query: z.string().describe('Text to match; % is a wildcard'),
    absolute_paths: z.boolean().optional().describe(ABSOLUTE_PATHS_DESC),
  },
  async ({ query, absolute_paths }) => {
    const show = pathDisplay(db, { absolute: absolute_paths });
    // An absolute path (any spelling) matches the realpath the rows are stored under.
    const term = path.isAbsolute(query) && !query.includes('%') ? canonicalPath(query) : query;
    const pattern = term.includes('%') ? term : `%${term}%`;
    const repo = fresh.checkRepos();
    let rows = searchFilesStmt.all(pattern, pattern) as SearchFileRow[];
    const files = fresh.checkFiles(rows);
    if (files.changed) rows = searchFilesStmt.all(pattern, pattern) as SearchFileRow[];
    const notice = freshnessNotice(repo, files);

    if (rows.length === 0) {
      return { content: [{ type: 'text', text: `${notice}No files matching "${query}".` }] };
    }

    const stamp = showTimestamps();
    const text = rows
      .map(
        (r) =>
          `${show(r.path)} (${r.language}, ${r.line_count} lines, ${r.export_count} exports, ${r.dep_count} deps)\n  ${stamp ? `Modified: ${r.modified_at} | indexed ${r.indexed_at} | ` : ''}${r.summary}`,
      )
      .join('\n\n');
    return { content: [{ type: 'text', text: notice + text }] };
  },
);

// ─── Tool: query (escape hatch) ──────────────────────────────────────────────
server.tool(
  'query',
  QUERY_DESCRIPTION,
  { sql: z.string().describe('One SELECT or PRAGMA table_info(t)') },
  async ({ sql }) => {
    const result = runBoundedQuery(db, sql);
    if (!result.ok) {
      return { content: [{ type: 'text', text: result.error }], isError: true };
    }
    return { content: [{ type: 'text', text: result.text }] };
  },
);

// ─── Tool: execute (escape hatch) ────────────────────────────────────────────
server.tool(
  'execute',
  'Run an INSERT, UPDATE, or DELETE against the context database. Refused: writes to gate columns ' +
    '(status of tickets/sprints/milestones/epics, tickets.qa_verified/verified_by/deleted_at, ' +
    'sprints.deleted_at/archived_at, milestones/epics.archived_at, projects.name/repo, github_* of tickets/milestones/projects), ' +
    'REPLACE, and DELETE on tickets/sprints/milestones/epics/projects. Use update_ticket, ' +
    'update_sprint/advance_sprint, update_milestone, update_epic, set_project or sync_github instead.',
  {
    sql: z
      .string()
      .describe('A write SQL statement (INSERT, UPDATE, DELETE only — no DROP or ALTER)'),
    params: z.array(z.any()).optional().describe('Optional positional parameters'),
  },
  async ({ sql, params = [] }) => {
    const result = runWriteStatement(db, sql, params);
    if (!result.ok) {
      return { content: [{ type: 'text', text: result.error }], isError: true };
    }
    return {
      content: [
        {
          type: 'text',
          text: `Rows affected: ${result.changes}, last id: ${result.lastInsertRowid}`,
        },
      ],
    };
  },
);

// ─── Health Check ───────────────────────────────────────────────────────────────
server.tool('health', 'Check server health and connectivity', {}, async () => {
  const startTime = Date.now();
  let dbHealthy = false;
  let dbError: string | null = null;

  try {
    db.prepare('SELECT 1').get();
    dbHealthy = true;
  } catch (err) {
    dbError = errorMessage(err);
  }

  const fileCount = db.prepare('SELECT COUNT(*) as c FROM files').get() as { c: number };
  const sprintCount = db.prepare('SELECT COUNT(*) as c FROM sprints').get() as { c: number };

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(
          {
            status: dbHealthy ? 'healthy' : 'unhealthy',
            timestamp: new Date().toISOString(),
            latency_ms: Date.now() - startTime,
            database: {
              connected: dbHealthy,
              error: dbError,
              files_indexed: fileCount?.c ?? 0,
              sprints: sprintCount?.c ?? 0,
            },
            dist_freshness: checkDistFreshness() ?? 'fresh',
          },
          null,
          2,
        ),
      },
    ],
    isError: !dbHealthy,
  };
});

// ─── Scrum tools ─────────────────────────────────────────────────────────────
// Notify calls read the dashboard token beside this db, not beside the cwd (#235).
setDashboardDbPath(resolvedDbPath);
registerScrumTools(server, db);

// ─── Start ────────────────────────────────────────────────────────────────────
const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`code-context MCP server running — db: ${DB_PATH}`);
slog('INFO', `server: started version=${PKG_VERSION} db=${path.basename(resolvedDbPath)}`);
