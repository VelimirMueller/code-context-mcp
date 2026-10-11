/**
 * Per-workspace OpenCode project config (PLAN.md task 8).
 *
 * The config shape is pinned from one verified live capture per provider
 * (opencode 1.18.30): a project-level `opencode.json` with an `mcp` block
 * (`{"mcp":{"code-context":{"type":"local","command":[…]}}}`) attaches the
 * server; a `provider` block defines the DeepSeek provider because this
 * opencode build's catalog has none (verified: `-m deepseek/deepseek-v4-pro`
 * fails without it, works with it, authenticating via DEEPSEEK_API_KEY).
 *
 * The `permission` block is the agent sandbox (security review follow-up).
 * Schema verified against opencode 1.18.30 (`$schema` https://opencode.ai/
 * config.json, `$defs.PermissionConfig`): `bash`/`read`/`edit`/`grep`/`glob`/
 * `list`/`external_directory`/`task`/`skill`/`lsp` are rule configs (a scalar
 * `"allow"|"ask"|"deny"` or a pattern→action map); `webfetch`/`websearch`/
 * `todowrite`/`question`/`doom_loop` are plain `"allow"|"ask"|"deny"`. The
 * rules below leave nothing on `"ask"`, so a headless `opencode run` never
 * blocks on a permission prompt.
 */
import fs from 'node:fs';
import path from 'node:path';
import { CODE_CONTEXT_SERVER_ALIAS } from './parse-events.mts';

/**
 * Agent sandbox permissions for the live bench. The agent NEVER executes
 * code and NEVER runs a shell: `bash` is the scalar `"deny"` — no command
 * allowlist at all. (Security audit 2026-10-10: opencode applies
 * `external_directory` only to a hardcoded FILES command set, so an
 * argument-wildcard allowlist of `grep`/`rg`/`head`/`tail`/`wc`/`ls`/
 * `find`/`git` could read `/proc/self/environ` and the real `$HOME` —
 * e.g. `grep -a . /proc/self/environ` — and no pattern deny closes every
 * argument form. The agent works through the built-in read/grep/glob/list
 * tools instead, which DO enforce `external_directory`.) The `write` tool
 * stays unlisted, so it defaults to "ask" and is auto-refused headlessly.
 * Task correctness is decided by the checker alone (checkers.mts), which
 * runs the hidden vitest file in its own scrubbed environment.
 *
 * `edit` is a pattern map (same glob semantics as bash patterns:
 * full-string, `*` crosses `/`, last-match-wins in key order) with ONE
 * carve-out: the sandbox config itself must not be editable by the
 * sandboxed agent — otherwise the agent could rewrite its own permissions
 * (e.g. flip `bash` to allow) if opencode reloads the project config.
 * `*opencode.json` is matched after the blanket allow, so it wins for the
 * config file at the workspace root (relative or absolute path form) and
 * nothing else.
 *
 * `webfetch`/`websearch` are denied (no network); `external_directory` denies
 * every path outside the workspace; `task` (sub-agent spawn), `question`
 * (user prompt), `skill` and `lsp` (spawns language servers) are denied.
 */
export const SANDBOX_PERMISSIONS: Record<string, unknown> = {
  read: 'allow',
  edit: {
    '*': 'allow',
    '*opencode.json': 'deny',
  },
  grep: 'allow',
  glob: 'allow',
  list: 'allow',
  bash: 'deny',
  external_directory: { '*': 'deny' },
  webfetch: 'deny',
  websearch: 'deny',
  task: 'deny',
  question: 'deny',
  skill: 'deny',
  lsp: 'deny',
  todowrite: 'allow',
};

/** Verified custom-provider block for DeepSeek ({env:…} is opencode interpolation). */
export const DEEPSEEK_PROVIDER_CONFIG: Record<string, unknown> = {
  npm: '@ai-sdk/openai-compatible',
  name: 'DeepSeek',
  options: {
    baseURL: 'https://api.deepseek.com/v1',
    apiKey: '{env:DEEPSEEK_API_KEY}',
  },
  models: {
    'deepseek-v4-pro': { name: 'DeepSeek V4 Pro' },
  },
};

/**
 * The bench agent prompt, identical for every arm and provider except the
 * first line. Fresh-session rule (2026-10-11): GLM and DeepSeek cache prompt
 * prefixes on the provider side and offer no off switch, so two sessions with
 * the default opencode prompt share a cached prefix from their FIRST call
 * (measured: DeepSeek 1,920 cached tokens on a brand-new session). A unique
 * nonce as the very first line of the system prompt breaks that prefix
 * (measured: DeepSeek 0). `agent.build.prompt` replaces opencode's default
 * provider prompt, so the nonce really is first.
 */
export function benchAgentPrompt(nonce: string, guidance?: string): string {
  return [
    `bench-session ${nonce}`,
    'You are a software engineering agent working in the current directory.',
    'Use the available tools to inspect and edit files in this directory.',
    'Do the task in the user message, then answer briefly and precisely.',
    ...(guidance ? [guidance] : []),
  ].join('\n');
}

/**
 * The cc-guided arm's instruction — the same rule the owner's rig gives every
 * Claude session (global CLAUDE.md: code-context lookups come before any Read).
 * Identical text for opencode (system prompt) and Claude Code
 * (--append-system-prompt).
 */
export const CC_GUIDANCE =
  'A code-context MCP server has indexed this project. Before you read or search files, use its tools: ' +
  'search_files, find_symbol and get_file_context (repo-relative paths work). ' +
  'Fall back to read, grep and glob only for what they do not answer.';

export interface WriteOpencodeConfigOpts {
  /** Register code-context as the only MCP server, running `command`. */
  mcp?: { command: string[] };
  /** Include the pinned DeepSeek provider block (needed for -m deepseek/…). */
  includeDeepseekProvider?: boolean;
  /** Per-session nonce; the default `build` agent gets benchAgentPrompt(nonce). */
  nonce?: string;
  /** Extra system-prompt line (the cc-guided arm). */
  guidance?: string;
}

/**
 * Write `<workspaceDir>/opencode.json` and return its path. The bench runner
 * isolates HOME per session, so this project config is the ONLY config the
 * opencode process sees — the vanilla arm stays free of MCP servers.
 */
export function writeOpencodeConfig(
  workspaceDir: string,
  opts: WriteOpencodeConfigOpts = {},
): string {
  const config: Record<string, unknown> = {
    permission: SANDBOX_PERMISSIONS,
  };
  if (opts.nonce) {
    config.agent = { build: { prompt: benchAgentPrompt(opts.nonce, opts.guidance) } };
  }
  if (opts.includeDeepseekProvider) {
    config.provider = { deepseek: DEEPSEEK_PROVIDER_CONFIG };
  }
  if (opts.mcp) {
    config.mcp = {
      [CODE_CONTEXT_SERVER_ALIAS]: {
        type: 'local',
        command: opts.mcp.command,
        // Code tools only (CODE_CONTEXT_TOOLSETS=code): 4 tools, ~0.5k instead of ~12.3k tokens of definitions.
        environment: { CODE_CONTEXT_TOOLSETS: 'code' },
      },
    };
  }
  const configPath = path.join(workspaceDir, 'opencode.json');
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  return configPath;
}
