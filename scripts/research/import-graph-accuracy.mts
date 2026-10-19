/**
 * Import-graph accuracy against the TypeScript compiler (CCA-38, #182).
 *
 * Usage: tsx scripts/research/import-graph-accuracy.mts <repo-root> [...] [--sample 50] [--seed 182] [--json out.json]
 *
 * For each repo root:
 *  1. Index it with the real indexer into a throwaway sqlite db (in a temp dir,
 *     never the shared context.db). The repo is only read.
 *  2. Ground truth: every JS/TS file the indexer kept is parsed with
 *     ts.createSourceFile; each module reference (import, export … from,
 *     import(), require(), import x = require(), import("x") types) is resolved
 *     with ts.resolveModuleName under the governing tsconfig/jsconfig (nearest
 *     config, its project references, then default bundler options).
 *  3. Scores the indexed edges (file → imported file) against the truth, lists
 *     every false positive / negative by category, then samples files and
 *     scores the who_imports answer (direct importers) and the exports
 *     exports_in lists (TypeChecker.getExportsOfModule) for them.
 *
 * Scope: source files with a JS/TS extension; targets with a JS/TS or .json
 * extension. Asset edges (css, svg, …) are counted but not scored — the
 * compiler cannot resolve them.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';
import ts from 'typescript';
import { initSchema } from '../../src/server/schema.js';
import { indexDirectory, parseImports, resolveImportPath } from '../../src/server/indexer.js';
import { AliasResolver } from '../../src/server/tsconfig-paths.js';
import { whoImports } from '../../src/server/graph.js';

const JS_TS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts']);
const UNPARSED = new Set(['.mts', '.cts']);
const CONFIG_NAMES = ['tsconfig.json', 'jsconfig.json'];

export type ImportKind =
  | 'static'
  | 'side-effect'
  | 'type-only'
  | 're-export'
  | 'dynamic'
  | 'require';

export interface TruthRef {
  spec: string;
  kind: ImportKind;
  /** Resolved file (realpath), null when the compiler resolves nothing. */
  target: string | null;
  /** True when the compiler went through node_modules (a workspace symlink when target is in the repo). */
  viaNodeModules: boolean;
}

export interface Metric {
  tp: number;
  fp: number;
  fn: number;
  precision: number;
  recall: number;
}

export interface EdgeIssue {
  source: string;
  target: string;
  spec: string;
  category: string;
}

export interface RepoReport {
  root: string;
  files: number;
  jsTsFiles: number;
  indexMs: number;
  truthMs: number;
  truthHeapMb: number;
  edges: Metric;
  /** Edges with the bundler-only and Vite-alias-only ones counted as correct. */
  edgesAdjusted: Metric;
  edgesByCategory: { fp: Record<string, number>; fn: Record<string, number> };
  falsePositives: EdgeIssue[];
  falseNegatives: EdgeIssue[];
  aliasEdges: Metric;
  assetEdgesSkipped: number;
  whoImports: Metric & { files: number; exact: number };
  exportsIn: Metric & {
    files: number;
    exact: number;
    fpByCategory: Record<string, number>;
    fnByCategory: Record<string, number>;
    misses: { file: string; name: string; category: string }[];
    extras: { file: string; name: string; category: string }[];
  };
  viteAliases: { configs: number; keys: string[]; specifiers: number; notInTsconfig: number };
}

const metric = (tp: number, fp: number, fn: number): Metric => ({
  tp,
  fp,
  fn,
  precision: tp + fp === 0 ? 1 : tp / (tp + fp),
  recall: tp + fn === 0 ? 1 : tp / (tp + fn),
});

const bump = (m: Record<string, number>, k: string): void => {
  m[k] = (m[k] ?? 0) + 1;
};

const realpath = (p: string): string => {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
};

const isInside = (child: string, parent: string): boolean => {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

/** Extension used for scoping: `.d.ts` counts as `.ts`. */
const extOf = (p: string): string => path.extname(p).toLowerCase();

/** Deterministic PRNG (mulberry32) so a sample is reproducible. */
export function sampleOf<T>(items: T[], n: number, seed: number): T[] {
  let a = seed >>> 0;
  const rand = (): number => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, n);
}

// ─── Governing compiler options ──────────────────────────────────────────────

const DEFAULT_OPTIONS: ts.CompilerOptions = {
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  jsx: ts.JsxEmit.Preserve,
};

interface Governing {
  key: string;
  options: ts.CompilerOptions;
  cache: ts.ModuleResolutionCache;
}

