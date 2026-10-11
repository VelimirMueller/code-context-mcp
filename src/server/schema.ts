// Database schema definitions for the code-context MCP server
import Database from "better-sqlite3";

export function initSchema(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS files (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      path             TEXT UNIQUE NOT NULL,
      language         TEXT,
      extension        TEXT,
      size_bytes       INTEGER,
      line_count       INTEGER,
      summary          TEXT,
      description      TEXT,
      external_imports TEXT,
      import_lines     TEXT,
      content          TEXT,
      created_at       TEXT,
      modified_at      TEXT,
      indexed_at       TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS exports (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      file_id     INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
      name        TEXT NOT NULL,
      kind        TEXT,
      description TEXT,
      signature   TEXT,
      line        INTEGER
    );

    CREATE TABLE IF NOT EXISTS dependencies (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      source_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
      target_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
      symbols   TEXT,
      UNIQUE(source_id, target_id)
    );

    CREATE INDEX IF NOT EXISTS idx_files_ext ON files(extension);
    CREATE INDEX IF NOT EXISTS idx_files_lang ON files(language);
    CREATE INDEX IF NOT EXISTS idx_exports_name ON exports(name);
    CREATE INDEX IF NOT EXISTS idx_exports_file ON exports(file_id);
    CREATE INDEX IF NOT EXISTS idx_deps_source ON dependencies(source_id);
    CREATE INDEX IF NOT EXISTS idx_deps_target ON dependencies(target_id);

    CREATE TABLE IF NOT EXISTS directories (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      path             TEXT UNIQUE NOT NULL,
      name             TEXT NOT NULL,
      parent_path      TEXT,
      depth            INTEGER NOT NULL DEFAULT 0,
      file_count       INTEGER NOT NULL DEFAULT 0,
      total_size_bytes INTEGER NOT NULL DEFAULT 0,
      total_lines      INTEGER NOT NULL DEFAULT 0,
      language_breakdown TEXT,
      description      TEXT,
      indexed_at       TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_dirs_path ON directories(path);
    CREATE INDEX IF NOT EXISTS idx_dirs_parent ON directories(parent_path);

    CREATE TABLE IF NOT EXISTS changes (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      file_path TEXT NOT NULL,
      event     TEXT NOT NULL,
      timestamp TEXT DEFAULT (datetime('now')),
      old_summary   TEXT,
      new_summary   TEXT,
      old_line_count INTEGER,
      new_line_count INTEGER,
      old_size_bytes INTEGER,
      new_size_bytes INTEGER,
      old_exports   TEXT,
      new_exports   TEXT,
      diff_text     TEXT,
      reason        TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_changes_path ON changes(file_path);

    -- One row per directory passed to index_directory: the commit it was
    -- indexed at lets the read-time freshness guard notice a moved HEAD and
    -- re-index only what git says changed (src/server/freshness.ts).
    CREATE TABLE IF NOT EXISTS indexed_repos (
      root       TEXT PRIMARY KEY,
      head       TEXT,
      indexed_at TEXT DEFAULT (datetime('now')),
      file_count INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_changes_ts ON changes(timestamp DESC);
  `);
  upgradeCodeIndexColumns(db);
}

/**
 * Columns added to the code-index tables after they shipped. CREATE TABLE IF
 * NOT EXISTS leaves an existing table alone, so a DB created by an older
 * version gets them here, idempotently, on every open (the server, the
 * reindex CLI and the dashboard all call initSchema). Old rows keep NULL and
 * render without the data until the file is re-indexed. Recorded as schema
 * v25 in runMigrations (src/scrum/schema.ts).
 */
const CODE_INDEX_COLUMNS: Array<[table: string, column: string, type: string]> = [
  // v25 / CCA-04 (#119): get_file_context signatures, line numbers, import lines
  ["exports", "signature", "TEXT"],
  ["exports", "line", "INTEGER"],
  ["files", "import_lines", "TEXT"],
];

export function upgradeCodeIndexColumns(db: Database.Database): void {
  for (const [table, column, type] of CODE_INDEX_COLUMNS) {
    const cols = db.pragma(`table_info(${table})`) as Array<{ name: string }>;
    if (!cols.some((c) => c.name === column)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
    }
  }
}
