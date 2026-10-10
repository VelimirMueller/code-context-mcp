/**
 * `npm run bench:publish` — commit data/ to the bench-results branch and push.
 *
 * Never operates on the current checkout: it stages only data/ inside a temp
 * git worktree checked out on bench-results, then pushes. The current checkout
 * must not itself be bench-results. A missing bench-results branch is
 * bootstrapped as an orphan containing only data/.
 *
 * Options (see `main` below): --run <id>, --dry-run, --no-push, --no-site.
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
    return { dryRun: true, runIds, commitMessage, files, pushed: false };
  }

  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bench-publish-')));
  const localBranchExists =
    runMaybe(cwd, env, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]) !== null;

  try {
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

    const commitEnv: NodeJS.ProcessEnv = { ...env };
    if (process.env.CI === 'true') {
      commitEnv.GIT_AUTHOR_NAME = 'github-actions[bot]';
      commitEnv.GIT_AUTHOR_EMAIL = 'github-actions[bot]@users.noreply.github.com';
      commitEnv.GIT_COMMITTER_NAME = 'github-actions[bot]';
      commitEnv.GIT_COMMITTER_EMAIL = 'github-actions[bot]@users.noreply.github.com';
    }
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

    return {
      dryRun: false,
      runIds,
      commitMessage,
      files: [...files, 'data/index.json', 'data/latest.json'],
      pushed,
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
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--dry-run') opts.dryRun = true;
    else if (args[i] === '--run') {
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
  try {
    const res = publish(opts);
    if (res.dryRun) {
      console.log(`dry-run: would commit "${res.commitMessage}"`);
      for (const f of res.files) console.log(`  ${f}`);
    } else {
      console.log(`published ${res.runIds.join(', ')} (${res.files.length} files)`);
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
