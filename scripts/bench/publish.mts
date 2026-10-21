/**
 * `pnpm run bench:publish` — commit data/ to the bench-results branch and push.
 *
 * Never operates on the current checkout: it stages only data/ inside a temp
 * git worktree checked out on bench-results, then pushes. The current checkout
 * must not itself be bench-results. A missing bench-results branch is
 * bootstrapped as an orphan containing only data/.
 *
 * Options (see `main` below): --run <id>, --dry-run, --no-push, --no-site.
 *
 * Private suites (CCA-19): `--private-summary <suite-dir> [--runs id,id]`
 * publishes ONLY a redacted summary (scripts/bench/private-summary.mts) to
 * data/private/<alias-slug>.json plus data/private/index.json, through the
 * same temp worktree. The suite's run files are never copied. With
 * --dry-run it prints the guarded summary to stdout and writes nothing.
 *
 * After a local push it starts the Pages build (`gh workflow run pages.yml
 * --ref main`). A push to bench-results cannot do that itself: GitHub runs a
 * push-triggered workflow from the pushed branch, and bench-results holds
 * only data/. In Actions the Benchmark workflow dispatches Pages in its own
 * step, so the CLI skips it there.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildIndex, pickLatest, runFileProblem } from './lib/index-builder.mts';
import { privateSuiteContaining } from './live/suite.mts';
import {
  assertSummaryText,
  buildPrivateSummary,
  mergePrivateIndex,
  SummaryRefused,
} from './private-summary.mts';

export interface PublishOptions {
  repoDir?: string;
  remote?: string;
  branch?: string;
  runId?: string;
  dryRun?: boolean;
  push?: boolean;
  env?: NodeJS.ProcessEnv;
}

export interface PublishResult {
  dryRun: boolean;
  runIds: string[];
  commitMessage: string;
  files: string[];
  pushed: boolean;
  /** Dashboard bench dir the published data/ was copied to, or null. */
  mirrored: string | null;
}

interface LocalRun {
  runId: string;
  file: string;
  data: unknown;
}

function run(cwd: string, env: NodeJS.ProcessEnv | undefined, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    env: { ...process.env, ...(env ?? {}) },
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function runMaybe(cwd: string, env: NodeJS.ProcessEnv | undefined, args: string[]): string | null {
  try {
    return run(cwd, env, args);
  } catch {
    return null;
  }
}

function toplevel(cwd: string): string {
  return run(cwd, undefined, ['rev-parse', '--show-toplevel']);
}

/**
 * Private-suite guard (CCA-17): a run of a private suite, or any file that
 * sits under a private suite's directory (also through a symlink), is never
 * published. Throws before anything is written or pushed.
 */
function refusePrivate(file: string, data: unknown): void {
  const suiteDir = privateSuiteContaining(file);
  if (suiteDir) {
    throw new Error(
      `bench:publish: ${file} lies under the private suite ${suiteDir} — refusing to publish`,
    );
  }
  const suite = (data as { suite?: { private?: unknown } } | null)?.suite;
  if (suite && typeof suite === 'object' && suite.private !== false) {
    throw new Error(
      `bench:publish: ${file} is a run of a private suite (suite.private) — refusing to publish`,
    );
  }
}

function readRuns(dir: string): LocalRun[] {
  if (!fs.existsSync(dir)) return [];
  const out: LocalRun[] = [];
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json'))) {
    const file = path.join(dir, f);
    let data: unknown;
    try {
      data = JSON.parse(fs.readFileSync(file, 'utf-8'));
    } catch (e) {
      throw new Error(`bench:publish: invalid JSON in ${file}: ${(e as Error).message}`);
    }
    const problem = runFileProblem(data);
    if (problem) {
      // A file that claims to be a run (non-empty run_id) but fails
      // validation — above all a malformed run_id, which would become a
      // filename and a commit-message token — is REJECTED, not skipped:
      // publish stops before anything is written or pushed. Files without
      // a run_id are stray JSON (editor temps), skipped with a warning.
      const id = (data as Record<string, unknown> | null)?.run_id;
      if (typeof id === 'string' && id) {
        throw new Error(`bench:publish: ${file}: ${problem} — refusing to publish`);
      }
      console.warn(`bench:publish: skipping ${file}: ${problem}`);
      continue;
    }
    refusePrivate(file, data);
    out.push({ runId: (data as Record<string, unknown>).run_id as string, file, data });
  }
  return out;
}

