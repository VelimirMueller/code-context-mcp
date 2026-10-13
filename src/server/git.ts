// Small git helpers for the indexer and the read-time freshness guard.
//
// Security: git is only ever run through spawnSync with an argument ARRAY and
// shell:false — no string is ever handed to a shell. Commit ids are accepted
// only as full hex SHAs (SHA_RE) and passed after --end-of-options; paths go
// after `--`. Paths read from git output are re-checked by the caller
// (refreshFiles: realpath must stay inside the repo root).
//
// The hot path (readGitHead) never spawns a process: it reads .git/HEAD and the
// ref file directly, so checking ~20 repos costs a few dozen small reads. Only
// the cold paths (listing a repo, diffing two commits) shell out to git.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const GIT_TIMEOUT_MS = 60_000;
const MAX_BUFFER = 256 * 1024 * 1024;
/** A full SHA-1 or SHA-256 object id, nothing else. */
export const SHA_RE = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/;

function git(cwd: string, args: string[]): { ok: boolean; stdout: string } {
  try {
    const r = spawnSync('git', ['-C', cwd, ...args], {
      shell: false,
      encoding: 'utf-8',
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: MAX_BUFFER,
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' },
    });
    return { ok: r.status === 0 && !r.error, stdout: r.stdout ?? '' };
  } catch {
    return { ok: false, stdout: '' };
  }
}

/** Resolve the git dir of a checkout: `.git` directory, or the `gitdir:` pointer in a `.git` file. */
export function resolveGitDir(root: string): string | null {
  const dotGit = path.join(root, '.git');
  try {
    const st = fs.statSync(dotGit);
    if (st.isDirectory()) return dotGit;
    if (st.isFile()) {
      const m = /^gitdir:\s*(.+)\s*$/m.exec(fs.readFileSync(dotGit, 'utf-8'));
      if (m) return path.resolve(root, m[1].trim());
    }
  } catch {
    /* not a checkout */
  }
  return null;
}

/** True when `dir` itself is the top of a checkout (has a `.git` entry). */
export function isGitCheckout(dir: string): boolean {
  try {
    fs.statSync(path.join(dir, '.git'));
    return true;
  } catch {
    return false;
  }
}

/**
 * HEAD commit sha of the checkout at `root`, read from disk without spawning
 * git. Handles detached HEAD, loose refs, packed-refs and linked worktrees
 * (`commondir`). Returns null when anything is unexpected — callers then skip
 * the check rather than guess.
 */
export function readGitHead(root: string): string | null {
  try {
    const gitDir = resolveGitDir(root);
    if (!gitDir) return null;
    const head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf-8').trim();
    if (SHA_RE.test(head)) return head;
    const m = /^ref:\s*(refs\/[A-Za-z0-9._/-]+)$/.exec(head);
    if (!m || m[1].split('/').includes('..')) return null; // never read outside the git dir
    const ref = m[1];
    let common = gitDir;
    try {
      common = path.resolve(
        gitDir,
        fs.readFileSync(path.join(gitDir, 'commondir'), 'utf-8').trim(),
      );
    } catch {
      /* not a linked worktree */
    }
    for (const dir of gitDir === common ? [gitDir] : [gitDir, common]) {
      try {
        const sha = fs.readFileSync(path.join(dir, ref), 'utf-8').trim();
        if (SHA_RE.test(sha)) return sha;
      } catch {
        /* try packed-refs */
      }
    }
    const packed = fs.readFileSync(path.join(common, 'packed-refs'), 'utf-8');
    for (const line of packed.split('\n')) {
      const [sha, name] = line.trim().split(' ');
      if (name === ref && SHA_RE.test(sha)) return sha;
    }
  } catch {
    /* fall through */
  }
  return null;
}

/**
 * Every file git would show for this checkout — tracked plus untracked, minus
 * everything `.gitignore` (at any depth), `.git/info/exclude` and the global
 * excludes file hide. Absolute paths. Nested checkouts (submodules, embedded
 * repos) show up as a directory entry and are listed recursively with their
 * own ignore rules. Returns null when `root` is not inside a git work tree or
 * git is unavailable, so the caller can fall back to a plain walk.
 */
export function gitListFiles(root: string, depth = 0): string[] | null {
  const r = git(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard']);
  if (!r.ok) return null;
  const out: string[] = [];
  const seen = new Set<string>();
  for (const rel of r.stdout.split('\0')) {
    if (!rel) continue;
    const clean = rel.endsWith('/') ? rel.slice(0, -1) : rel;
    const abs = path.join(root, clean);
    if (seen.has(abs)) continue; // a conflicted file appears once per stage
    seen.add(abs);
    let st: fs.Stats;
    try {
      st = fs.lstatSync(abs);
    } catch {
      continue; // deleted from the working tree but still in the index
    }
    if (st.isDirectory()) {
      if (depth < 4 && isGitCheckout(abs)) {
        const nested = gitListFiles(abs, depth + 1);
        if (nested) out.push(...nested);
      }
      continue;
    }
    out.push(abs);
  }
  return out;
}

/** Files changed between two commits, absolute, limited to `root`. Null when the diff cannot be computed (unknown commit, not a repo). */
export function gitChangedFiles(root: string, from: string, to: string): string[] | null {
  if (!SHA_RE.test(from) || !SHA_RE.test(to)) return null;
  const r = git(root, [
    'diff',
    '--name-only',
    '-z',
    '--no-renames',
    '--relative',
    '--end-of-options',
    from,
    to,
    '--',
  ]);
  if (!r.ok) return null;
  return r.stdout
    .split('\0')
    .filter(Boolean)
    .map((rel) => path.join(root, rel));
}

/** True when git says `file` is ignored in the checkout at `root`. False on any doubt. */
export function gitIsIgnored(root: string, file: string): boolean {
  try {
    const r = spawnSync('git', ['-C', root, 'check-ignore', '-q', '--', file], {
      shell: false,
      timeout: 5_000,
      stdio: 'ignore',
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
    });
    return r.status === 0;
  } catch {
    return false;
  }
}
