/**
 * Answer key of the large fixture (CCA-09, #124), computed by an independent
 * method: the TypeScript compiler API (its parser, `ts.resolveModuleName`
 * with Bundler resolution, and the type checker's alias resolution). Nothing
 * here uses code-context's regex parser, resolver or index, so a pass in the
 * dry check is a real agreement between two implementations.
 *
 * The key is pinned in answers.json next to the fixture's sha256. Regenerate
 * after changing generate.mts and review the diff:
 *   npx tsx scripts/bench/live/large-fixture/answer-key.mts --write
 * Without --write it recomputes and exits 1 when the pinned key differs.
 */
import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import {
  ANSWERS_PATH,
  GENERATOR_VERSION,
  fixtureHash,
  generateLargeFixture,
  type PinnedFixture,
} from './generate.mts';

/** The questions the index-shaped tasks ask (tasks.mts I1–I6 point here by key). */
export const QUESTIONS = {
  retryImporters: { kind: 'importers', file: 'src/platform/http/retry.ts' },
  orderLineImporters: { kind: 'importers', file: 'src/orders/model/order-line.ts' },
  formatMoneyImporters: {
    kind: 'symbol-importers',
    file: 'src/core/money.ts',
    name: 'formatMoney',
  },
  catalogUtilsUnused: { kind: 'unused-exports', dir: 'src/catalog/utils' },
  resolveTaxRateDefinition: { kind: 'definition', name: 'resolveTaxRate' },
  pointsMathTwoHop: { kind: 'two-hop', file: 'src/loyalty/utils/points-math.ts' },
} as const;
export type QuestionKey = keyof typeof QUESTIONS;

export interface ExportRef {
  file: string;
  name: string;
}

export interface AnswerKey {
  fixture: PinnedFixture & { tsFiles: number; lines: number; chars: number; typeErrors: number };
  answers: {
    retryImporters: string[];
    orderLineImporters: string[];
    formatMoneyImporters: string[];
    catalogUtilsUnused: ExportRef[];
    /** Every export of the folder (the checker's universe of names). */
    catalogUtilsExports: ExportRef[];
    resolveTaxRateDefinition: string[];
    pointsMathTwoHop: string[];
  };
  /** Files that mention the name as a whole word but are not answers (grep noise, informative). */
  decoys: Record<string, string[]>;
}

const VROOT = '/__large_fixture__';
const abs = (rel: string): string => `${VROOT}/${rel}`;
const relOf = (a: string): string => a.slice(VROOT.length + 1);
const isTs = (p: string): boolean => /\.(ts|tsx|mts)$/.test(p);
const sorted = (xs: Iterable<string>): string[] => [...new Set(xs)].sort();

const OPTIONS: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2022,
  lib: ['lib.es2022.d.ts'],
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  strict: true,
  noEmit: true,
  skipLibCheck: true,
  types: [],
};

interface Ref {
  /** Workspace-relative path of the resolved module (a fixture file). */
  target: string;
  node: ts.Node;
  kind: 'import' | 'export-from' | 'dynamic';
}

class Analysis {
  readonly program: ts.Program;
  readonly checker: ts.TypeChecker;
  private readonly host: ts.CompilerHost;
  readonly tsFiles: string[];
  readonly refs = new Map<string, Ref[]>();

  constructor(readonly files: Map<string, string>) {
    const vfiles = new Map([...files].map(([p, c]) => [abs(p), c]));
    const vdirs = new Set<string>();
    for (const f of vfiles.keys()) {
      for (let d = path.posix.dirname(f); d.startsWith(VROOT); d = path.posix.dirname(d))
        vdirs.add(d);
    }
    const inV = (p: string): boolean => p === VROOT || p.startsWith(`${VROOT}/`);
    const host = ts.createCompilerHost(OPTIONS, true);
    const base = { ...host };
    host.getCurrentDirectory = () => VROOT;
    host.fileExists = (f) => (inV(f) ? vfiles.has(f) : base.fileExists(f));
    host.readFile = (f) => (inV(f) ? vfiles.get(f) : base.readFile(f));
    host.directoryExists = (d) =>
      inV(d) ? vdirs.has(d) : (base.directoryExists?.(d) ?? ts.sys.directoryExists(d));
    host.getDirectories = (d) => (inV(d) ? [] : (base.getDirectories?.(d) ?? []));
    host.realpath = (p) => p;
    host.getSourceFile = (f, lang, onError, create) => {
      const text = inV(f) ? vfiles.get(f) : undefined;
      if (text !== undefined) return ts.createSourceFile(f, text, lang, true);
      return base.getSourceFile(f, lang, onError, create);
    };
    this.host = host;
    this.tsFiles = [...files.keys()].filter(isTs).sort();
    this.program = ts.createProgram(this.tsFiles.map(abs), OPTIONS, host);
    this.checker = this.program.getTypeChecker();
    for (const f of this.tsFiles) this.refs.set(f, this.collectRefs(f));
  }