function remoteRunStems(
  cwd: string,
  env: NodeJS.ProcessEnv | undefined,
  remote: string,
  branch: string,
): Set<string> {
  const out = runMaybe(cwd, env, [
    'ls-tree',
    '-r',
    '--name-only',
    `${remote}/${branch}`,
    '--',
    'data/runs',
  ]);
  if (!out) {
    // The ref exists (callers check first), so a failed ls-tree is a real
    // error (network, permissions) — treating it as "remote has no runs"
    // would re-publish or bootstrap over existing data.
    throw new Error(`bench:publish: git ls-tree failed on ${remote}/${branch} (data/runs)`);
  }
  return new Set(
    out
      .split('\n')
      .filter((l) => l.endsWith('.json'))
      .map((l) => path.basename(l, '.json')),
  );
}

/**
 * Copy the published data/ (index.json, latest.json, runs/) into the dir the
 * code-context dashboard reads, so its Benchmark page shows the new run
 * without a manual copy. The dashboard reads CODE_CONTEXT_BENCH_DIR first
 * (src/dashboard/handlers/bench.ts), so the same variable names the target.
 *
 * `srcDataDir` is the merged branch data/ (all runs, not only the new ones).
 * Returns the target dir, or null when nothing was copied. A failure here
 * must not fail the publish: the branch commit and push already happened.
 */
export function mirrorToDashboard(
  srcDataDir: string,
  env: NodeJS.ProcessEnv | undefined,
): string | null {
  const e = env ?? process.env;
  // Opt-in: only a machine that runs the dashboard sets the variable; Actions
  // has no dashboard to feed.
  const target = e.CODE_CONTEXT_BENCH_DIR?.trim();
  if (!target || e.GITHUB_ACTIONS === 'true') return null;
  const dst = path.resolve(target);
  // Copy beside the target, then replace it: the dashboard treats a dir with
  // an index.json as complete, so it must never see a half-written runs/.
  // Between rm and rename the dir is briefly absent; a request then falls
  // through to the next source, which is harmless.
  const staging = `${dst}.tmp-${process.pid}`;
  try {
    fs.rmSync(staging, { recursive: true, force: true });
    fs.cpSync(srcDataDir, staging, { recursive: true });
    fs.rmSync(dst, { recursive: true, force: true });
    fs.renameSync(staging, dst);
    return dst;
  } catch (err) {
    fs.rmSync(staging, { recursive: true, force: true });
    console.warn(`bench:publish: could not copy data/ to ${dst}: ${(err as Error).message}`);
    return null;
  }
}

/**
 * Check out `branch` into the empty dir `tmp` as a new worktree of `cwd`:
 * the local branch, else the remote one, else a fresh orphan with an empty
 * index (verified) so it can only ever hold data/.
 */
function addBranchWorktree(
  cwd: string,
  env: NodeJS.ProcessEnv | undefined,
  remote: string,
  branch: string,
  tmp: string,
  remoteExists: boolean,
): void {
  const localBranchExists =
    runMaybe(cwd, env, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]) !== null;
  if (localBranchExists) {
    run(cwd, env, ['worktree', 'add', tmp, branch]);
  } else if (remoteExists) {
    run(cwd, env, ['worktree', 'add', '-b', branch, tmp, `${remote}/${branch}`]);
  } else {
    run(cwd, env, ['worktree', 'add', '--detach', tmp, 'HEAD']);
    run(tmp, env, ['checkout', '--orphan', branch]);
    run(tmp, env, ['rm', '-rf', '--cached', '.']);
    // The orphan branch must contain ONLY data/: verify the destructive
    // index clear above actually emptied the index before copying files.
    if (run(tmp, env, ['ls-files']) !== '') {
      throw new Error(
        `bench:publish: orphan ${branch} index is not empty after git rm --cached — refusing to commit`,
      );
    }
  }
}

