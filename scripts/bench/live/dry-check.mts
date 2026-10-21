/**
 * Free dry check of the index-shaped tasks (CCA-09, #124): proves the
 * code-context server CAN answer each I-task, without any model session.
 *
 * For every I-task: prepare a real cc-arm workspace with prepareArmSession
 * (fresh large-fixture copy + fresh index, exactly as bench:live does),
 * start dist/server/index.js over stdio in it, call the graph tools a
 * diligent agent would call (who_imports, exports_in, find_symbol), turn
 * their output into an answer, and compare it with the pinned answer key
 * (computed independently by the TypeScript compiler API). The rendered
 * answer also goes through the task's real checker.
 *
 *   pnpm run build && pnpm exec tsx scripts/bench/live/dry-check.mts [--verbose]
 *
 * No provider key, no network, no agent CLI. Exit 1 when any task disagrees.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { runChecker } from './checkers.mts';
import { prepareArmSession } from './prepare.mts';
import { INDEX_TASKS, tasksByIds, type LiveTask } from './tasks.mts';
import { readAnswerKey } from './large-fixture/answer-key.mts';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const DIST_SERVER = path.join(repoRoot, 'dist', 'server', 'index.js');
const verbose = process.argv.includes('--verbose');

type Call = (tool: string, args: Record<string, unknown>) => Promise<string>;

/** `- path …` entries of a who_imports reply: the direct section, and the via-re-export section. */
export function parseWhoImports(text: string): {
  direct: Array<{ path: string; reexport: boolean }>;
  via: string[];
} {
  const direct: Array<{ path: string; reexport: boolean }> = [];
  const via: string[] = [];
  let inVia = false;
  for (const line of text.split('\n')) {
    if (line.startsWith('## Via re-export')) inVia = true;
    const m = /^- (\S+)/.exec(line);
    if (!m) continue;
    if (inVia) via.push(m[1]);
    else direct.push({ path: m[1], reexport: line.endsWith('(re-export)') });
  }
  return { direct, via };
}

