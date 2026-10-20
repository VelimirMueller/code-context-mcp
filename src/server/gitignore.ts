// context.db stores the full content of every indexed file, and the
// code-context-dump holds every table — neither must be committed by
// accident. Setup adds both patterns to the target project's .gitignore.
import fs from 'fs';
import path from 'path';

export const DB_IGNORE_PATTERN = 'context.db*'; // db, -wal/-shm and .bak-<ts> backups
export const DUMP_IGNORE_PATTERN = 'code-context-dump*.json'; // export_to_file dump (#250)

export type GitignoreResult = 'added' | 'present' | 'not-a-repo';

/** Append one pattern with its comment to <dir>/.gitignore once; only touches git checkouts. */
function ensureIgnored(dir: string, pattern: string, comment: string): GitignoreResult {
  const gitignorePath = path.join(dir, '.gitignore');
  const hasGitignore = fs.existsSync(gitignorePath);
  if (!hasGitignore && !fs.existsSync(path.join(dir, '.git'))) return 'not-a-repo';

  const current = hasGitignore ? fs.readFileSync(gitignorePath, 'utf-8') : '';
  const lines = current.split(/\r?\n/).map((l) => l.trim());
  if (lines.includes(pattern) || lines.includes(`/${pattern}`)) return 'present';

  const sep = current === '' || current.endsWith('\n') ? '' : '\n';
  fs.appendFileSync(gitignorePath, `${sep}\n${comment}\n${pattern}\n`);
  return 'added';
}

/** Append the DB pattern to <dir>/.gitignore once; only touches git checkouts. */
export function ensureDbGitignored(dir: string): GitignoreResult {
  return ensureIgnored(
    dir,
    DB_IGNORE_PATTERN,
    '# code-context index (holds indexed file contents)',
  );
}

/** Append the dump pattern to <dir>/.gitignore once; only touches git checkouts. */
export function ensureDumpGitignored(dir: string): GitignoreResult {
  return ensureIgnored(dir, DUMP_IGNORE_PATTERN, '# code-context dump (holds all indexed source)');
}
