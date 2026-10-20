/**
 * What the INDEXER refuses to store, on top of the directory policy it shares
 * with the watcher (`src/shared/ignore.ts`).
 *
 * Why a second file: the shared policy decides which DIRECTORIES both the
 * watcher and the indexer skip, and its invariant is "the watcher never skips
 * a directory the indexer indexes". Everything here only narrows the indexer,
 * so watcher ⊇ indexer still holds — a pointless re-index at worst, never a
 * stale answer.
 *
 * Measured 2026-10-09 on the shared context.db: 19 085 of 26 749 indexed
 * files (71 %) were node_modules/vendor, nearly all from one Laravel repo, and
 * the `content` column made the db 256 MB. Search ranked third-party code above
 * the team's own. The rules below are the cheap half of the fix; `.gitignore`
 * (via `git ls-files`, see listRepoFiles in indexer.ts) is the other half.
 */

import fs from 'node:fs';
import path from 'node:path';
import { SKIP_DIR_NAMES, isUnderSkippedPath } from '../shared/ignore.js';

/** Never content worth searching: media, archives, fonts, binaries, databases. */
export const BINARY_EXTENSIONS: ReadonlySet<string> = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.ico',
  '.webp',
  '.avif',
  '.bmp',
  '.svg',
  '.tif',
  '.tiff',
  '.heic',
  '.psd',
  '.woff',
  '.woff2',
  '.ttf',
  '.eot',
  '.otf',
  '.mp3',
  '.mp4',
  '.wav',
  '.ogg',
  '.webm',
  '.mov',
  '.m4a',
  '.zip',
  '.tar',
  '.gz',
  '.tgz',
  '.br',
  '.zst',
  '.7z',
  '.rar',
  '.jar',
  '.pdf',
  '.doc',
  '.docx',
  '.xls',
  '.xlsx',
  '.ppt',
  '.pptx',
  '.exe',
  '.dll',
  '.so',
  '.dylib',
  '.wasm',
  '.class',
  '.o',
  '.a',
  '.bin',
  '.pyc',
  '.db',
  '.sqlite',
  '.sqlite3',
  '.db-shm',
  '.db-wal',
]);

/** Generated lockfiles: huge, machine-written, no symbols anyone searches for. */
export const LOCKFILE_NAMES: ReadonlySet<string> = new Set([
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'bun.lockb',
  'bun.lock',
  'composer.lock',
  'Gemfile.lock',
  'Cargo.lock',
  'poetry.lock',
  'Pipfile.lock',
  'uv.lock',
  'go.sum',
  'pubspec.lock',
  'Podfile.lock',
  'mix.lock',
  'flake.lock',
]);

export const SKIP_FILE_NAMES: ReadonlySet<string> = new Set(['.DS_Store', 'Thumbs.db', '.gitkeep']);

/**
 * Secret-shaped files the indexer refuses outright (threat model TM-09). Their
 * full content would otherwise land in `context.db` and be returned by
 * search_files, get_file_context and /api/file/:id — copying secrets into a
 * second file with weaker protection and into agent context. Matched on the
 * basename, case-insensitive. `CODE_CONTEXT_INDEX_ALLOW` opts a name back in.
 *
 * Extensions:  .pem .key .p12 .pfx .jks .keystore .asc .gpg .tfstate
 *              .tfstate.backup .kdbx .ovpn
 * Names:       id_rsa* id_dsa* id_ecdsa* id_ed25519*
 *              credentials credentials.json credentials.yml credentials.yaml
 *              secrets.yml secrets.yaml secrets.json
 *              service-account*.json *-service-account*.json
 *              terraform.tfvars *.tfvars token.json oauth*.json
 *              .netrc .htpasswd .pgpass .npmrc .pypirc .git-credentials
 *              known_hosts authorized_keys
 *
 * The dot-prefixed names above are already caught by the historic dot rule in
 * isDeniedFileName; they stay in the list so the documented list and the code
 * do not drift. `.tfstate.backup` is a multi-dot suffix, not an extname.
 */
export const SECRET_EXTENSIONS: ReadonlySet<string> = new Set([
  '.pem',
  '.key',
  '.p12',
  '.pfx',
  '.jks',
  '.keystore',
  '.asc',
  '.gpg',
  '.tfstate',
  '.kdbx',
  '.ovpn',
]);

