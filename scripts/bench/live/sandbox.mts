/**
 * Sandbox env builders for the live bench (security review follow-up).
 *
 * The live bench runs untrusted code — a model through the opencode CLI, and
 * vitest over code that model wrote. Two env builders keep those children
 * on a minimal, secret-free environment instead of inheriting `process.env`:
 *
 *   - `agentSpawnEnv`  — the opencode child env (PATH, HOME, TMPDIR, the one
 *     provider key it reads, CODE_CONTEXT_ALLOWED_ROOTS). Nothing else: no
 *     GITHUB_TOKEN, no other provider key, no unrelated local vars.
 *   - `checkerSpawnEnv` — the vitest child env (PATH, HOME, TMPDIR, CI=1,
 *     NODE_ENV=test). Never any provider key or GITHUB_TOKEN.
 *
 * `stripProviderKeys` deletes every provider key name from the *parent*
 * `process.env` right after the runner reads the one it needs, so nothing
 * later (checkers, diagnostics, git) can accidentally inherit a key.
 */
import os from 'node:os';

/** Every provider key name the bench can touch (env + rig mapping). */
export const PROVIDER_KEY_ENV_NAMES: readonly string[] = [
  'ZAI_API_KEY',
  'ZHIPU_API_KEY',
  'DEEPSEEK_API_KEY',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'ANTHROPIC_API_KEY',
];

const DEFAULT_PATH = '/usr/local/bin:/usr/bin:/bin';

export interface AgentEnvOpts {
  /** Isolated HOME (fresh temp dir) the opencode child uses. */
  fakeHome: string;
  /** Name the opencode child reads the provider key under (e.g. ZHIPU_API_KEY). */
  keyExportName: string;
  /** The provider key value. Never logged; goes straight into the child env. */
  key: string;
  /** TMPDIR for the child; defaults to the OS temp dir. */
  tmpdir?: string;
  /** CODE_CONTEXT_ALLOWED_ROOTS value for the child. */
  allowedRoots?: string;
  /** PATH override (tests). Defaults to the parent PATH or a known fallback. */
  pathValue?: string;
  /** Fixed, non-secret switches for the agent CLI (e.g. DISABLE_PROMPT_CACHING). */
  extra?: Record<string, string>;
}

/**
 * Minimal env for the agent CLI child (opencode or claude). Built from scratch — it never
 * spreads `process.env`, so GITHUB_TOKEN and unrelated keys cannot leak in.
 */
export function agentSpawnEnv(opts: AgentEnvOpts): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: opts.pathValue ?? process.env.PATH ?? DEFAULT_PATH,
    HOME: opts.fakeHome,
    TMPDIR: opts.tmpdir ?? os.tmpdir(),
  };
  if (opts.allowedRoots) env.CODE_CONTEXT_ALLOWED_ROOTS = opts.allowedRoots;
  for (const [k, v] of Object.entries(opts.extra ?? {})) env[k] = v;
  env[opts.keyExportName] = opts.key;
  return env;
}

export interface CheckerEnvOpts {
  /** Isolated HOME (fresh temp dir) for the vitest child. */
  fakeHome: string;
  /** TMPDIR for the child; defaults to the OS temp dir. */
  tmpdir?: string;
  /** PATH override (tests). Defaults to the parent PATH or a known fallback. */
  pathValue?: string;
}

/**
 * Scrubbed env for the vitest checker child. The code under test was written
 * by the model and is untrusted; it must not see provider keys or the CI token.
 */
export function checkerSpawnEnv(opts: CheckerEnvOpts): NodeJS.ProcessEnv {
  return {
    PATH: opts.pathValue ?? process.env.PATH ?? DEFAULT_PATH,
    HOME: opts.fakeHome,
    TMPDIR: opts.tmpdir ?? os.tmpdir(),
    CI: '1',
    NODE_ENV: 'test',
  };
}

/**
 * Delete every provider key name from the parent process.env. Called after the
 * runner has copied the one key it needs into its own local variable.
 */
export function stripProviderKeys(): void {
  for (const name of PROVIDER_KEY_ENV_NAMES) delete process.env[name];
}