function commitEnvOf(env: NodeJS.ProcessEnv | undefined): NodeJS.ProcessEnv {
  const commitEnv: NodeJS.ProcessEnv = { ...env };
  if (process.env.CI === 'true') {
    commitEnv.GIT_AUTHOR_NAME = 'github-actions[bot]';
    commitEnv.GIT_AUTHOR_EMAIL = 'github-actions[bot]@users.noreply.github.com';
    commitEnv.GIT_COMMITTER_NAME = 'github-actions[bot]';
    commitEnv.GIT_COMMITTER_EMAIL = 'github-actions[bot]@users.noreply.github.com';
  }
  return commitEnv;
}

export interface PrivateSummaryOptions {
  repoDir?: string;
  remote?: string;
  branch?: string;
  /** The private suite dir (suite.json + data/runs). */
  suiteDir: string;
  /** Only these runs of the suite (default: all of them). */
  runIds?: string[];
  dryRun?: boolean;
  push?: boolean;
  env?: NodeJS.ProcessEnv;
  /** For tests. */
  now?: Date;
  skipScope?: boolean;
}

export interface PrivateSummaryResult {
  dryRun: boolean;
  slug: string;
  /** The guarded summary JSON (what is, or would be, written). */
  text: string;
  files: string[];
  commitMessage: string;
  pushed: boolean;
}

/**
 * Build the redacted summary of a private suite and publish ONLY it (plus
 * data/private/index.json) to bench-results through a temp worktree. The
 * guard runs at build time and again on the exact bytes before the write;
 * the staged file list is checked before the commit.
 */
export function publishPrivateSummary(opts: PrivateSummaryOptions): PrivateSummaryResult {
  const built = buildPrivateSummary({
    suiteDir: opts.suiteDir,
    runIds: opts.runIds,
    now: opts.now,
    skipScope: opts.skipScope,
  });
  const file = `data/private/${built.slug}.json`;
  const files = [file, 'data/private/index.json'];
  const commitMessage = `bench: private summary ${built.slug}`;
  if (opts.dryRun) {
    return {
      dryRun: true,
      slug: built.slug,
      text: built.text,
      files,
      commitMessage,
      pushed: false,
    };
  }

  const cwd = opts.repoDir ? path.resolve(opts.repoDir) : toplevel(process.cwd());
  const remote = opts.remote ?? 'origin';
  const branch = opts.branch ?? 'bench-results';
  const env = opts.env;
  if (run(cwd, env, ['rev-parse', '--abbrev-ref', 'HEAD']) === branch) {
    throw new Error(
      `bench:publish: refuse to run from the ${branch} checkout — switch to a working branch first`,
    );
  }
  runMaybe(cwd, env, ['fetch', remote, branch]);
  const remoteExists =
    runMaybe(cwd, env, ['rev-parse', '--verify', '--quiet', `refs/remotes/${remote}/${branch}`]) !==
    null;

  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bench-publish-')));
  try {
    addBranchWorktree(cwd, env, remote, branch, tmp, remoteExists);
    const privDir = path.join(tmp, 'data', 'private');
    fs.mkdirSync(privDir, { recursive: true });
    const indexFile = path.join(privDir, 'index.json');
    let existing: unknown = null;
    try {
      existing = JSON.parse(fs.readFileSync(indexFile, 'utf-8'));
    } catch {
      existing = null;
    }
    const index = mergePrivateIndex(existing, {
      slug: built.slug,
      alias: built.summary.alias,
      generated: built.summary.generated,
      file: `private/${built.slug}.json`,
    });
    const indexText = `${JSON.stringify(index, null, 2)}\n`;
    // Second guard pass on the exact bytes, right before they are written.
    assertSummaryText(built.text, built.denylist, file);
    assertSummaryText(indexText, built.denylist, 'data/private/index.json');
    fs.writeFileSync(path.join(privDir, `${built.slug}.json`), built.text);
    fs.writeFileSync(indexFile, indexText);

    const commitEnv = commitEnvOf(env);
    run(tmp, commitEnv, ['add', '--', 'data/private']);
    const staged = run(tmp, commitEnv, ['diff', '--cached', '--name-only'])
      .split('\n')
      .filter(Boolean);
    const stray = staged.filter((f) => !files.includes(f));
    if (stray.length) {
      throw new Error(
        `bench:publish: refusing — ${stray.length} staged file(s) outside the private summary`,
      );
    }
    if (staged.length === 0) {
      console.warn('bench:publish: private summary unchanged — nothing to commit');
      return {
        dryRun: false,
        slug: built.slug,
        text: built.text,
        files,
        commitMessage,
        pushed: false,
      };
    }
    run(tmp, commitEnv, ['commit', '-m', commitMessage]);
    let pushed = false;
    if (opts.push !== false) {
      run(tmp, commitEnv, ['push', remote, branch]);
      pushed = true;
    }
    return { dryRun: false, slug: built.slug, text: built.text, files, commitMessage, pushed };
  } finally {
    runMaybe(cwd, env, ['worktree', 'remove', '--force', tmp]);
  }
}