export const SECRET_FILE_NAMES: ReadonlySet<string> = new Set([
  'credentials',
  'credentials.json',
  'credentials.yml',
  'credentials.yaml',
  'secrets.yml',
  'secrets.yaml',
  'secrets.json',
  '.netrc',
  '.htpasswd',
  '.pgpass',
  '.npmrc',
  '.pypirc',
  '.git-credentials',
  'known_hosts',
  'authorized_keys',
  'terraform.tfvars',
  'token.json',
]);

/** Basename prefixes that are secret material whatever follows (`id_rsa.pub`, `id_rsa-…`). */
const SECRET_NAME_PREFIXES = ['id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519'];

/** Multi-dot suffixes `path.extname` would not return (`terraform.tfstate.backup`). */
const SECRET_SUFFIXES = ['.tfstate.backup'];

/** True when a lowercased basename is secret-shaped (extension, prefix, exact, glob). */
function isSecretShaped(lower: string): boolean {
  if (SECRET_EXTENSIONS.has(path.extname(lower))) return true;
  if (SECRET_SUFFIXES.some((s) => lower.endsWith(s))) return true;
  if (SECRET_FILE_NAMES.has(lower)) return true;
  if (SECRET_NAME_PREFIXES.some((p) => lower.startsWith(p))) return true;
  if (lower.endsWith('.tfvars')) return true;
  if (lower.startsWith('oauth') && lower.endsWith('.json')) return true;
  if (
    lower.endsWith('.json') &&
    (lower.startsWith('service-account') || lower.includes('-service-account'))
  )
    return true;
  return false;
}

/** `CODE_CONTEXT_INDEX_ALLOW`: comma-separated basenames or `*.ext` globs that opt a name back in. */
function allowedByEnv(name: string): boolean {
  const raw = process.env.CODE_CONTEXT_INDEX_ALLOW;
  if (!raw || !raw.trim()) return false;
  const lower = name.toLowerCase();
  for (const entry of raw.split(',')) {
    const p = entry.trim().toLowerCase();
    if (!p) continue;
    if (p.startsWith('*.')) {
      if (lower.endsWith(p.slice(1))) return true;
    } else if (p === lower) {
      return true;
    }
  }
  return false;
}

/** Minified bundles and source maps are build output even when committed. */
const GENERATED_SUFFIXES = [
  '.min.js',
  '.min.mjs',
  '.min.css',
  '.js.map',
  '.css.map',
  '.map',
  '.bundle.js',
];

const DEFAULT_MAX_FILE_KB = 512;

/** Size ceiling per file. `CODE_CONTEXT_MAX_FILE_KB` overrides; read at call time. */
export function maxFileBytes(): number {
  const raw = Number(process.env.CODE_CONTEXT_MAX_FILE_KB);
  const kb = Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_MAX_FILE_KB;
  return Math.floor(kb * 1024);
}

/** True when a file of this NAME is never indexed (extension, lockfile, generated). */
// Names are compared case-insensitively: APFS is case-insensitive by default,
// so `Node_Modules/` IS `node_modules/` on disk. Indexer-only, so watcher ⊇
// indexer (shared/ignore.ts) still holds.
const lowerSet = (s: Iterable<string>): ReadonlySet<string> =>
  new Set(Array.from(s, (x) => x.toLowerCase()));
const SKIP_DIRS_LOWER = lowerSet(SKIP_DIR_NAMES);
const LOCKFILES_LOWER = lowerSet(LOCKFILE_NAMES);
const SKIP_FILES_LOWER = lowerSet(SKIP_FILE_NAMES);

export function isDeniedFileName(name: string): boolean {
  if (name.startsWith('.')) return true; // matches the walk's historic dot rule
  const lower = name.toLowerCase();
  if (SKIP_FILES_LOWER.has(lower) || LOCKFILES_LOWER.has(lower)) return true;
  if (BINARY_EXTENSIONS.has(path.extname(lower))) return true;
  if (GENERATED_SUFFIXES.some((s) => lower.endsWith(s))) return true;
  if (!allowedByEnv(lower) && isSecretShaped(lower)) return true;
  return false;
}

const laravelCache = new Map<string, boolean>();

/**
 * Laravel's `storage/` holds uploads, caches, sessions and compiled views — never
 * source. A bare `storage` is too generic to skip everywhere (Android, Go and Rust
 * use it for real code, see shared/ignore.ts), so it is skipped only where an
 * `artisan` file sits next to it. Cached: called once per path segment.
 */
