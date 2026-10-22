/**
 * Arguments of the two MCP entries (#284): `code-context [db-path]` and
 * `code-context-sprint [db-path]`.
 *
 * `--version` and `--help` are flags, never a database path. Any other argument
 * that starts with `-` is refused with exit 64 (EX_USAGE) before the server
 * opens anything, so a typo can no longer create a SQLite file named after it.
 *
 * Only node built-ins here: the index entry must not reach src/scrum,
 * src/dashboard or src/bridge (test/boundary.test.ts).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const EX_USAGE = 64;

export type EntryArgs =
  | { kind: 'db'; dbPath: string }
  | { kind: 'version' }
  | { kind: 'help' }
  | { kind: 'bad'; arg: string };

export function parseEntryArgs(argv: string[]): EntryArgs {
  // A flag counts in any position; extra positionals stay ignored, as before.
  for (const arg of argv) {
    if (arg === '--version' || arg === '-v') return { kind: 'version' };
    if (arg === '--help' || arg === '-h') return { kind: 'help' };
    if (arg.startsWith('-')) return { kind: 'bad', arg };
  }
  return { kind: 'db', dbPath: argv[0] ?? './context.db' };
}

export function entryUsage(bin: string): string {
  return (
    `usage: ${bin} [db-path]\n` +
    `  db-path        SQLite index file (default: ./context.db)\n` +
    `  --version, -v  print the package version\n` +
    `  --help, -h     print this help`
  );
}

/** The package version. src/server/ and dist/server/ both sit two levels below package.json. */
export function packageVersion(): string {
  try {
    const pkgPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../package.json');
    return JSON.parse(fs.readFileSync(pkgPath, 'utf-8')).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/** The database path, or print and exit for `--version`, `--help` and an unknown flag. */
export function resolveEntryArgs(bin: string, argv = process.argv.slice(2)): string {
  const parsed = parseEntryArgs(argv);
  switch (parsed.kind) {
    case 'db':
      return parsed.dbPath;
    case 'version':
      process.stdout.write(`${packageVersion()}\n`);
      return process.exit(0);
    case 'help':
      process.stdout.write(`${entryUsage(bin)}\n`);
      return process.exit(0);
    case 'bad':
      console.error(`${bin}: unknown option ${parsed.arg}\n${entryUsage(bin)}`);
      return process.exit(EX_USAGE);
  }
}
