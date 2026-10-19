// The context.db schema version: one counter for the whole file (code index
// and scrum tables). Lives on the index side since #179 so the index entry can
// refuse a database stamped by a newer version without loading the scrum
// schema. runMigrations (src/scrum/schema.ts) owns the migrations array and
// asserts it matches LATEST_SCHEMA_VERSION.
import BetterSqlite3 from 'better-sqlite3';
import type Database from 'better-sqlite3';

/** Single source of truth for the schema version. Must equal the max version in
 *  runMigrations' array — runMigrations asserts this at every call. */
export const LATEST_SCHEMA_VERSION = 27;

/**
 * Read the stamped schema version of an on-disk DB without opening it
 * read-write — a WAL-mode open litters empty -wal/-shm siblings next to a DB
 * the caller may be about to refuse (discovery #28). Returns 0 for missing,
 * unreadable, or pre-versioning DBs; the normal boot path decides those.
 */
export function peekSchemaVersion(dbPath: string): number {
  let peekDb: Database.Database | null = null;
  try {
    peekDb = new BetterSqlite3(dbPath, { readonly: true });
    const row = peekDb.prepare('SELECT MAX(version) v FROM schema_versions').get() as {
      v: number | null;
    };
    return row?.v ?? 0;
  } catch {
    return 0;
  } finally {
    if (peekDb) {
      try {
        peekDb.close();
      } catch {
        /* ignore */
      }
    }
  }
}