const parseHost: ts.ParseConfigFileHost = {
  ...ts.sys,
  onUnRecoverableConfigFileDiagnostic: () => {},
};

export class ConfigIndex {
  private readonly parsed = new Map<
    string,
    { cmd: ts.ParsedCommandLine; files: Set<string> } | null
  >();
  private readonly governing = new Map<string, Governing>();

  constructor(readonly root: string) {}

  private parse(file: string): { cmd: ts.ParsedCommandLine; files: Set<string> } | null {
    if (this.parsed.has(file)) return this.parsed.get(file)!;
    let out: { cmd: ts.ParsedCommandLine; files: Set<string> } | null = null;
    try {
      const cmd = ts.getParsedCommandLineOfConfigFile(file, {}, parseHost);
      if (cmd) out = { cmd, files: new Set(cmd.fileNames.map((f) => realpath(path.resolve(f)))) };
    } catch {
      out = null;
    }
    this.parsed.set(file, out);
    return out;
  }

  /** Config files from `dir` up to the root, nearest first. */
  private configsAbove(dir: string): string[] {
    const out: string[] = [];
    let d = dir;
    while (isInside(d, this.root)) {
      for (const name of CONFIG_NAMES) {
        const f = path.join(d, name);
        if (fs.existsSync(f)) {
          out.push(f);
          break;
        }
      }
      if (d === this.root) break;
      d = path.dirname(d);
    }
    return out;
  }

  /** A config (or a project it references, depth-first) whose file list holds `file`. */
  private covering(cfgFile: string, file: string, seen: Set<string>): string | null {
    if (seen.has(cfgFile)) return null;
    seen.add(cfgFile);
    const p = this.parse(cfgFile);
    if (!p) return null;
    if (p.files.has(file)) return cfgFile;
    for (const ref of p.cmd.projectReferences ?? []) {
      const refFile = ref.path.endsWith('.json') ? ref.path : path.join(ref.path, 'tsconfig.json');
      const hit = this.covering(path.resolve(refFile), file, seen);
      if (hit) return hit;
    }
    return null;
  }

  /**
   * Compiler options for `file`: the nearest config (or a project it references)
   * whose file list holds it; a file no config includes gets bundler defaults,
   * as the editor's inferred project would (test/ under a `"include": ["src"]`).
   */
  for(file: string): Governing {
    const chain = this.configsAbove(path.dirname(file));
    let chosen: string | null = null;
    for (const c of chain) {
      chosen = this.covering(c, file, new Set());
      if (chosen) break;
    }
    const key = chosen ?? '<default>';
    let g = this.governing.get(key);
    if (!g) {
      const base = chosen ? this.parse(chosen)!.cmd.options : DEFAULT_OPTIONS;
      const options: ts.CompilerOptions = {
        ...base,
        allowJs: true,
        resolveJsonModule: true,
        noEmit: true,
      };
      g = { key, options, cache: ts.createModuleResolutionCache(this.root, (x) => x, options) };
      this.governing.set(key, g);
    }
    return g;
  }
}

// ─── Ground truth: module references per file ───────────────────────────────

