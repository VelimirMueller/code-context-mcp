import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const WORKFLOWS = resolve(__dirname, '../.github/workflows');
const LIVE_DIR = resolve(__dirname, '../scripts/bench/live');

const workflowFiles = (): string[] => readdirSync(WORKFLOWS).filter((f) => f.endsWith('.yml'));

// The one pre-existing non-benchmark workflow that legitimately runs on a daily
// schedule. sync-skills.yml re-vendors skill files (scripts/sync-skills.mjs +
// scripts/compile-skills.mjs); it never invokes a model, benchmark data, or the
// benchmark scripts, so it sits outside the "benchmarks on demand" rule.
// PLAN.md task 1 said "every .github/workflows/*.yml", which would also flag
// sync-skills.yml; that schedule is the owner's existing behaviour and removing
// it is out of scope for tasks 1-5 (see PR notes).
const NON_BENCHMARK_SCHEDULED = new Set(['sync-skills.yml']);

/**
 * Extract the block of lines under the top-level `on:` key. Returns the joined
 * lines (without the `on:` line itself) or null when there is no `on:` key.
 */
function onBlock(content: string): string | null {
  const lines = content.split('\n');
  const idx = lines.findIndex((l) => /^on\s*:/.test(l));
  if (idx === -1) return null;
  const baseIndent = (lines[idx].match(/^\s*/) ?? [''])[0].length;
  const body: string[] = [];
  for (let i = idx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '') continue;
    const indent = (line.match(/^\s*/) ?? [''])[0].length;
    if (indent <= baseIndent) break;
    body.push(line);
  }
  return body.join('\n');
}

describe('bench guard — benchmarks run on demand only, never on a schedule', () => {
  it('no workflow contains schedule: or cron: (block or flow style)', () => {
    for (const f of workflowFiles()) {
      if (NON_BENCHMARK_SCHEDULED.has(f)) continue;
      const content = readFileSync(join(WORKFLOWS, f), 'utf-8');
      // Not anchored to line starts: also catches flow style (`on: [push,
      // schedule]`) and inline mappings (`triggers: { schedule: … }`).
      expect(content, `${f} must not contain a schedule trigger`).not.toMatch(/(^|\s)schedule\s*:/);
      expect(content, `${f} must not contain a cron expression`).not.toMatch(/\bcron\s*:/);
    }
  });

  it('benchmark.yml (when present) is workflow_dispatch-only', () => {
    const file = join(WORKFLOWS, 'benchmark.yml');
    if (!existsSync(file)) return; // task 9 adds it; tolerated until then
    const content = readFileSync(file, 'utf-8');
    const block = onBlock(content);
    expect(block, 'benchmark.yml must declare an on: block').not.toBeNull();
    expect(block).toContain('workflow_dispatch');
    const forbidden = [
      'push:',
      'pull_request:',
      'schedule:',
      'workflow_call:',
      'workflow_run:',
      'repository_dispatch:',
    ];
    for (const key of forbidden) {
      expect(block, `benchmark.yml must not trigger on ${key}`).not.toContain(key);
    }
  });
});