  sf(rel: string): ts.SourceFile {
    const s = this.program.getSourceFile(abs(rel));
    if (!s) throw new Error(`answer-key: no source file ${rel}`);
    return s;
  }

  private resolve(spec: string, fromRel: string): string | null {
    const r = ts.resolveModuleName(spec, abs(fromRel), OPTIONS, this.host).resolvedModule;
    if (!r || !r.resolvedFileName.startsWith(`${VROOT}/`)) return null;
    return relOf(r.resolvedFileName);
  }

  /** Every module reference of a file that resolves to a fixture file. */
  private collectRefs(rel: string): Ref[] {
    const out: Ref[] = [];
    const add = (spec: ts.Expression | undefined, node: ts.Node, kind: Ref['kind']): void => {
      if (!spec || !ts.isStringLiteral(spec)) return;
      const target = this.resolve(spec.text, rel);
      if (target && target !== rel) out.push({ target, node, kind });
    };
    const visit = (node: ts.Node): void => {
      if (ts.isImportDeclaration(node)) add(node.moduleSpecifier, node, 'import');
      else if (ts.isExportDeclaration(node)) add(node.moduleSpecifier, node, 'export-from');
      else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        add(node.arguments[0], node, 'dynamic');
      }
      ts.forEachChild(node, visit);
    };
    visit(this.sf(rel));
    return out;
  }

  /** Files with an import / export-from / import() whose specifier resolves to `target`. */
  importersOf(target: string): string[] {
    return sorted(
      this.tsFiles.filter((f) => (this.refs.get(f) ?? []).some((r) => r.target === target)),
    );
  }

  /** The declaration symbol behind an import binding or export (aliases resolved). */
  private final(sym: ts.Symbol | undefined): ts.Symbol | undefined {
    if (!sym) return undefined;
    return sym.flags & ts.SymbolFlags.Alias ? this.checker.getAliasedSymbol(sym) : sym;
  }

  private moduleExports(rel: string): ts.Symbol[] {
    const ms = this.checker.getSymbolAtLocation(this.sf(rel));
    return ms ? this.checker.getExportsOfModule(ms) : [];
  }

  private declFile(sym: ts.Symbol): string | null {
    const d = sym.declarations?.[0];
    if (!d) return null;
    const f = d.getSourceFile().fileName;
    return f.startsWith(`${VROOT}/`) ? relOf(f) : null;
  }

  /**
   * Declarations each file USES through imports: named/default import bindings
   * (aliases followed through every barrel by the checker), plus every export
   * of a module taken whole (`import * as`, `export * as`, `import()` without
   * destructuring). A destructured `import()` uses only the names it lists.
   * `export … from` alone is no use. Returns user file → used symbols.
   */
  usesByFile(): Map<string, Set<ts.Symbol>> {
    const out = new Map<string, Set<ts.Symbol>>();
    for (const f of this.tsFiles) {
      const used = new Set<ts.Symbol>();
      const take = (s: ts.Symbol | undefined): void => {
        const t = this.final(s);
        if (t) used.add(t);
      };
      const whole = (target: string): void => {
        for (const e of this.moduleExports(target)) take(e);
      };
      for (const r of this.refs.get(f) ?? []) {
        if (r.kind === 'import' && ts.isImportDeclaration(r.node)) {
          const clause = r.node.importClause;
          if (!clause) continue;
          if (clause.name) take(this.checker.getSymbolAtLocation(clause.name));
          const nb = clause.namedBindings;
          if (nb && ts.isNamespaceImport(nb)) whole(r.target);
          else if (nb)
            for (const el of nb.elements) take(this.checker.getSymbolAtLocation(el.name));
        } else if (r.kind === 'export-from' && ts.isExportDeclaration(r.node)) {
          if (r.node.exportClause && ts.isNamespaceExport(r.node.exportClause)) whole(r.target);
        } else if (r.kind === 'dynamic') {
          const names = destructuredNames(r.node);
          if (names === null) whole(r.target);
          else for (const e of this.moduleExports(r.target)) if (names.includes(e.name)) take(e);
        }
      }
      out.set(f, used);
    }
    return out;
  }

  /** The exported declaration `name` of file `rel` (aliases resolved). */
  exportOf(rel: string, name: string): ts.Symbol {
    const s = this.final(this.moduleExports(rel).find((e) => e.name === name));
    if (!s) throw new Error(`answer-key: ${rel} does not export ${name}`);
    return s;
  }

  /** Own exports (declared in the file, not re-exported) of every file directly in `dir`. */
  ownExports(dir: string): Array<ExportRef & { sym: ts.Symbol }> {
    const out: Array<ExportRef & { sym: ts.Symbol }> = [];
    for (const f of this.tsFiles.filter((x) => path.posix.dirname(x) === dir)) {
      for (const e of this.moduleExports(f)) {
        if (e.flags & ts.SymbolFlags.Alias) continue;
        if (this.declFile(e) === f) out.push({ file: f, name: e.name, sym: e });
      }
    }
    return out.sort((a, b) => (a.file + a.name < b.file + b.name ? -1 : 1));
  }

  /** Files with a top-level exported declaration named `name` (not a re-export). */
  definitionsOf(name: string): string[] {
    const hits: string[] = [];
    for (const f of this.tsFiles) {
      for (const st of this.sf(f).statements) {
        const exported =
          ts.canHaveModifiers(st) &&
          (ts.getModifiers(st) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
        if (!exported) continue;
        const names: string[] = [];
        if (ts.isVariableStatement(st)) {
          for (const d of st.declarationList.declarations)
            if (ts.isIdentifier(d.name)) names.push(d.name.text);
        } else if (
          (ts.isFunctionDeclaration(st) ||
            ts.isClassDeclaration(st) ||
            ts.isInterfaceDeclaration(st) ||
            ts.isTypeAliasDeclaration(st) ||
            ts.isEnumDeclaration(st)) &&
          st.name
        ) {
          names.push(st.name.text);
        }
        if (names.includes(name)) hits.push(f);
      }
    }
    return sorted(hits);
  }

  /** Files whose text mentions `name` as a whole word. */
  mentions(name: string): string[] {
    const re = new RegExp(`(?<![\\w$])${name}(?![\\w$])`);
    return this.tsFiles.filter((f) => re.test(this.files.get(f) ?? ''));
  }

  typeErrors(): number {
    return ts.getPreEmitDiagnostics(this.program).length;
  }
}