function scriptKind(file: string): ts.ScriptKind {
  const e = extOf(file);
  if (e === '.tsx') return ts.ScriptKind.TSX;
  if (e === '.jsx') return ts.ScriptKind.JSX;
  if (e === '.js' || e === '.mjs' || e === '.cjs') return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

const literalText = (n: ts.Node | undefined): string | null =>
  n && (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) ? n.text : null;

/** Module references in one file, as the compiler reads them, with their resolution. */
export function truthRefs(file: string, content: string, configs: ConfigIndex): TruthRef[] {
  const gov = configs.for(file);
  const impliedNodeFormat = ts.getImpliedNodeFormatForFile(
    file as ts.Path,
    gov.cache.getPackageJsonInfoCache(),
    ts.sys,
    gov.options,
  );
  const sf = ts.createSourceFile(
    file,
    content,
    { languageVersion: ts.ScriptTarget.ESNext, impliedNodeFormat },
    true,
    scriptKind(file),
  );
  const found: {
    spec: string;
    kind: ImportKind;
    node: ts.StringLiteralLike;
    mode?: ts.ResolutionMode;
  }[] = [];
  const add = (node: ts.Node | undefined, kind: ImportKind, mode?: ts.ResolutionMode): void => {
    const spec = literalText(node);
    if (spec !== null) found.push({ spec, kind, node: node as ts.StringLiteralLike, mode });
  };
  const visit = (n: ts.Node): void => {
    if (ts.isImportDeclaration(n)) {
      const c = n.importClause;
      let kind: ImportKind = 'static';
      if (!c) kind = 'side-effect';
      else if (
        c.isTypeOnly ||
        (!c.name &&
          c.namedBindings &&
          ts.isNamedImports(c.namedBindings) &&
          c.namedBindings.elements.length > 0 &&
          c.namedBindings.elements.every((e) => e.isTypeOnly))
      )
        kind = 'type-only';
      add(n.moduleSpecifier, kind);
    } else if (ts.isExportDeclaration(n) && n.moduleSpecifier) {
      add(n.moduleSpecifier, n.isTypeOnly ? 'type-only' : 're-export');
    } else if (ts.isImportEqualsDeclaration(n) && ts.isExternalModuleReference(n.moduleReference)) {
      add(
        n.moduleReference.expression,
        n.isTypeOnly ? 'type-only' : 'require',
        ts.ModuleKind.CommonJS,
      );
    } else if (ts.isCallExpression(n) && n.arguments.length >= 1) {
      if (n.expression.kind === ts.SyntaxKind.ImportKeyword)
        add(n.arguments[0], 'dynamic', ts.ModuleKind.ESNext);
      else if (ts.isIdentifier(n.expression) && n.expression.text === 'require')
        add(n.arguments[0], 'require', ts.ModuleKind.CommonJS);
    } else if (ts.isImportTypeNode(n) && ts.isLiteralTypeNode(n.argument)) {
      add(n.argument.literal, 'type-only');
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);

  return found.map(({ spec, kind, node, mode }) => {
    const m = mode ?? ts.getModeForUsageLocation(sf, node, gov.options);
    const r = ts.resolveModuleName(spec, file, gov.options, ts.sys, gov.cache, undefined, m);
    const rm = r.resolvedModule;
    const target = rm ? realpath(rm.resolvedFileName) : null;
    const viaNodeModules =
      !!rm &&
      (rm.isExternalLibraryImport === true ||
        (rm.originalPath ?? rm.resolvedFileName).split(path.sep).includes('node_modules'));
    return { spec, kind, target, viaNodeModules };
  });
}

// ─── Indexer side ────────────────────────────────────────────────────────────

/** Index `root` into a fresh db in a temp dir; returns the db and the wall time. */
export function indexIntoTemp(root: string): { db: Database.Database; dir: string; ms: number } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-accuracy-'));
  const db = new Database(path.join(dir, 'index.db'));
  initSchema(db);
  const saved = process.env.CODE_CONTEXT_ALLOWED_ROOTS;
  process.env.CODE_CONTEXT_ALLOWED_ROOTS = root;
  const t0 = performance.now();
  try {
    indexDirectory(db, root);
  } finally {
    if (saved === undefined) delete process.env.CODE_CONTEXT_ALLOWED_ROOTS;
    else process.env.CODE_CONTEXT_ALLOWED_ROOTS = saved;
  }
  return { db, dir, ms: performance.now() - t0 };
}

/** `content` with comments, strings and template text blanked (offsets kept). */
export function codeOnly(content: string): string {
  const scanner = ts.createScanner(
    ts.ScriptTarget.ESNext,
    false,
    ts.LanguageVariant.Standard,
    content,
  );
  const out = content.split('');
  const blank = (from: number, to: number): void => {
    for (let i = from; i < to; i++) if (out[i] !== '\n') out[i] = ' ';
  };
  const stack: ('{' | '`')[] = []; // open braces and template substitutions
  for (let k = scanner.scan(); k !== ts.SyntaxKind.EndOfFileToken; k = scanner.scan()) {
    if (k === ts.SyntaxKind.CloseBraceToken && stack.pop() === '`') {
      k = scanner.reScanTemplateToken(false);
      if (k === ts.SyntaxKind.TemplateMiddle) stack.push('`');
      blank(scanner.getTokenStart(), scanner.getTokenEnd());
      continue;
    }
    if (k === ts.SyntaxKind.OpenBraceToken) stack.push('{');
    else if (k === ts.SyntaxKind.TemplateHead) {
      stack.push('`');
      blank(scanner.getTokenStart(), scanner.getTokenEnd());
    } else if (
      k === ts.SyntaxKind.SingleLineCommentTrivia ||
      k === ts.SyntaxKind.MultiLineCommentTrivia ||
      k === ts.SyntaxKind.StringLiteral ||
      k === ts.SyntaxKind.NoSubstitutionTemplateLiteral
    ) {
      blank(scanner.getTokenStart(), scanner.getTokenEnd());
    }
  }
  return out.join('');
}

const isRelative = (s: string): boolean => s.startsWith('.') || s.startsWith('/');

function categorizeMissed(
  ref: TruthRef,
  source: string,
  content: string,
  root: string,
  aliases: AliasResolver,
): string {
  if (UNPARSED.has(extOf(source))) return 'unsupported extension (.mts/.cts source)';
  if (ref.target && UNPARSED.has(extOf(ref.target)))
    return 'unsupported extension (.mts/.cts target)';
  const seen = parseImports(content).some((i) => i.source === ref.spec);
  if (!seen) {
    if (ref.kind === 'static' || ref.kind === 'side-effect') return 'parser missed static import';
    if (ref.kind === 'require') return 'parser missed require';
    return `parser missed ${ref.kind}${ref.kind === 'dynamic' ? ' import' : ''}`;
  }
  const got = resolveImportPath(ref.spec, source, root, aliases);
  if (got && ref.target && got !== ref.target) {
    return got.endsWith('.d.ts') || ref.target.endsWith('.d.ts')
      ? 'declaration vs source (.d.ts)'
      : 'resolved to a different file';
  }
  if (!isRelative(ref.spec))
    return ref.viaNodeModules ? 'node_modules (workspace package)' : 'path alias';
  if (
    ref.target &&
    /^index\.[^/]+$/.test(path.basename(ref.target)) &&
    !/index(\.[a-z]+)?$/.test(ref.spec)
  )
    return 'index file';
  if (!path.extname(ref.spec)) return 'extensionless';
  return 'unresolved relative path';
}

/**
 * Category for an indexed edge the governing config cannot resolve but bundler
 * rules can (an extensionless import in a `"type": "module"` package under
 * Node16 resolution). Test runners and bundlers load these files, so the edge
 * is real; the adjusted precision counts it as correct.
 */
export const BUNDLER_ONLY = 'resolved only under bundler rules (Node16 ESM wants an extension)';

/** Category for an edge through a Vite alias that tsconfig `paths` does not mirror. */
export const VITE_ONLY = 'vite alias only (not in tsconfig paths)';

const bundlerCaches = new Map<string, ts.ModuleResolutionCache>();

/** The file `spec` names from `file` under bundler resolution, or null. */
function bundlerResolve(spec: string, file: string, root: string): string | null {
  let cache = bundlerCaches.get(root);
  if (!cache) {
    cache = ts.createModuleResolutionCache(root, (x) => x, DEFAULT_OPTIONS);
    bundlerCaches.set(root, cache);
  }
  const r = ts.resolveModuleName(
    spec,
    file,
    { ...DEFAULT_OPTIONS, allowJs: true, resolveJsonModule: true },
    ts.sys,
    cache,
  );
  return r.resolvedModule ? realpath(r.resolvedModule.resolvedFileName) : null;
}

function categorizeExtra(
  source: string,
  target: string,
  content: string,
  root: string,
  aliases: AliasResolver,
  refs: TruthRef[],
  viteKeys: string[] = [],
): { spec: string; category: string } {
  const specs = parseImports(content)
    .map((i) => i.source)
    .filter((s) => resolveImportPath(s, source, root, aliases) === target);
  const spec = specs[0] ?? '?';
  for (const s of specs) {
    const hits = refs.filter((r) => r.spec === s);
    if (hits.length === 0) continue;
    const t = hits.find((h) => h.target)?.target ?? null;
    if (!t) {
      const bundler = bundlerResolve(s, source, root);
      if (bundler === target) return { spec: s, category: BUNDLER_ONLY };
      if (!isRelative(s) && viteKeys.some((k) => matchesAliasKey(s, k)))
        return { spec: s, category: VITE_ONLY };
      return {
        spec: s,
        category: isRelative(s)
          ? 'compiler leaves it unresolved'
          : 'alias the compiler does not resolve',
      };
    }
    if (t !== target) {
      return {
        spec: s,
        category:
          t.endsWith('.d.ts') || target.endsWith('.d.ts')
            ? 'declaration vs source (.d.ts)'
            : 'resolved to a different file',
      };
    }
  }
  return {
    spec,
    category: specs.length ? 'not an import per compiler (comment/string)' : 'unexplained',
  };
}

// ─── Vite resolve.alias (measurement only) ───────────────────────────────────

const VITE_CONFIG_RE = /^vite\.config\.(?:[cm]?[jt]s)$/;

/**
 * Static alias keys of every indexed vite.config.*, read with the compiler's
 * parser (independent of src/server/vite-alias.ts). `keysFor(file)` gives the
 * keys of the nearest config above a file, as Vite applies them.
 */
export function viteAliasKeys(
  root: string,
  files: string[],
): { configs: string[]; keys: string[]; keysFor: (file: string) => string[] } {
  const configs = files.filter((f) => VITE_CONFIG_RE.test(path.basename(f)));
  const keys = new Set<string>();
  const byDir = new Map<string, string[]>();
  for (const c of configs) {
    const own: string[] = [];
    const text = fs.readFileSync(c, 'utf-8');
    const sf = ts.createSourceFile(c, text, ts.ScriptTarget.ESNext, true);
    const visit = (n: ts.Node): void => {
      if (ts.isPropertyAssignment(n) && n.name.getText(sf) === 'alias') {
        const v = n.initializer;
        if (ts.isObjectLiteralExpression(v)) {
          for (const p of v.properties) {
            if (ts.isPropertyAssignment(p)) own.push(literalText(p.name) ?? p.name.getText(sf));
          }
        } else if (ts.isArrayLiteralExpression(v)) {
          for (const el of v.elements) {
            if (!ts.isObjectLiteralExpression(el)) continue;
            for (const p of el.properties) {
              if (ts.isPropertyAssignment(p) && p.name.getText(sf) === 'find') {
                const k = literalText(p.initializer);
                if (k) own.push(k);
              }
            }
          }
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
    own.forEach((k) => keys.add(k));
    byDir.set(path.dirname(c), own);
  }
  const keysFor = (file: string): string[] => {
    let best: string | null = null;
    for (const d of byDir.keys())
      if (isInside(file, d) && (!best || d.length > best.length)) best = d;
    return best ? byDir.get(best)! : [];
  };
  return { configs, keys: [...keys].sort(), keysFor };
}

const matchesAliasKey = (spec: string, key: string): boolean =>
  spec === key || spec.startsWith(key.endsWith('/') ? key : `${key}/`);

// ─── Exports (TypeChecker) ───────────────────────────────────────────────────

function truthExports(files: string[], configs: ConfigIndex): Map<string, Map<string, string>> {
  const groups = new Map<string, { options: ts.CompilerOptions; files: string[] }>();
  for (const f of files) {
    const g = configs.for(f);
    const e = groups.get(g.key) ?? { options: g.options, files: [] };
    e.files.push(f);
    groups.set(g.key, e);
  }
  // file → exported name → category the regex parser would need to see it
  const out = new Map<string, Map<string, string>>();
  for (const { options, files: roots } of groups.values()) {
    const program = ts.createProgram(roots, { ...options, noEmit: true, skipLibCheck: true });
    const checker = program.getTypeChecker();
    for (const f of roots) {
      const names = new Map<string, string>();
      out.set(f, names);
      const sf =
        program.getSourceFile(f) ??
        program.getSourceFiles().find((s) => realpath(s.fileName) === f);
      if (!sf) continue;
      const mod = checker.getSymbolAtLocation(sf);
      if (!mod) continue;
      for (const s of checker.getExportsOfModule(mod)) {
        let name = s.getName();
        const decl = s.declarations?.[0];
        let category = 'other';
        if (name === 'export=') continue;
        if (decl && decl.getSourceFile() !== sf) category = 'export * re-export';
        else if (decl && ts.isExportSpecifier(decl)) {
          const fromModule = !!decl.parent.parent.moduleSpecifier;
          category = fromModule ? 're-export (export {…} from)' : 'local export list';
        } else if (decl && ts.isNamespaceExport(decl))
          category = 'namespace re-export (export * as)';
        else if (decl && ts.isExportAssignment(decl)) category = 'default export expression';
        else if (decl && ts.canHaveModifiers(decl)) {
          const mods = ts.getModifiers(decl) ?? [];
          if (mods.some((m) => m.kind === ts.SyntaxKind.AbstractKeyword))
            category = 'abstract class';
          else if (mods.some((m) => m.kind === ts.SyntaxKind.DeclareKeyword))
            category = 'ambient (declare)';
          else if (ts.isModuleDeclaration(decl)) category = 'namespace';
        }
        if (decl && ts.isVariableDeclaration(decl) && !ts.isIdentifier(decl.name))
          category = 'destructured export';
        if (decl && ts.isBindingElement(decl)) category = 'destructured export';
        if (
          decl &&
          ts.isVariableDeclaration(decl) &&
          decl.parent.parent &&
          ts.isVariableStatement(decl.parent.parent)
        ) {
          const mods = ts.getModifiers(decl.parent.parent) ?? [];
          if (mods.some((m) => m.kind === ts.SyntaxKind.DeclareKeyword))
            category = 'ambient (declare)';
        }
        if (decl && ts.isFunctionDeclaration(decl) && decl.asteriskToken)
          category = 'generator function';
        if (name === 'default') {
          const named =
            decl && (ts.isFunctionDeclaration(decl) || ts.isClassDeclaration(decl)) && decl.name;
          if (named) name = named.text;
          else category = 'default export expression';
          const isAsync =
            decl &&
            ts.isFunctionDeclaration(decl) &&
            (ts.getModifiers(decl) ?? []).some((m) => m.kind === ts.SyntaxKind.AsyncKeyword);
          if (named && isAsync) category = 'async default function';
        }
        names.set(name, category);
      }
    }
  }
  return out;
}

// ─── One repo ────────────────────────────────────────────────────────────────

export interface MeasureOptions {
  sample?: number;
  seed?: number;
}

export function measureRepo(rootArg: string, opts: MeasureOptions = {}): RepoReport {
  const sampleSize = opts.sample ?? 50;
  const seed = opts.seed ?? 182;
  const root = realpath(path.resolve(rootArg));
  const { db, dir, ms: indexMs } = indexIntoTemp(root);
  try {
    const allFiles = (
      db.prepare(`SELECT path FROM files ORDER BY path`).all() as { path: string }[]
    ).map((r) => r.path);
    const indexed = new Set(allFiles);
    const jsTs = allFiles.filter((f) => JS_TS.has(extOf(f)));
    const inScopeTarget = (t: string): boolean => JS_TS.has(extOf(t)) || extOf(t) === '.json';

    // Truth
    const configs = new ConfigIndex(root);
    const refsByFile = new Map<string, TruthRef[]>();
    const contentOf = new Map<string, string>();
    const heap0 = process.memoryUsage().heapUsed;
    const t0 = performance.now();
    for (const f of jsTs) {
      let text: string;
      try {
        text = fs.readFileSync(f, 'utf-8');
      } catch {
        continue;
      }
      contentOf.set(f, text);
      refsByFile.set(f, truthRefs(f, text, configs));
    }
    const truthMs = performance.now() - t0;
    const truthHeapMb = (process.memoryUsage().heapUsed - heap0) / 1024 / 1024;

    const truth = new Map<string, TruthRef>(); // "src\0tgt" → first ref
    for (const [src, refs] of refsByFile) {
      for (const r of refs) {
        if (!r.target || r.target === src || !indexed.has(r.target) || !inScopeTarget(r.target))
          continue;
        const k = `${src}\0${r.target}`;
        if (!truth.has(k)) truth.set(k, r);
      }
    }

    // Indexed edges
    const rows = db
      .prepare(
        `SELECT s.path AS src, t.path AS tgt FROM dependencies d
         JOIN files s ON s.id = d.source_id JOIN files t ON t.id = d.target_id`,
      )
      .all() as { src: string; tgt: string }[];
    const idx = new Set<string>();
    let assetEdgesSkipped = 0;
    for (const r of rows) {
      if (!JS_TS.has(extOf(r.src))) continue;
      if (!inScopeTarget(r.tgt)) {
        assetEdgesSkipped++;
        continue;
      }
      idx.add(`${r.src}\0${r.tgt}`);
    }

    const aliases = new AliasResolver(root);
    const vite = viteAliasKeys(root, allFiles);
    const fpCat: Record<string, number> = {};
    const fnCat: Record<string, number> = {};
    const falsePositives: EdgeIssue[] = [];
    const falseNegatives: EdgeIssue[] = [];
    let tp = 0;
    let aliasTp = 0;
    let aliasFn = 0;
    let aliasFp = 0;
    for (const [k, ref] of truth) {
      const [src, tgt] = k.split('\0');
      const alias = !isRelative(ref.spec);
      if (idx.has(k)) {
        tp++;
        if (alias) aliasTp++;
        continue;
      }
      if (alias) aliasFn++;
      const category = categorizeMissed(ref, src, contentOf.get(src) ?? '', root, aliases);
      bump(fnCat, category);
      falseNegatives.push({ source: src, target: tgt, spec: ref.spec, category });
    }
    for (const k of idx) {
      if (truth.has(k)) continue;
      const [src, tgt] = k.split('\0');
      const { spec, category } = categorizeExtra(
        src,
        tgt,
        contentOf.get(src) ?? '',
        root,
        aliases,
        refsByFile.get(src) ?? [],
        vite.keysFor(src),
      );
      if (spec !== '?' && !isRelative(spec)) aliasFp++;
      bump(fpCat, category);
      falsePositives.push({ source: src, target: tgt, spec, category });
    }
    const edges = metric(tp, falsePositives.length, falseNegatives.length);
    const bundlerOnly = (fpCat[BUNDLER_ONLY] ?? 0) + (fpCat[VITE_ONLY] ?? 0);
    const edgesAdjusted = metric(
      tp + bundlerOnly,
      falsePositives.length - bundlerOnly,
      falseNegatives.length,
    );

    // who_imports on a sample of files that have an importer on either side
    const truthImporters = new Map<string, Set<string>>();
    for (const k of truth.keys()) {
      const [src, tgt] = k.split('\0');
      if (!truthImporters.has(tgt)) truthImporters.set(tgt, new Set());
      truthImporters.get(tgt)!.add(src);
    }
    const idxTargets = new Set([...idx].map((k) => k.split('\0')[1]));
    const askable = jsTs.filter((f) => truthImporters.has(f) || idxTargets.has(f));
    const whoSample = sampleOf(askable, sampleSize, seed);
    let wTp = 0;
    let wFp = 0;
    let wFn = 0;
    let wExact = 0;
    for (const f of whoSample) {
      const text = whoImports(db, f, { show: (p) => p }).text;
      const direct = text.split('\n## Via')[0];
      const got = new Set(
        direct
          .split('\n')
          .filter((l) => l.startsWith('- '))
          .map((l) => l.slice(2).split(' ')[0])
          .filter((p) => JS_TS.has(extOf(p))),
      );
      const want = truthImporters.get(f) ?? new Set<string>();
      let ok = 0;
      for (const g of got) if (want.has(g)) ok++;
      wTp += ok;
      wFp += got.size - ok;
      wFn += want.size - ok;
      if (ok === got.size && ok === want.size) wExact++;
    }

    // exports_in rows on a sample of files with exports on either side
    const idxExports = new Map<string, Set<string>>();
    for (const r of db
      .prepare(`SELECT f.path, e.name FROM exports e JOIN files f ON f.id = e.file_id`)
      .all() as { path: string; name: string }[]) {
      if (!JS_TS.has(extOf(r.path))) continue;
      if (!idxExports.has(r.path)) idxExports.set(r.path, new Set());
      idxExports.get(r.path)!.add(r.name);
    }
    const exportCandidates = jsTs.filter((f) => /\bexport\b/.test(contentOf.get(f) ?? ''));
    const expSample = sampleOf(exportCandidates, sampleSize, seed + 1);
    const truthExp = truthExports(expSample, configs);
    let eTp = 0;
    let eFp = 0;
    let eFn = 0;
    let eExact = 0;
    const eFpCat: Record<string, number> = {};
    const eFnCat: Record<string, number> = {};
    const exportMisses: { file: string; name: string; category: string }[] = [];
    const exportExtras: { file: string; name: string; category: string }[] = [];
    for (const f of expSample) {
      const want = truthExp.get(f) ?? new Map<string, string>();
      const got = idxExports.get(f) ?? new Set<string>();
      let ok = 0;
      const code = codeOnly(contentOf.get(f) ?? '');
      for (const g of got) {
        if (want.has(g)) {
          ok++;
          continue;
        }
        const category = new RegExp(String.raw`\bexport\b[^;]*\b${g}\b`).test(code)
          ? 'not exported under this name per compiler'
          : 'match inside a string or comment';
        bump(eFpCat, category);
        exportExtras.push({ file: f, name: g, category });
      }
      for (const [n, cat] of want) {
        if (got.has(n)) continue;
        bump(eFnCat, cat);
        exportMisses.push({ file: f, name: n, category: cat });
      }
      eTp += ok;
      eFp += got.size - ok;
      eFn += want.size - ok;
      if (ok === got.size && ok === want.size) eExact++;
    }

    // Vite aliases: how many specifiers they cover and how many tsconfig misses
    let viteSpecs = 0;
    let viteNotTs = 0;
    if (vite.keys.length) {
      for (const [file, refs] of refsByFile) {
        const keys = vite.keysFor(file);
        for (const r of refs) {
          if (isRelative(r.spec) || !keys.some((k) => matchesAliasKey(r.spec, k))) continue;
          viteSpecs++;
          if (!r.target || !isInside(r.target, root) || r.viaNodeModules) viteNotTs++;
        }
      }
    }

    return {
      root,
      files: allFiles.length,
      jsTsFiles: jsTs.length,
      indexMs,
      truthMs,
      truthHeapMb,
      edges,
      edgesAdjusted,
      edgesByCategory: { fp: fpCat, fn: fnCat },
      falsePositives,
      falseNegatives,
      aliasEdges: metric(aliasTp, aliasFp, aliasFn),
      assetEdgesSkipped,
      whoImports: { ...metric(wTp, wFp, wFn), files: whoSample.length, exact: wExact },
      exportsIn: {
        ...metric(eTp, eFp, eFn),
        files: expSample.length,
        exact: eExact,
        fpByCategory: eFpCat,
        fnByCategory: eFnCat,
        misses: exportMisses,
        extras: exportExtras,
      },
      viteAliases: {
        configs: vite.configs.length,
        keys: vite.keys,
        specifiers: viteSpecs,
        notInTsconfig: viteNotTs,
      },
    };
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ─── Output ──────────────────────────────────────────────────────────────────

const pct = (x: number): string => `${(x * 100).toFixed(1)}%`;

export function formatReport(r: RepoReport, maxListed = 15): string {
  const rel = (p: string): string => path.relative(r.root, p);
  const cats = (m: Record<string, number>): string =>
    Object.entries(m)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `  - ${k}: ${v}`)
      .join('\n') || '  - none';
  const list = (xs: EdgeIssue[]): string =>
    xs
      .slice(0, maxListed)
      .map((e) => `  - ${rel(e.source)} → ${rel(e.target)} ("${e.spec}") [${e.category}]`)
      .join('\n') + (xs.length > maxListed ? `\n  - +${xs.length - maxListed} more` : '');
  return [
    `# ${r.root}`,
    `files ${r.files} (JS/TS ${r.jsTsFiles}); index ${r.indexMs.toFixed(0)} ms; compiler truth ${r.truthMs.toFixed(0)} ms, +${r.truthHeapMb.toFixed(0)} MB heap`,
    `edges: precision ${pct(r.edges.precision)} recall ${pct(r.edges.recall)} (tp ${r.edges.tp}, fp ${r.edges.fp}, fn ${r.edges.fn}); asset edges skipped ${r.assetEdgesSkipped}`,
    `edges, bundler-only counted correct: precision ${pct(r.edgesAdjusted.precision)} recall ${pct(r.edgesAdjusted.recall)}`,
    `alias edges: precision ${pct(r.aliasEdges.precision)} recall ${pct(r.aliasEdges.recall)} (tp ${r.aliasEdges.tp}, fp ${r.aliasEdges.fp}, fn ${r.aliasEdges.fn})`,
    `who_imports (${r.whoImports.files} files, ${r.whoImports.exact} exact): precision ${pct(r.whoImports.precision)} recall ${pct(r.whoImports.recall)}`,
    `exports_in (${r.exportsIn.files} files, ${r.exportsIn.exact} exact): precision ${pct(r.exportsIn.precision)} recall ${pct(r.exportsIn.recall)}`,
    `vite: ${r.viteAliases.configs} config(s), alias keys [${r.viteAliases.keys.join(', ')}], ${r.viteAliases.specifiers} specifiers, ${r.viteAliases.notInTsconfig} not resolved by tsconfig`,
    `false negatives by category:\n${cats(r.edgesByCategory.fn)}`,
    `false positives by category:\n${cats(r.edgesByCategory.fp)}`,
    `export misses by category:\n${cats(r.exportsIn.fnByCategory)}`,
    `export extras by category:\n${cats(r.exportsIn.fpByCategory)}`,
    `export misses:\n${r.exportsIn.misses
      .slice(0, maxListed)
      .map((e) => `  - ${rel(e.file)}: ${e.name} [${e.category}]`)
      .join('\n')}`,
    `false negatives:\n${list(r.falseNegatives)}`,
    `false positives:\n${list(r.falsePositives)}`,
  ].join('\n');
}

function main(argv: string[]): void {
  const roots: string[] = [];
  let sample = 50;
  let seed = 182;
  let jsonOut: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--sample') sample = Number(argv[++i]);
    else if (a === '--seed') seed = Number(argv[++i]);
    else if (a === '--json') jsonOut = argv[++i] ?? null;
    else roots.push(a);
  }
  const bad = !Number.isInteger(sample) || sample < 1 || !Number.isInteger(seed);
  if (roots.length === 0 || bad || (argv.includes('--json') && !jsonOut)) {
    console.error(
      'usage: import-graph-accuracy.mts <repo-root> [...] [--sample 50] [--seed 182] [--json out.json]',
    );
    process.exit(64);
  }
  const reports = roots.map((r) => measureRepo(r, { sample, seed }));
  for (const r of reports) process.stdout.write(`${formatReport(r)}\n\n`);
  if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify(reports, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2));
}