describe('bench guard — every agent arm spawns through the sandbox prepare path', () => {
  // Security audit 2026-10-10, finding 2: an arm used to spawn without any
  // opencode.json. The structural invariant: run.mts spawns opencode exactly
  // once, consumes a PreparedArm, and never writes (or bypasses) the config
  // itself — the ONLY config writer for agent sessions is prepare.mts.
  const runSrc = () => readFileSync(join(LIVE_DIR, 'run.mts'), 'utf-8');
  const prepareSrc = () => readFileSync(join(LIVE_DIR, 'prepare.mts'), 'utf-8');

  it('run.mts has exactly ONE agent spawn site and it runs the command prepare.mts built', () => {
    const src = runSrc();
    // CCA-15: the child is owned by session.mts runAgentProcess (process
    // group, wall-clock deadline, tree kill); run.mts spawns nothing itself.
    expect([...src.matchAll(/\bspawn\(/g)].length, 'run.mts must not call spawn() itself').toBe(0);
    expect(
      [...src.matchAll(/\brunAgentProcess\(/g)].length,
      'run.mts must start the agent exactly once',
    ).toBe(1);
    expect(src).toContain('bin: opts.prep.command.bin,');
    expect(src).toContain('[...opts.prep.command.args,');
    // session.mts: one spawn of the given command, one of caffeinate.
    const session = readFileSync(join(LIVE_DIR, 'session.mts'), 'utf-8');
    expect([...session.matchAll(/\bspawn\(/g)].length).toBe(2);
    expect(session).toContain('spawn(opts.bin, opts.args,');
    expect(session).toContain("spawn('caffeinate',");
  });

  it('run.mts never writes or references the agent config itself — only prepare.mts may', () => {
    const src = runSrc();
    expect(src).not.toContain('writeOpencodeConfig');
    expect(src).toContain('prepareArmSession');
    expect(src).toContain('ARMS');

    const prep = prepareSrc();
    expect(prep).toContain('writeOpencodeConfig');
    // unconditional write: the call sits at top level of prepareArmSession,
    // not inside an if-branch (guarded behaviourally by the prepare tests).
    expect(prep).toMatch(/const configPath = writeOpencodeConfig\(ws, configOpts\);/);
  });

  it('prepare.mts is the only bench module that writes opencode.json', () => {
    for (const f of readdirSync(LIVE_DIR).filter((x) => x.endsWith('.mts'))) {
      const src = readFileSync(join(LIVE_DIR, f), 'utf-8');
      if (f === 'prepare.mts' || f === 'opencode-config.mts') continue;
      expect(src, `${f} must not write agent config`).not.toContain('writeOpencodeConfig');
    }
  });

  it('the checker pins a trusted vitest config outside the workspace', () => {
    const src = readFileSync(join(LIVE_DIR, 'checkers.mts'), 'utf-8');
    expect(src).toContain("'--config'");
    expect(src).toContain("'--root'");
    expect(src).toContain('vitest.trusted.config.mts');
    // the trusted config exists in the repo (harness-owned), denies workspace
    // config hooks, and lives outside any bench workspace by construction.
    expect(existsSync(join(LIVE_DIR, 'checks', 'vitest.trusted.config.mts'))).toBe(true);
  });
});

describe('bench guard — fresh sessions (2026-10-11)', () => {
  it('run.mts aborts the run when a strict provider session reads cache on its first call', () => {
    const src = readFileSync(join(LIVE_DIR, 'run.mts'), 'utf-8');
    expect(src).toContain('providerMeta.strictCache && firstRead > 0');
    // glm (provider-side tool cache, no off switch) and opus (CCA-10: caching
    // on in cold sessions; Claude Code's static prefix may be read) are exempt.
    expect(src.match(/strictCache: false/g)?.length).toBe(2);
    expect(src).toMatch(/opus: \{[^}]*strictCache: false/);
    expect(src).toMatch(/deepseek: \{[^}]*strictCache: true/);
  });

  it('no bench module sets DISABLE_PROMPT_CACHING (CCA-10)', () => {
    for (const f of readdirSync(LIVE_DIR).filter((x) => x.endsWith('.mts'))) {
      const src = readFileSync(join(LIVE_DIR, f), 'utf-8');
      expect(src, f).not.toMatch(/DISABLE_PROMPT_CACHING['"]?\s*:/);
    }
  });
});

describe('bench guard — provider errors void the run (2026-10-11)', () => {
  it('run.mts aborts on a provider error or a session with 0 model calls', () => {
    const src = readFileSync(join(LIVE_DIR, 'run.mts'), 'utf-8');
    expect(src).toContain('outcome.providerError || outcome.modelCalls === 0');
    // CCA-15: the rule lives in attemptFault; one retry, then the run is void.
    expect(src).toContain('const fault = attemptFault({');
    expect(src).toContain('No run file written.');
    const session = readFileSync(join(LIVE_DIR, 'session.mts'), 'utf-8');
    expect(session).toContain('if (a.providerError) return');
    expect(session).toContain('if (a.modelCalls === 0)');
  });
});
