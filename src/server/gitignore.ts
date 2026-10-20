// context.db stores the full content of every indexed file, so it must never
// be committed by accident. Setup adds it to the target project's .gitignore.
import fs from 'fs';
import path from 'path';

export const DB_IGNORE_PATTERN = 'context.db*'; // db, -wal/-shm and .bak-<ts> backups

export type GitignoreResult = 'added' | 'present' | 'not-a-repo';

/** Append the DB pattern to <dir>/.gitignore once; only touches git checkouts. */
export function ensureDbGitignored(dir: string): GitignoreResult {
  const gitignorePath = path.join(dir, '.gitignore');
  const hasGitignore = fs.existsSync(gitignorePath);
  if (!hasGitignore && !fs.existsSync(path.join(dir, '.git'))) return 'not-a-repo';

  const current = hasGitignore ? fs.readFileSync(gitignorePath, 'utf-8') : '';
  const lines = current.split(/\r?\n/).map((l) => l.trim());
  if (lines.includes(DB_IGNORE_PATTERN) || lines.includes(`/${DB_IGNORE_PATTERN}`))
    return 'present';

  const sep = current === '' || current.endsWith('\n') ? '' : '\n';
  fs.appendFileSync(
    gitignorePath,
    `${sep}\n# code-context index (holds indexed file contents)\n${DB_IGNORE_PATTERN}\n`,
  );
  return 'added';
}