export function publish(opts: PublishOptions = {}): PublishResult {
  const cwd = opts.repoDir ? path.resolve(opts.repoDir) : toplevel(process.cwd());
  const remote = opts.remote ?? 'origin';
  const branch = opts.branch ?? 'bench-results';
  const env = opts.env;

  const currentBranch = run(cwd, env, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (currentBranch === branch) {
    throw new Error(
      `bench:publish: refuse to run from the ${branch} checkout — switch to a working branch first`,
    );
  }

  const localRuns = readRuns(path.join(cwd, 'data', 'runs'));

  if (!opts.dryRun) runMaybe(cwd, env, ['fetch', remote, branch]);
  const remoteExists =
    runMaybe(cwd, env, ['rev-parse', '--verify', '--quiet', `refs/remotes/${remote}/${branch}`]) !==
    null;
  const remoteStems = remoteExists ? remoteRunStems(cwd, env, remote, branch) : new Set<string>();

  let newRuns = localRuns.filter((r) => !remoteStems.has(r.runId));
  if (opts.runId) newRuns = newRuns.filter((r) => r.runId === opts.runId);

  if (newRuns.length === 0) {
    const hint = opts.runId ? ` --run ${opts.runId}` : '';
    throw new Error(
      `bench:publish: no new runs to publish (local data/runs has ${localRuns.length} run(s), ` +
        `remote has ${remoteStems.size})${hint}`,
    );
  }

  const runIds = newRuns.map((r) => r.runId);
  const commitMessage = `bench: add ${runIds.join(', ')}`;
  const files = newRuns.map((r) => `data/runs/${r.runId}.json`);

  if (opts.dryRun) {
    return { dryRun: true, runIds, commitMessage, files, pushed: false, mirrored: null };
  }

  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bench-publish-')));

  try {
    addBranchWorktree(cwd, env, remote, branch, tmp, remoteExists);

    const runsDir = path.join(tmp, 'data', 'runs');
    fs.mkdirSync(runsDir, { recursive: true });
    for (const r of newRuns) {
      fs.copyFileSync(r.file, path.join(runsDir, `${r.runId}.json`));
    }

    const merged = readRuns(runsDir);
    const index = buildIndex(merged.map((m) => m.data));
    const latest = pickLatest(merged.map((m) => m.data));
    fs.writeFileSync(path.join(tmp, 'data', 'index.json'), `${JSON.stringify(index, null, 2)}\n`);
    fs.writeFileSync(path.join(tmp, 'data', 'latest.json'), `${JSON.stringify(latest, null, 2)}\n`);

    const commitEnv = commitEnvOf(env);
    run(tmp, commitEnv, ['add', '-A', '--', 'data']);
    // All listed runs may already be byte-identical on the branch (e.g. a
    // re-publish after a failed push): commit only when something is staged,
    // because `git commit` with nothing staged aborts the publish.
    let committed = true;
    try {
      run(tmp, commitEnv, ['diff', '--cached', '--quiet', '--', 'data']);
      committed = false; // exits 0 only when there is nothing staged
      console.warn('bench:publish: data/ unchanged after staging — nothing to commit');
    } catch {
      run(tmp, commitEnv, ['commit', '-m', commitMessage]);
    }

    let pushed = false;
    if (opts.push !== false && committed) {
      run(tmp, commitEnv, ['push', remote, branch]);
      pushed = true;
    }

    // Copy the merged branch data/ to the dashboard while the temp worktree
    // still exists; `finally` removes it.
    const mirrored = mirrorToDashboard(path.join(tmp, 'data'), env);

    return {
      dryRun: false,
      runIds,
      commitMessage,
      files: [...files, 'data/index.json', 'data/latest.json'],
      pushed,
      mirrored,
    };
  } finally {
    runMaybe(cwd, env, ['worktree', 'remove', '--force', tmp]);
  }
}

function isMain(): boolean {
  return !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
}

if (isMain()) {
  const args = process.argv.slice(2);
  const opts: PublishOptions = {};
  let rebuildSite = process.env.GITHUB_ACTIONS !== 'true';
  let privateSuite: string | null = null;
  let privateRuns: string[] | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--dry-run') opts.dryRun = true;
    else if (args[i] === '--private-summary') {
      const v = args[++i];
      if (!v || !v.trim()) {
        console.error('bench:publish: --private-summary needs the private suite dir');
        process.exit(1);
      }
      privateSuite = v.trim();
    } else if (args[i] === '--runs') {
      const v = args[++i];
      if (!v || !v.trim()) {
        console.error(
          'bench:publish: --runs needs run ids (e.g. --runs opus-20261012-092421,glm-20261012-101500)',
        );
        process.exit(1);
      }
      privateRuns = v
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean);
    } else if (args[i] === '--run') {
      const v = args[++i];
      if (!v || !v.trim()) {
        console.error('bench:publish: --run needs a run id value (e.g. --run sim-20261010-120000)');
        process.exit(1);
      }
      opts.runId = v.trim();
    } else if (args[i] === '--no-push') opts.push = false;
    else if (args[i] === '--no-site') rebuildSite = false;
    else {
      console.error(`bench:publish: unknown argument ${args[i]}`);
      process.exit(1);
    }
  }
  if (privateRuns && !privateSuite) {
    console.error(
      'bench:publish: --runs works with --private-summary only (use --run <id> for public runs)',
    );
    process.exit(1);
  }
  if (privateSuite) {
    if (opts.runId) {
      console.error('bench:publish: --run cannot be combined with --private-summary (use --runs)');
      process.exit(1);
    }
    try {
      const res = publishPrivateSummary({
        suiteDir: privateSuite,
        runIds: privateRuns,
        dryRun: opts.dryRun,
        push: opts.push,
      });
      if (res.dryRun) {
        // The summary on stdout (pipe-able); the plan on stderr.
        process.stdout.write(res.text);
        console.error(`dry-run: guard passed; would commit "${res.commitMessage}"`);
        for (const f of res.files) console.error(`  ${f}`);
      } else {
        console.log(`published private summary ${res.slug} (${res.files.join(', ')})`);
        if (res.pushed && rebuildSite) {
          try {
            execFileSync('gh', ['workflow', 'run', 'pages.yml', '--ref', 'main'], {
              stdio: ['ignore', 'ignore', 'pipe'],
            });
            console.log('site: Pages build started (pages.yml on main)');
          } catch {
            console.warn(
              'site: could not start the Pages build. Run: gh workflow run pages.yml --ref main',
            );
          }
        }
      }
      process.exit(0);
    } catch (e) {
      const msg = (e as Error).message;
      console.error(e instanceof SummaryRefused ? `bench:publish: ${msg}` : msg);
      process.exit(1);
    }
  }
  try {
    const res = publish(opts);
    if (res.dryRun) {
      console.log(`dry-run: would commit "${res.commitMessage}"`);
      for (const f of res.files) console.log(`  ${f}`);
    } else {
      console.log(`published ${res.runIds.join(', ')} (${res.files.length} files)`);
      if (res.mirrored) console.log(`dashboard: copied data/ to ${res.mirrored}`);
      if (res.pushed && rebuildSite) {
        try {
          execFileSync('gh', ['workflow', 'run', 'pages.yml', '--ref', 'main'], {
            stdio: ['ignore', 'ignore', 'pipe'],
          });
          console.log('site: Pages build started (pages.yml on main)');
        } catch {
          console.warn(
            'site: could not start the Pages build. Run: gh workflow run pages.yml --ref main',
          );
        }
      }
    }
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }
}