export function isLaravelStorage(dirPath: string): boolean {
  if (path.basename(dirPath).toLowerCase() !== 'storage') return false;
  const parent = path.dirname(dirPath);
  let hit = laravelCache.get(parent);
  if (hit === undefined) {
    try {
      hit = fs.statSync(path.join(parent, 'artisan')).isFile();
    } catch {
      hit = false;
    }
    if (laravelCache.size > 4096) laravelCache.clear();
    laravelCache.set(parent, hit);
  }
  return hit;
}

/** True when a directory is never descended into by the indexer. */
export function isDeniedDir(absDir: string): boolean {
  const name = path.basename(absDir);
  return (
    name.startsWith('.') ||
    SKIP_DIRS_LOWER.has(name.toLowerCase()) ||
    isUnderSkippedPath(absDir.toLowerCase()) ||
    isLaravelStorage(absDir)
  );
}

/**
 * The one decision for a file the indexer might store, by absolute path.
 * `root` bounds the ancestor check (segments above it are not judged — a repo
 * may live under a dot-directory). `sizeBytes`, when known, applies the size cap.
 */
export function isDeniedPath(absPath: string, root?: string, sizeBytes?: number): boolean {
  const name = path.basename(absPath);
  if (isDeniedFileName(name)) return true;
  if (sizeBytes !== undefined && sizeBytes > maxFileBytes()) return true;

  const base = root ? path.resolve(root) : path.parse(absPath).root;
  const rel = path.relative(base, path.dirname(absPath));
  if (rel.startsWith('..') || path.isAbsolute(rel)) return false;
  if (rel === '') return false;
  let cur = base;
  for (const seg of rel.split(path.sep)) {
    cur = path.join(cur, seg);
    if (isDeniedDir(cur)) return true;
  }
  return false;
}

/** First 8 KB contains a NUL byte → binary, whatever the extension says. */
export function looksBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8192);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

/** True when a directory path, or any ancestor below `root`, is denied. */
export function isDeniedDirPath(absDir: string, root: string): boolean {
  const base = path.resolve(root);
  const rel = path.relative(base, absDir);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return false;
  let cur = base;
  for (const seg of rel.split(path.sep)) {
    cur = path.join(cur, seg);
    if (isDeniedDir(cur)) return true;
  }
  return false;
}

export type Admission =
  | { ok: true; real: string; size: number }
  | { ok: false; reason: 'gone' | 'unreadable' | 'not-file' | 'outside' | 'denied' | 'too-large' };

/** `child` is `parent` or below it (segment-wise; no `/a` vs `/ab` confusion, no `..`). */
export function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * THE gate every index write goes through — full index (index_directory, the
 * reindex CLI), git-diff driven refresh and read-time refresh alike. `root` must
 * itself be trusted by the caller: sandbox-checked (index_directory) or a root
 * recorded in indexed_repos (which only index_directory writes).
 *
 * 1. Normalise (`vendor/../src`, `./node_modules`) and require the path inside `root`.
 * 2. Apply the deny policy to every segment of the normalised path (case-insensitive).
 * 3. lstat: only regular files — a symlink is never followed, whatever it points at.
 * 4. realpath must stay inside realpath(root), and the policy is applied again to
 *    the resolved path — a symlinked DIRECTORY into node_modules or out of the
 *    repo is caught here.
 * Only `unreadable` means "do not know"; every other refusal is final.
 */
export function admitFile(file: string, root: string, realRoot?: string): Admission {
  const abs = path.resolve(file);
  const base = path.resolve(root);
  if (!isInside(abs, base) || abs === base) return { ok: false, reason: 'outside' };
  if (isDeniedPath(abs, base)) return { ok: false, reason: 'denied' };
  let st: fs.Stats;
  try {
    st = fs.lstatSync(abs);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return { ok: false, reason: code === 'ENOENT' || code === 'ENOTDIR' ? 'gone' : 'unreadable' };
  }
  if (!st.isFile()) return { ok: false, reason: 'not-file' };
  if (st.size > maxFileBytes()) return { ok: false, reason: 'too-large' };
  let real: string;
  let rr: string;
  try {
    real = fs.realpathSync(abs);
    rr = realRoot ?? fs.realpathSync(base);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return { ok: false, reason: code === 'ENOENT' || code === 'ENOTDIR' ? 'gone' : 'unreadable' };
  }
  if (!isInside(real, rr)) return { ok: false, reason: 'outside' };
  if (isDeniedPath(real, rr)) return { ok: false, reason: 'denied' };
  return { ok: true, real, size: st.size };
}