/** Names of `const { a, b } = await import(…)`; null when the module is taken whole. */
function destructuredNames(call: ts.Node): string[] | null {
  let n: ts.Node = call;
  if (n.parent && ts.isAwaitExpression(n.parent)) n = n.parent;
  const decl = n.parent;
  if (decl && ts.isVariableDeclaration(decl) && ts.isObjectBindingPattern(decl.name)) {
    return decl.name.elements.map((el) =>
      el.propertyName && ts.isIdentifier(el.propertyName)
        ? el.propertyName.text
        : ts.isIdentifier(el.name)
          ? el.name.text
          : '',
    );
  }
  return null;
}

export function computeAnswerKey(files: Map<string, string> = generateLargeFixture()): AnswerKey {
  const a = new Analysis(files);
  const uses = a.usesByFile();
  const usedAnywhere = (sym: ts.Symbol, own: string): boolean =>
    [...uses].some(([f, set]) => f !== own && set.has(sym));

  // I3: files that take formatMoney through an import binding (direct, aliased or via a barrel).
  const fm = QUESTIONS.formatMoneyImporters;
  const fmSym = a.exportOf(fm.file, fm.name);
  const formatMoneyImporters = sorted(
    [...uses].filter(([f, set]) => f !== fm.file && set.has(fmSym)).map(([f]) => f),
  );
  // Guard: a whole-module import of a module that exports formatMoney would make the
  // question ambiguous ("does `import * as core` import formatMoney?"). The fixture has none.
  for (const f of a.tsFiles) {
    for (const r of a.refs.get(f) ?? []) {
      const isWhole =
        (r.kind === 'import' &&
          ts.isImportDeclaration(r.node) &&
          r.node.importClause?.namedBindings &&
          ts.isNamespaceImport(r.node.importClause.namedBindings)) ||
        (r.kind === 'dynamic' && destructuredNames(r.node) === null);
      if (isWhole && (r.target === fm.file || r.target === 'src/core/index.ts')) {
        throw new Error(
          `answer-key: ${f} takes ${r.target} whole; formatMoney importers would be ambiguous`,
        );
      }
    }
  }

  // I4: own exports of src/catalog/utils/*, unused = no other file uses the declaration.
  const exportsInDir = a.ownExports(QUESTIONS.catalogUtilsUnused.dir);
  const names = exportsInDir.map((e) => e.name);
  if (new Set(names).size !== names.length)
    throw new Error('answer-key: duplicate export names in the unused-exports folder');
  const catalogUtilsUnused = exportsInDir
    .filter((e) => !usedAnywhere(e.sym, e.file))
    .map(({ file, name }) => ({ file, name }));

  // I5: the one exported declaration.
  const def = a.definitionsOf(QUESTIONS.resolveTaxRateDefinition.name);
  if (def.length !== 1)
    throw new Error(
      `answer-key: resolveTaxRate must have exactly one exported declaration, got ${def.join(', ')}`,
    );

  // I6: direct importers plus their direct importers, minus the target itself.
  const X = QUESTIONS.pointsMathTwoHop.file;
  const hop1 = a.importersOf(X);
  const pointsMathTwoHop = sorted(
    [...hop1, ...hop1.flatMap((f) => a.importersOf(f))].filter((f) => f !== X),
  );

  const retryImporters = a.importersOf(QUESTIONS.retryImporters.file);
  const orderLineImporters = a.importersOf(QUESTIONS.orderLineImporters.file);

  const chars = [...files.values()].reduce((n, c) => n + c.length, 0);
  const lines = [...files.values()].reduce((n, c) => n + c.split('\n').length - 1, 0);
  const minus = (xs: string[], ys: Iterable<string>): string[] => {
    const s = new Set(ys);
    return xs.filter((x) => !s.has(x));
  };
  return {
    fixture: {
      generatorVersion: GENERATOR_VERSION,
      files: files.size,
      sha256: fixtureHash(files),
      tsFiles: a.tsFiles.length,
      lines,
      chars,
      typeErrors: a.typeErrors(),
    },
    answers: {
      retryImporters,
      orderLineImporters,
      formatMoneyImporters,
      catalogUtilsUnused,
      catalogUtilsExports: exportsInDir.map(({ file, name }) => ({ file, name })),
      resolveTaxRateDefinition: def,
      pointsMathTwoHop,
    },
    decoys: {
      withRetry: minus(a.mentions('withRetry'), [...retryImporters, QUESTIONS.retryImporters.file]),
      formatMoney: minus(a.mentions('formatMoney'), [...formatMoneyImporters, fm.file]),
      resolveTaxRate: minus(a.mentions('resolveTaxRate'), def),
    },
  };
}

export function readAnswerKey(): AnswerKey {
  return JSON.parse(fs.readFileSync(ANSWERS_PATH, 'utf-8')) as AnswerKey;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const key = computeAnswerKey();
  const text = `${JSON.stringify(key, null, 2)}\n`;
  if (key.fixture.typeErrors !== 0) {
    console.error(
      `large fixture has ${key.fixture.typeErrors} type errors — fix generate.mts first`,
    );
    process.exit(1);
  }
  if (process.argv.includes('--write')) {
    fs.writeFileSync(ANSWERS_PATH, text);
    console.log(
      `wrote ${path.relative(process.cwd(), ANSWERS_PATH)} (${key.fixture.files} files, sha256 ${key.fixture.sha256.slice(0, 12)}…)`,
    );
  } else {
    const pinned: unknown = fs.existsSync(ANSWERS_PATH)
      ? JSON.parse(fs.readFileSync(ANSWERS_PATH, 'utf-8'))
      : null;
    if (!isDeepStrictEqual(pinned, JSON.parse(text))) {
      console.error(
        'answer key differs from answers.json — rerun with --write and review the diff',
      );
      process.exit(1);
    }
    console.log('answers.json is up to date');
  }
}