/** Names listed by exports_in: `- L12 export function name(…)` or `- name (kind)`. */
export function parseExportsIn(text: string): Array<{ file: string; name: string }> {
  const out: Array<{ file: string; name: string }> = [];
  let file = '';
  for (const line of text.split('\n')) {
    const h = /^## (\S+)/.exec(line);
    if (h) {
      file = h[1];
      continue;
    }
    if (!line.startsWith('- ')) continue;
    const sig = line.replace(/^- (?:L\d+ )?/, '');
    const m =
      /\b(?:function\*?|const|let|var|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/.exec(sig) ??
      /^([A-Za-z_$][\w$]*)/.exec(sig);
    if (m) out.push({ file, name: m[1] });
  }
  return out;
}

/** How a diligent agent answers each task with the graph tools. */
const STRATEGIES: Record<string, (call: Call) => Promise<{ answer: string[]; calls: string[] }>> = {
  async I1(call) {
    const t = await call('who_imports', { target: 'src/platform/http/retry.ts' });
    return {
      answer: parseWhoImports(t).direct.map((d) => d.path),
      calls: ['who_imports(retry.ts)'],
    };
  },
  async I2(call) {
    const t = await call('who_imports', { target: 'src/orders/model/order-line.ts' });
    return {
      answer: parseWhoImports(t).direct.map((d) => d.path),
      calls: ['who_imports(order-line.ts)'],
    };
  },
  async I3(call) {
    const t = await call('who_imports', { target: 'formatMoney' });
    const r = parseWhoImports(t);
    return {
      answer: [...r.direct.filter((d) => !d.reexport).map((d) => d.path), ...r.via],
      calls: ['who_imports(formatMoney)'],
    };
  },
  async I4(call) {
    const t = await call('exports_in', { dir: 'src/catalog/utils', unused: true });
    return {
      answer: parseExportsIn(t).map((e) => `${e.file}: ${e.name}`),
      calls: ['exports_in(src/catalog/utils, unused)'],
    };
  },
  async I5(call) {
    const t = await call('find_symbol', { name: 'resolveTaxRate' });
    const defs = [...t.matchAll(/^resolveTaxRate \(([\w-]+)\) — (\S+)/gm)].filter(
      (m) => m[1] !== 're-export',
    );
    return { answer: defs.map((m) => m[2]), calls: ['find_symbol(resolveTaxRate)'] };
  },
  async I6(call) {
    const X = 'src/loyalty/utils/points-math.ts';
    const hop1 = parseWhoImports(await call('who_imports', { target: X })).direct.map(
      (d) => d.path,
    );
    const all = new Set(hop1);
    for (const f of hop1) {
      for (const d of parseWhoImports(await call('who_imports', { target: f })).direct)
        all.add(d.path);
    }
    all.delete(X);
    return { answer: [...all], calls: [`who_imports × ${hop1.length + 1}`] };
  },
};

function expectedFor(task: LiveTask): string[] {
  const key = readAnswerKey().answers;
  const c = task.checker;
  if (c.type === 'pinned-paths') return key[c.key];
  if (c.type === 'pinned-exports') return key[c.key].map((e) => `${e.file}: ${e.name}`);
  throw new Error(`dry-check: ${task.id} is not a large-fixture task`);
}

async function main(): Promise<void> {
  if (!fs.existsSync(DIST_SERVER)) {
    console.error('dist/server/index.js is missing — run `pnpm run build` first.');
    process.exit(1);
  }
  // Same allowance bench:live sets: the indexer only indexes allowed roots.
  process.env.CODE_CONTEXT_ALLOWED_ROOTS = [
    os.tmpdir(),
    ...(process.env.CODE_CONTEXT_ALLOWED_ROOTS?.split(',') ?? []),
  ]
    .filter(Boolean)
    .join(',');
  let failed = 0;
  for (const task of tasksByIds(INDEX_TASKS.split(','))) {
    const prep = prepareArmSession({
      provider: 'glm',
      arm: 'cc',
      model: 'dry-check',
      fixture: task.fixture,
      distServer: DIST_SERVER,
      keyExportName: 'DRY_CHECK_UNUSED_KEY',
      key: 'none',
      allowedRoots: process.env.CODE_CONTEXT_ALLOWED_ROOTS,
    });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [DIST_SERVER, path.join(prep.ws, 'context.db')],
      cwd: prep.ws,
      env: { ...(prep.env as Record<string, string>), CODE_CONTEXT_TOOLSETS: 'code' },
      stderr: 'ignore',
    });
    const client = new Client({ name: 'bench-dry-check', version: '1.0.0' });
    try {
      await client.connect(transport);
      const outputs: string[] = [];
      const call: Call = async (name, args) => {
        const r = (await client.callTool({ name, arguments: args })) as {
          content: Array<{ type: string; text?: string }>;
        };
        const text = r.content.map((c) => c.text ?? '').join('\n');
        outputs.push(`$ ${name} ${JSON.stringify(args)}\n${text}`);
        return text;
      };
      const strategy = STRATEGIES[task.id];
      const { answer, calls } = await strategy(call);
      const expected = expectedFor(task);
      const got = [...new Set(answer)].sort();
      const want = [...expected].sort();
      const missing = want.filter((x) => !got.includes(x));
      const extra = got.filter((x) => !want.includes(x));
      const check = await runChecker(task, prep.ws, got.join('\n'));
      const ok = missing.length === 0 && extra.length === 0 && check.pass;
      if (!ok) failed++;
      const chars = outputs.reduce((n, o) => n + o.length, 0);
      console.log(
        `${ok ? 'PASS' : 'FAIL'} ${task.id}: ${got.length}/${want.length} via ${calls.join(', ')} ` +
          `(${chars} chars of tool output; index ${prep.indexInfo?.indexMs ?? '?'} ms) — checker: ${check.detail}` +
          (missing.length ? `\n  missing: ${missing.join(', ')}` : '') +
          (extra.length ? `\n  extra: ${extra.join(', ')}` : ''),
      );
      if (verbose || !ok) console.log(outputs.join('\n\n').replace(/^/gm, '    '));
    } finally {
      await client.close().catch(() => undefined);
      prep.cleanup();
    }
  }
  console.log(
    failed
      ? `${failed} task(s) disagree with the pinned answers`
      : 'all index-shaped tasks answerable from the tools',
  );
  process.exit(failed ? 1 : 0);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) await main();
