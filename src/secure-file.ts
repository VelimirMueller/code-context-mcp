// #248 (TM-08): context.db holds the full content of every indexed file plus
// the scrum data, so the db, its -wal/-shm sidecars, every context.db.bak*
// backup and the export_to_file dump are created with mode 0600 — whatever the
// process umask is (macOS defaults give 0644, readable by every other OS user).
//
// - fs.openSync's mode argument is masked by the umask, so every create is
//   followed by chmodSync (umask-independent).
// - SQLite creates the -wal/-shm siblings lazily — for a fresh db only at the
//   first write, after any chmod done at open time — with 0644 & ~umask. They
//   are therefore pre-created here as zero-length 0600 files; SQLite reuses
//   the existing inodes (a zero-length sidecar is the state SQLite itself
//   leaves after a crash, so opening one is supported) and the mode survives
//   every later write.
// - An existing db with group/other read bits is NOT chmod'ed: user files are
//   never changed without notice. It gets one WARN line in the session log.
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { logThrottled } from './sessionlog.js';

/** Mode for every file that holds database content (owner read/write only). */
export const SECURE_FILE_MODE = 0o600;

/** chmod modes are meaningless on Windows — every helper here is a no-op there. */
const POSIX = process.platform !== 'win32';

const WAL_SIDECARS = ['-wal', '-shm'] as const;

const octal = (mode: number): string => `0${(mode & 0o777).toString(8)}`;

/** group or other read access? */
const isLoose = (mode: number): boolean => (mode & 0o044) !== 0;

/** Best-effort chmod to SECURE_FILE_MODE; never throws. */
export function restrictFile(file: string): void {
  if (!POSIX) return;
  try {
    fs.chmodSync(file, SECURE_FILE_MODE);
  } catch {
    // A missing file is another path's business; a failing chmod surfaces
    // through the copy/write that follows it.
  }
}

function createSecure(file: string): boolean {
  if (!POSIX) return false;
  try {
    const fd = fs.openSync(file, 'wx', SECURE_FILE_MODE);
    fs.closeSync(fd);
    restrictFile(file);
    return true;
  } catch {
    return false; // exists already, or not creatable: SQLite reports the real error
  }
}

/**
 * One WARN per loose db per minute, also across the several opens one setup
 * run makes — the session-log throttle keeps it to a single line.
 */
function warnIfLooseDb(dbPath: string): void {
  if (!POSIX) return;
  try {
    const st = fs.statSync(dbPath);
    if (st.isFile() && isLoose(st.mode)) {
      logThrottled(
        `secure-db-loose:${dbPath}`,
        'WARN',
        `secure-db: database is group/world-readable db=${path.basename(dbPath)} mode=${octal(st.mode)} — other OS users can read it; chmod 600 fixes it (never done automatically)`,
      );
    }
  } catch {
    // Fresh or missing: nothing to warn about.
  }
}

/**
 * Open a better-sqlite3 database so that the db file and the -wal/-shm
 * sidecars this process creates end up 0600 regardless of the umask. An
 * existing db keeps its mode untouched (one WARN line when group/world
 * readable); pre-existing sidecar files are left alone too.
 */
export function openDbSecure(dbPath: string): Database.Database {
  if (fs.existsSync(dbPath)) {
    warnIfLooseDb(dbPath);
  } else {
    createSecure(dbPath);
  }
  const precreated: string[] = [];
  for (const ext of WAL_SIDECARS) {
    const side = dbPath + ext;
    if (!fs.existsSync(side) && createSecure(side)) precreated.push(side);
  }
  try {
    return new Database(dbPath);
  } catch (err) {
    // A db SQLite cannot open must not keep our zero-length sidecars behind.
    for (const side of precreated) {
      try {
        fs.rmSync(side, { force: true });
      } catch {
        // Cleanup is best-effort; the open error below is the real problem.
      }
    }
    throw err;
  }
}

/**
 * Write a file holding database content (the export_to_file dump) with mode
 * 0600 — at creation and on an existing file, whatever the umask is.
 */
export function writeFileSecure(file: string, data: string | NodeJS.ArrayBufferView): void {
  fs.writeFileSync(file, data, { mode: SECURE_FILE_MODE });
  restrictFile(file);
}

/** Copy a db (the pre-migration context.db.bak) so the copy is 0600. */
export function copyFileSecure(src: string, dest: string): void {
  fs.copyFileSync(src, dest);
  restrictFile(dest);
}
