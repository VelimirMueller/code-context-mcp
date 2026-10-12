import fs from "fs";
import path from "path";
import Database from "better-sqlite3";
import { SKIP_DIR_NAMES } from "../shared/ignore.js";
import { admitFile, isDeniedDir, isDeniedFileName, looksBinary } from "./index-policy.js";
import { gitListFiles, isGitCheckout, readGitHead } from "./git.js";
import { AliasResolver, probeFile } from "./tsconfig-paths.js";
import { DEFAULT_EXPORT_SRC, NAMED_EXPORT_SRC, exportDetails, importLines, serializeImportLines } from "./signatures.js";
import { parsePhp, phpEdges, PhpResolver, type PhpLookup, type PhpParse } from "./php.js";

// ─── .gitignore support ─────────────────────────────────────────────────────
interface GitignorePattern {
  pattern: string;
  negated: boolean;
  dirOnly: boolean;
}

function loadGitignore(rootDir: string): GitignorePattern[] {
  const gitignorePath = path.join(rootDir, ".gitignore");
  if (!fs.existsSync(gitignorePath)) return [];
  const content = fs.readFileSync(gitignorePath, "utf-8");
  const patterns: GitignorePattern[] = [];
  for (const raw of content.split("\n")) {
    let line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const negated = line.startsWith("!");
    if (negated) line = line.slice(1);
    const dirOnly = line.endsWith("/");
    if (dirOnly) line = line.slice(0, -1);
    patterns.push({ pattern: line, negated, dirOnly });
  }
  return patterns;
}

function matchesGitignore(relativePath: string, isDirectory: boolean, patterns: GitignorePattern[]): boolean {
  const name = path.basename(relativePath);
  let ignored = false;
  for (const p of patterns) {
    if (p.dirOnly && !isDirectory) continue;
    let matches = false;
    if (p.pattern.includes("/")) {
      // Path pattern: match against relative path
      matches = relativePath.startsWith(p.pattern) || relativePath === p.pattern;
    } else if (p.pattern.startsWith("*.")) {
      // Extension glob: match by suffix
      const ext = p.pattern.slice(1); // e.g. ".log"
      matches = name.endsWith(ext);
    } else if (p.pattern.startsWith("*")) {
      // Generic trailing wildcard
      const suffix = p.pattern.slice(1);
      matches = name.endsWith(suffix);
    } else {
      // Simple name match (directory or file)
      matches = name === p.pattern;
    }
    if (matches) ignored = !p.negated;
  }
  return ignored;
}

// ─── Config ──────────────────────────────────────────────────────────────────
// Directory policy: src/shared/ignore.ts (shared with the watcher). File policy
// (binaries, lockfiles, minified bundles, size cap, Laravel storage/):
// src/server/index-policy.ts. On top of both, a git checkout is listed through
// `git ls-files`, so every .gitignore at any depth is honoured exactly as git
// reads it. On 2026-10-09, 71 % of the shared index was node_modules/vendor.
const SKIP_DIRS = SKIP_DIR_NAMES;

const PARSEABLE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);
const PYTHON_EXTENSIONS = new Set([".py", ".pyi"]);
const PHP_EXTENSION = ".php";

function isParsedExtension(ext: string): boolean {
  return PARSEABLE_EXTENSIONS.has(ext) || PYTHON_EXTENSIONS.has(ext) || ext === PHP_EXTENSION;
}

const LANG_MAP: Record<string, string> = {
  ".ts": "typescript", ".tsx": "typescriptreact",
  ".js": "javascript", ".jsx": "javascriptreact",
  ".mjs": "javascript", ".cjs": "javascript",
  ".py": "python", ".pyw": "python",
  ".rb": "ruby", ".rs": "rust", ".go": "go",
  ".java": "java", ".kt": "kotlin", ".scala": "scala",
  ".c": "c", ".h": "c", ".cpp": "cpp", ".hpp": "cpp", ".cc": "cpp",
  ".cs": "csharp", ".fs": "fsharp",
  ".swift": "swift", ".m": "objc", ".mm": "objcpp",
  ".php": "php", ".lua": "lua", ".r": "r",
  ".dart": "dart", ".ex": "elixir", ".exs": "elixir",
  ".erl": "erlang", ".hs": "haskell", ".clj": "clojure",
  ".vue": "vue", ".svelte": "svelte", ".astro": "astro",
  ".html": "html", ".htm": "html",
  ".css": "css", ".scss": "scss", ".sass": "sass", ".less": "less",
  ".json": "json", ".jsonc": "json",
  ".yaml": "yaml", ".yml": "yaml", ".toml": "toml",
  ".xml": "xml", ".graphql": "graphql", ".gql": "graphql",
  ".sql": "sql", ".prisma": "prisma",
  ".md": "markdown", ".mdx": "mdx", ".txt": "text", ".rst": "rst",
  ".sh": "shell", ".bash": "shell", ".zsh": "shell", ".fish": "shell",
  ".ps1": "powershell", ".bat": "batch", ".cmd": "batch",
  ".dockerfile": "docker", ".proto": "protobuf",
  ".tf": "terraform", ".hcl": "hcl",
  ".ini": "ini", ".cfg": "ini",
  ".lock": "lockfile",
};

// ─── Import parsing (JS/TS only) ────────────────────────────────────────────
interface ParsedImport {
  symbols: string[];
  source: string;
  /** Python only: true for `from <source> import …`, false for `import <source>` */
  fromImport?: boolean;
}

/** Names of a `{ a, type b, c as d }` list, original spelling (`a`, `b`, `c`). */
function braceNames(raw: string): string[] {
  return raw
    .split(",")
    .map((s) => s.trim().replace(/^type\s+/, "").split(/\s+as\s+|\s*:\s*|\s*=/)[0].trim())
    .filter((s) => /^[\w$]+$/.test(s));
}

/**
 * JS/TS module references and what each one takes. Symbols (stored in
 * dependencies.symbols, CCA-05 #120):
 * - `a` named or default import (`import type` too); `* as ns` namespace import
 * - `export a` / `export a as b` re-export; `export *`; `export * as ns`
 * - `import()` / `require()` dynamic import or require without destructuring
 *   (a destructured one lists its names); side-effect import: no symbols
 */
export function parseImports(content: string): ParsedImport[] {
  const results: ParsedImport[] = [];
  const NB = String.raw`(?<![\w$.])`;
  let m: RegExpExecArray | null;
  // import [type] <clause> from '<src>'
  const staticRe = new RegExp(String.raw`${NB}import\s+(?:type\s+)?([^'";]*?)\s*\bfrom\s*['"]([^'"\n]+)['"]`, "g");
  while ((m = staticRe.exec(content)) !== null) {
    const clause = m[1];
    const symbols: string[] = [];
    const def = /^([\w$]+)\s*(?:,|$)/.exec(clause.trim());
    if (def && def[1] !== "type") symbols.push(def[1]);
    const braces = /\{([^}]*)\}/.exec(clause);
    if (braces) symbols.push(...braceNames(braces[1]));
    const ns = /\*\s*as\s+([\w$]+)/.exec(clause);
    if (ns) symbols.push(`* as ${ns[1]}`);
    results.push({ symbols, source: m[2] });
  }
  // import '<src>' (side effect)
  const bareRe = new RegExp(String.raw`${NB}import\s*['"]([^'"\n]+)['"]`, "g");
  while ((m = bareRe.exec(content)) !== null) results.push({ symbols: [], source: m[1] });
  // export [type] * [as ns] | { list } from '<src>'
  const reRe = new RegExp(
    String.raw`${NB}export\s+(?:type\s+)?(?:\*(?:\s*as\s+([\w$]+))?|\{([^}]*)\})\s*from\s*['"]([^'"\n]+)['"]`,
    "g",
  );
  while ((m = reRe.exec(content)) !== null) {
    let symbols: string[];
    if (m[2] !== undefined) {
      symbols = m[2]
        .split(",")
        .map((s) => s.trim().replace(/^type\s+/, "").split(/\s+as\s+/).map((p) => p.trim()))
        .filter((p) => /^[\w$]+$/.test(p[0]))
        .map((p) => (p[1] && p[1] !== p[0] ? `export ${p[0]} as ${p[1]}` : `export ${p[0]}`));
    } else {
      symbols = [m[1] ? `export * as ${m[1]}` : "export *"];
    }
    results.push({ symbols, source: m[3] });
  }
  // [const { a, b } = ] [await] import('<src>') | require('<src>')
  const dynRe = new RegExp(
    String.raw`(?:(?:const|let|var)\s*\{([^}]*)\}\s*=\s*(?:await\s+)?)?${NB}(import|require)\s*\(\s*['"]([^'"\n]+)['"]\s*\)`,
    "g",
  );
  while ((m = dynRe.exec(content)) !== null) {
    const names = m[1] !== undefined ? braceNames(m[1]) : [];
    results.push({ symbols: names.length ? names : [`${m[2]}()`], source: m[3] });
  }
  return results;
}

// ─── Export parsing (JS/TS only) ────────────────────────────────────────────
export interface ParsedExport {
  name: string;
  kind: string;
  description: string | null;
}

/** Extract the description from a JSDoc block that ends just before `pos` in `content`. */
export function extractJSDocBefore(content: string, pos: number): string | null {
  const before = content.slice(0, pos);
  const match = /\/\*\*\s*([\s\S]*?)\*\/\s*$/.exec(before);
  if (!match) return null;

  const desc = match[1]
    .split("\n")
    .map(line => line.replace(/^\s*\*\s?/, "").trim())
    .filter(line => line && !line.startsWith("@"))
    .join(" ")
    .trim();

  return desc || null;
}

const MUTABLE_KINDS = new Set(["let", "var"]);

function normalizeKind(kind: string): string {
  return MUTABLE_KINDS.has(kind) ? "const" : kind;
}

/** Collect all regex matches into an array via a mapper function. */
function matchAll(
  content: string,
  regex: RegExp,
  mapper: (match: RegExpExecArray) => ParsedExport[],
): ParsedExport[] {
  const results: ParsedExport[] = [];
  let m: RegExpExecArray | null;
  while ((m = regex.exec(content)) !== null) {
    results.push(...mapper(m));
  }
  return results;
}

/** Parse `export { a, b }` braces into name pairs, resolving `as` aliases. */
function parseBraceList(raw: string, useAlias: boolean): string[] {
  return raw
    .split(",")
    .map(s => s.trim().split(/\s+as\s+/))
    .map(parts => useAlias && parts.length > 1 ? parts[1] : parts[0])
    .filter(Boolean);
}

function findDefaultExports(content: string): ParsedExport[] {
  return matchAll(content, new RegExp(DEFAULT_EXPORT_SRC, "g"), (m) => [
    { name: m[2], kind: m[1], description: extractJSDocBefore(content, m.index) },
  ]);
}

function findNamedExports(content: string): ParsedExport[] {
  return matchAll(
    content,
    new RegExp(NAMED_EXPORT_SRC, "g"),
    (m) => [
      { name: m[2], kind: normalizeKind(m[1]), description: extractJSDocBefore(content, m.index) },
    ],
  );
}

// Re-export statements start a line: `export { a, b }` inside a comment or a
// string (` * Parse \`export { a, b }\` braces`) is not one.
function findLocalReExports(content: string): ParsedExport[] {
  return matchAll(content, /^[ \t]*export\s+\{([^}]+)\}(?!\s*from)/gm, (m) =>
    parseBraceList(m[1], false).map(name => ({ name, kind: "re-export", description: null })),
  );
}

function findModuleReExports(content: string): ParsedExport[] {
  return matchAll(content, /^[ \t]*export\s+\{([^}]+)\}\s*from\s+['"][^'"]+['"]/gm, (m) =>
    parseBraceList(m[1], true).map(name => ({ name, kind: "re-export", description: null })),
  );
}

export function parseExports(content: string): ParsedExport[] {
  return [
    ...findDefaultExports(content),
    ...findNamedExports(content),
    ...findLocalReExports(content),
    ...findModuleReExports(content),
  ];
}

// ─── Python parsing (regex-based, like the JS/TS parsers) ───────────────────
/**
 * Replace every triple-quoted string (and its delimiters) with spaces, keeping
 * newlines, so line-oriented matching never fires inside module-level strings.
 * Offsets stay identical to `content`, so match positions remain valid there.
 */
function blankTripleQuotedStrings(content: string): string {
  let result = "";
  let last = 0;
  const re = /("""[\s\S]*?"""|'''[\s\S]*?''')/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    result += content.slice(last, m.index);
    result += m[0].replace(/[^\n]/g, " ");
    last = m.index + m[0].length;
  }
  result += content.slice(last);
  return result;
}

/** Position of the `:` that ends a def/class header, skipping (...) and [...]. */
function pythonHeaderEnd(content: string, start: number): number {
  let depth = 0;
  for (let i = start; i < content.length; i++) {
    const ch = content[i];
    if (ch === "(" || ch === "[") depth++;
    else if (ch === ")" || ch === "]") depth--;
    else if (ch === ":" && depth <= 0) return i;
  }
  return -1;
}

/** First non-empty line of the docstring that directly follows `colonPos`, or null. */
function pythonDocstringAfter(content: string, colonPos: number): string | null {
  if (colonPos < 0) return null;
  const rest = content.slice(colonPos + 1);
  const m = /^\s*(?:"""([\s\S]*?)"""|'''([\s\S]*?)''')/.exec(rest);
  if (!m) return null;
  const body = m[1] ?? m[2] ?? "";
  return body.split("\n").map(l => l.trim()).find(l => l.length > 0) ?? null;
}

/** Names listed in a module-level `__all__ = [...]` / `__all__ = (...)`, or null when absent. */
function parsePythonAll(code: string): string[] | null {
  const m = /^__all__\s*=\s*[[(]([\s\S]*?)[\])]/m.exec(code);
  if (!m) return null;
  const names: string[] = [];
  const nameRe = /"([^"]*)"|'([^']*)'/g;
  let nm: RegExpExecArray | null;
  while ((nm = nameRe.exec(m[1])) !== null) {
    const name = nm[1] ?? nm[2];
    if (name) names.push(name);
  }
  return names;
}

export function parsePythonExports(content: string): ParsedExport[] {
  const code = blankTripleQuotedStrings(content);
  const defRe = /^(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/;
  const classRe = /^class\s+([A-Za-z_]\w*)/;
  const constRe = /^([A-Z][A-Z0-9_]*)\s*=/;

  const found = new Map<string, ParsedExport>();
  let offset = 0;
  for (const line of code.split("\n")) {
    let m: RegExpExecArray | null;
    let kind: string | null = null;
    let name: string | null = null;
    if ((m = defRe.exec(line))) { kind = "function"; name = m[1]; }
    else if ((m = classRe.exec(line))) { kind = "class"; name = m[1]; }
    else if ((m = constRe.exec(line))) { kind = "const"; name = m[1]; }

    if (kind && name && !found.has(name)) {
      let description: string | null = null;
      if (kind !== "const") {
        description = pythonDocstringAfter(content, pythonHeaderEnd(content, offset));
      }
      found.set(name, { name, kind, description });
    }
    offset += line.length + 1;
  }

  const allNames = parsePythonAll(code);
  if (allNames) {
    // __all__ wins: keep only listed names (with their found kind), list the
    // rest as re-exports. Listed names may include _private ones.
    return allNames.map(n => found.get(n) ?? { name: n, kind: "re-export", description: null });
  }
  return Array.from(found.values()).filter(e => !e.name.startsWith("_"));
}

export function parsePythonImports(content: string): ParsedImport[] {
  const code = blankTripleQuotedStrings(content);
  const found: { index: number; imp: ParsedImport }[] = [];

  // import a.b.c / import a.b as x / import a, b — module level and inside functions
  const importRe = /^[ \t]*import\s+([^#\n]+)/gm;
  let m: RegExpExecArray | null;
  while ((m = importRe.exec(code)) !== null) {
    for (const item of m[1].split(",")) {
      const trimmed = item.trim();
      if (!trimmed) continue;
      const asMatch = /^([\w.]+)\s+as\s+(\w+)$/.exec(trimmed);
      if (asMatch) found.push({ index: m.index, imp: { symbols: [asMatch[2]], source: asMatch[1], fromImport: false } });
      else if (/^[\w.]+$/.test(trimmed)) found.push({ index: m.index, imp: { symbols: [trimmed], source: trimmed, fromImport: false } });
    }
  }

  // from <source> import x, y as z — with parenthesised multi-line lists;
  // source keeps its leading dots (.mod, ..pkg.mod, .)
  const fromRe = /^[ \t]*from\s+((?:\.[\w.]*)|[\w.]+)\s+import\s+(?:\(([\s\S]*?)\)|([^#\n]+))/gm;
  while ((m = fromRe.exec(code)) !== null) {
    const source = m[1];
    const body = m[2] ?? m[3] ?? "";
    const symbols: string[] = [];
    for (const item of body.split(",")) {
      const trimmed = item.trim();
      if (!trimmed) continue;
      const asMatch = /^(\w+)\s+as\s+(\w+)$/.exec(trimmed);
      if (asMatch) symbols.push(asMatch[2]);
      else if (/^\w+$/.test(trimmed) || trimmed === "*") symbols.push(trimmed);
    }
    if (symbols.length) found.push({ index: m.index, imp: { symbols, source, fromImport: true } });
  }
  return found.sort((a, b) => a.index - b.index).map(f => f.imp);
}

/**
 * Resolve a parsed Python import to a file under rootDir: `<path>.py`, then
 * `<path>/__init__.py`. Relative sources go up one directory per extra dot;
 * absolute ones are tried from rootDir and rootDir/src. Never leaves rootDir.
 * Returns the module/package file the import source names (for `from . import x`
 * with no module part: the first symbol as a sibling module).
 */
export function resolvePythonImport(source: string, symbols: string[], fromFile: string, rootDir: string): string | null {
  return resolvePythonImportTargets(source, symbols, fromFile, rootDir)[0] ?? null;
}

/** `<base>.py`, then `<base>/__init__.py`, inside rootDir only. */
function pythonModuleFile(base: string, rootDir: string): string | null {
  for (const c of [base + ".py", path.join(base, "__init__.py")]) {
    if (fs.existsSync(c) && fs.statSync(c).isFile() && isPathInside(c, rootDir)) return c;
  }
  return null;
}

/** Directory bases a Python import source can name (relative: one dir up per extra dot). */
function pythonSourceBases(source: string, fromFile: string, rootDir: string): string[] {
  if (source.startsWith(".")) {
    const dots = source.match(/^\.+/)![0].length;
    const rest = source.slice(dots);
    let dir = path.dirname(fromFile);
    for (let i = 1; i < dots; i++) dir = path.dirname(dir);
    return [rest ? path.join(dir, ...rest.split(".")) : dir];
  }
  const rel = source.split(".");
  return [path.join(rootDir, ...rel), path.join(rootDir, "src", ...rel)];
}

/**
 * Every repo file a Python import really depends on, deduplicated. For
 * `from <src> import a, b` each name is tried as a SUBMODULE first
 * (`<src>/a.py`, `<src>/a/__init__.py`) — `from . import a, b` and
 * `from pkg import submodule` then get one edge per module — and a name that is
 * no submodule (a function, class, constant) falls back to the source module or
 * package file itself. `import a.b` resolves the dotted path only.
 */
export function resolvePythonImportTargets(source: string, symbols: string[], fromFile: string, rootDir: string, isFrom = true): string[] {
  const out = new Set<string>();
  for (const base of pythonSourceBases(source, fromFile, rootDir)) {
    let needSource = !isFrom || symbols.length === 0;
    if (isFrom) {
      for (const sym of symbols) {
        if (sym === "*") { needSource = true; continue; }
        const sub = pythonModuleFile(path.join(base, sym), rootDir);
        if (sub) out.add(sub);
        else needSource = true;
      }
    }
    if (needSource) {
      const own = pythonModuleFile(base, rootDir);
      if (own) out.add(own);
    }
    if (out.size) break; // first base (rootDir before rootDir/src) that resolves wins
  }
  return [...out];
}

/** Top-level packages of absolute imports that resolve to no repo file (stdlib, third-party). */
function extractPythonExternalPackages(content: string, filePath: string, rootDir: string): string[] {
  const packages = new Set<string>();
  for (const imp of parsePythonImports(content)) {
    if (imp.source.startsWith(".")) continue;
    if (resolvePythonImport(imp.source, imp.symbols, filePath, rootDir)) continue;
    packages.add(imp.source.split(".")[0]);
  }
  return Array.from(packages).sort();
}

/** Dispatch to the Python, PHP or JS/TS export parser for a file extension. */
function parseFileExports(content: string, ext: string): ParsedExport[] {
  if (PYTHON_EXTENSIONS.has(ext)) return parsePythonExports(content);
  if (ext === PHP_EXTENSION) return parsePhp(content).exports.map((e) => ({ name: e.name, kind: e.kind, description: e.fqn }));
  if (PARSEABLE_EXTENSIONS.has(ext)) return parseExports(content);
  return [];
}

/** Dispatch to the Python or JS/TS import parser for a file extension. */
function parseFileImports(content: string, ext: string): ParsedImport[] {
  if (PYTHON_EXTENSIONS.has(ext)) return parsePythonImports(content);
  if (PARSEABLE_EXTENSIONS.has(ext)) return parseImports(content);
  return [];
}

// ─── Summary extraction ──────────────────────────────────────────────────────
function extractSummary(content: string, filePath: string, ext: string): string {
  // JSON files: extract top-level "name" and "description"
  if (ext === ".json" || ext === ".jsonc") {
    try {
      const parsed = JSON.parse(content);
      const parts = [parsed.name, parsed.description].filter(Boolean);
      if (parts.length) return parts.join(" — ");
    } catch {}
    return path.basename(filePath);
  }

  // Markdown: first heading or first line
  if (ext === ".md" || ext === ".mdx") {
    const headingMatch = /^#\s+(.+)/m.exec(content);
    if (headingMatch) return headingMatch[1].trim();
    const firstLine = content.split("\n").find(l => l.trim());
    return firstLine?.slice(0, 120) ?? path.basename(filePath);
  }

  // Config files: just use filename
  if ([".yaml", ".yml", ".toml", ".ini", ".cfg", ".env", ".lock"].includes(ext)) {
    return path.basename(filePath);
  }

  // JS/TS and other code: try JSDoc, comments, then exports
  const jsdocRe = /^\s*\/\*\*\s*([\s\S]*?)\*\//;
  const jm = jsdocRe.exec(content);
  if (jm) {
    const lines = jm[1].split("\n").map(l => l.replace(/^\s*\*\s?/, "").trim()).filter(Boolean);
    if (lines.length > 0) return lines.slice(0, 3).join(" ");
  }

  // Try # comment blocks (Python, Ruby, Shell, YAML)
  if ([".py", ".rb", ".sh", ".bash", ".zsh", ".fish", ".yaml", ".yml"].includes(ext)) {
    const lines = content.split("\n");
    const commentLines: string[] = [];
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith("#") && !trimmed.startsWith("#!")) {
        commentLines.push(trimmed.replace(/^#\s?/, ""));
      } else if (trimmed === "") continue;
      else break;
    }
    if (commentLines.length > 0) return commentLines.slice(0, 3).join(" ");
  }

  // Try // comment blocks (JS/TS, Go, Rust, C, etc.)
  const lines = content.split("\n");
  const commentLines: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("//")) {
      commentLines.push(trimmed.replace(/^\/\/\s?/, ""));
    } else if (trimmed === "") continue;
    else break;
  }
  if (commentLines.length > 0) return commentLines.slice(0, 3).join(" ");

  // JS/TS and Python: fall back to exports list
  if (isParsedExtension(ext)) {
    const exports = parseFileExports(content, ext);
    if (exports.length > 0) return `Exports: ${exports.map(e => e.name).join(", ")}`;
  }

  return path.basename(filePath);
}

// ─── Resolve import path to a real file ──────────────────────────────────────
/**
 * True if `child` is `parent` itself or nested within it. Uses path.relative
 * (not string prefixing) so "/home/user" does not match "/home/userland", and
 * rejects any path that climbs out via "..". Guards against path traversal (#14).
 */
export function isPathInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * The repo file a JS/TS import names, or null (external package, missing
 * file, outside rootDir). Relative and `/`-rooted specifiers resolve against
 * the importing file / rootDir; with `aliases`, a bare specifier goes through
 * the governing tsconfig/jsconfig `paths` and `baseUrl` (CCA-18, #151).
 */
export function resolveImportPath(importSource: string, fromFile: string, rootDir: string, aliases?: AliasResolver): string | null {
  if (!importSource.startsWith(".") && !importSource.startsWith("/")) {
    return aliases ? aliases.resolve(importSource, fromFile) : null;
  }
  const base = importSource.startsWith("/")
    ? path.resolve(rootDir, importSource.slice(1))
    : path.resolve(path.dirname(fromFile), importSource);
  return probeFile(base, rootDir, aliases?.isFile ?? isFileOnDisk);
}

function isFileOnDisk(p: string): boolean {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

// ─── Extract external package names ──────────────────────────────────────────
function extractExternalImports(imports: ParsedImport[], filePath: string, aliases?: AliasResolver): string[] {
  const packages = new Set<string>();
  for (const imp of imports) {
    if (imp.source.startsWith(".") || imp.source.startsWith("/")) continue;
    if (aliases?.resolve(imp.source, filePath)) continue; // a tsconfig alias to a repo file
    const parts = imp.source.split("/");
    const name = imp.source.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
    packages.add(name);
  }
  return Array.from(packages).sort();
}

// ─── File metadata ───────────────────────────────────────────────────────────
export function toISOLocal(date: Date): string {
  return date.toISOString().replace("T", " ").replace(/\.\d+Z$/, "");
}

function getFileMeta(filePath: string) {
  const stat = fs.statSync(filePath);
  return {
    sizeBytes: stat.size,
    createdAt: toISOLocal(stat.birthtime),
    modifiedAt: toISOLocal(stat.mtime),
  };
}

function countLines(content: string): number {
  if (!content) return 0;
  return content.split("\n").length;
}

// ─── Walk directory ──────────────────────────────────────────────────────────
/**
 * Fallback walk for a directory git does not manage. Its output goes through
 * admitFile like the git listing; this only adds the root .gitignore approximation.
 */
function walkDir(dir: string, rootDir?: string, gitignorePatterns?: GitignorePattern[]): string[] {
  const root = rootDir ?? dir;
  const patterns = gitignorePatterns ?? loadGitignore(root);
  const results: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    if (entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    const relativePath = path.relative(root, full);
    if (entry.isSymbolicLink()) continue; // skip symlinks to avoid loops
    if (entry.isDirectory()) {
      if (isDeniedDir(full)) continue;
      if (patterns.length > 0 && matchesGitignore(relativePath, true, patterns)) continue;
      try { results.push(...walkDir(full, root, patterns)); } catch { /* skip inaccessible dirs */ }
    } else {
      if (isDeniedFileName(entry.name)) continue;
      if (patterns.length > 0 && matchesGitignore(relativePath, false, patterns)) continue;
      results.push(full);
    }
  }
  return results;
}

/**
 * Every file the indexer should store under `rootDir`, absolute and sorted.
 * Inside a git work tree this is `git ls-files --cached --others
 * --exclude-standard` (nested .gitignores, info/exclude and the global excludes
 * file all apply), filtered by the hard policy. Outside git it is the walk.
 */
export function listIndexableFiles(rootDir: string): string[] {
  // Listed under the realpath, so every returned path is one (the walk and the
  // policy skip symlinks below the root).
  let root: string;
  try { root = fs.realpathSync(path.resolve(rootDir)); } catch { return []; }
  const realRoot = root;
  const listed = gitListFiles(root) ?? walkDir(root);
  return listed.filter((f) => admitFile(f, root, realRoot).ok).sort();
}

/** True only when the file could be read and is binary (NUL bytes). Read errors → false. */
function isBinaryOnDisk(filePath: string): boolean {
  try { return looksBinary(fs.readFileSync(filePath)); } catch { return false; }
}

/** Read a file as UTF-8 text, or null when it is unreadable or binary. */
function readText(filePath: string): string | null {
  try {
    const buf = fs.readFileSync(filePath);
    if (looksBinary(buf)) return null;
    return buf.toString("utf-8");
  } catch {
    return null;
  }
}

// ─── Simple unified diff ────────────────────────────────────────────────────
function computeDiff(oldLines: string[], newLines: string[]): string {
  const hunks: string[] = [];
  const contextSize = 3;
  let i = 0, j = 0;

  // Find changed regions using LCS-like approach
  const changes: { type: "equal" | "delete" | "insert"; oldIdx: number; newIdx: number; line: string }[] = [];

  // Simple diff: walk both arrays, find matching lines
  const oldSet = new Map<string, number[]>();
  oldLines.forEach((line, idx) => {
    const arr = oldSet.get(line) ?? [];
    arr.push(idx);
    oldSet.set(line, arr);
  });

  // Myers-like simple diff via longest common subsequence
  const maxLen = oldLines.length + newLines.length;
  if (maxLen > 10000) return "(file too large for inline diff)";

  // Use a simple O(n*m) DP for small files, fall back to line-by-line for large
  if (oldLines.length * newLines.length > 500000) {
    // Fallback: show removed and added lines
    const removed = oldLines.filter(l => !newLines.includes(l));
    const added = newLines.filter(l => !oldLines.includes(l));
    const parts: string[] = [];
    removed.slice(0, 50).forEach(l => parts.push(`- ${l}`));
    added.slice(0, 50).forEach(l => parts.push(`+ ${l}`));
    if (removed.length > 50 || added.length > 50) parts.push(`... (truncated)`);
    return parts.join("\n");
  }

  // LCS table
  const m = oldLines.length, n = newLines.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
  for (let a = m - 1; a >= 0; a--) {
    for (let b = n - 1; b >= 0; b--) {
      if (oldLines[a] === newLines[b]) dp[a][b] = dp[a + 1][b + 1] + 1;
      else dp[a][b] = Math.max(dp[a + 1][b], dp[a][b + 1]);
    }
  }

  // Walk the LCS to produce diff lines
  const diffLines: { type: string; line: string; oldLn?: number; newLn?: number }[] = [];
  let a = 0, b = 0;
  while (a < m || b < n) {
    if (a < m && b < n && oldLines[a] === newLines[b]) {
      diffLines.push({ type: " ", line: oldLines[a], oldLn: a + 1, newLn: b + 1 });
      a++; b++;
    } else if (b < n && (a >= m || dp[a][b + 1] >= dp[a + 1][b])) {
      diffLines.push({ type: "+", line: newLines[b], newLn: b + 1 });
      b++;
    } else {
      diffLines.push({ type: "-", line: oldLines[a], oldLn: a + 1 });
      a++;
    }
  }

  // Format into hunks with context
  const output: string[] = [];
  let inHunk = false;
  for (let k = 0; k < diffLines.length; k++) {
    const dl = diffLines[k];
    if (dl.type !== " ") {
      // Show context before
      if (!inHunk) {
        const start = Math.max(0, k - contextSize);
        for (let c = start; c < k; c++) {
          output.push(`  ${diffLines[c].line}`);
        }
        inHunk = true;
      }
      output.push(`${dl.type} ${dl.line}`);
    } else if (inHunk) {
      // Show context after
      output.push(`  ${dl.line}`);
      // Check if next change is within context range
      let nextChange = -1;
      for (let c = k + 1; c < diffLines.length && c <= k + contextSize * 2; c++) {
        if (diffLines[c].type !== " ") { nextChange = c; break; }
      }
      if (nextChange === -1 || nextChange > k + contextSize * 2) {
        inHunk = false;
        if (k < diffLines.length - 1) output.push("---");
      }
    }
  }

  // Truncate very long diffs
  if (output.length > 100) {
    return output.slice(0, 100).join("\n") + "\n... (truncated, " + output.length + " total lines)";
  }
  return output.join("\n");
}

// ─── Snapshot helpers for change tracking ───────────────────────────────────
interface FileSnapshot {
  path: string;
  summary: string | null;
  line_count: number;
  size_bytes: number;
  exports: string;
  content: string;
}

/**
 * Content + exports of indexed files, for the change log. Scoped: a whole-db
 * snapshot read every stored file's content (205 MB on 2026-10-09) once per
 * indexed repo, before and after, although only rows under the root can change.
 */
function snapshotFromDb(db: Database.Database, scope: { root?: string; paths?: string[] } = {}): Map<string, FileSnapshot> {
  const select = `
    SELECT f.path, f.summary, f.line_count, f.size_bytes,
      COALESCE(f.content, '') as content,
      COALESCE(GROUP_CONCAT(e.name || ' ' || e.kind, ', '), '') as exports
    FROM files f LEFT JOIN exports e ON e.file_id = f.id`;
  let rows: FileSnapshot[];
  if (scope.paths) {
    rows = [];
    const stmt = db.prepare(`${select} WHERE f.path = ? GROUP BY f.id`);
    for (const p of scope.paths) rows.push(...(stmt.all(p) as FileSnapshot[]));
  } else if (scope.root) {
    const prefix = scope.root.endsWith(path.sep) ? scope.root : scope.root + path.sep;
    rows = db.prepare(`${select} WHERE substr(f.path, 1, ?) = ? GROUP BY f.id`).all(prefix.length, prefix) as FileSnapshot[];
  } else {
    rows = db.prepare(`${select} GROUP BY f.id`).all() as FileSnapshot[];
  }
  const map = new Map<string, FileSnapshot>();
  for (const r of rows) map.set(r.path, r);
  return map;
}

function diffAndLogChanges(db: Database.Database, before: Map<string, FileSnapshot>, after: Map<string, FileSnapshot>) {
  const insertChange = db.prepare(`
    INSERT INTO changes (file_path, event, old_summary, new_summary, old_line_count, new_line_count, old_size_bytes, new_size_bytes, old_exports, new_exports, diff_text)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (const [p, snap] of after) {
    if (!before.has(p)) {
      insertChange.run(p, "add", null, snap.summary, null, snap.line_count, null, snap.size_bytes, null, snap.exports, null);
    }
  }
  for (const [p, snap] of before) {
    if (!after.has(p)) {
      insertChange.run(p, "delete", snap.summary, null, snap.line_count, null, snap.size_bytes, null, snap.exports, null, null);
    }
  }
  for (const [p, newSnap] of after) {
    const old = before.get(p);
    if (!old) continue;
    if (old.summary !== newSnap.summary || old.line_count !== newSnap.line_count || old.size_bytes !== newSnap.size_bytes || old.exports !== newSnap.exports) {
      const diff = computeDiff(old.content.split("\n"), newSnap.content.split("\n"));
      insertChange.run(p, "change", old.summary, newSnap.summary, old.line_count, newSnap.line_count, old.size_bytes, newSnap.size_bytes, old.exports, newSnap.exports, diff);
    }
  }
}

// ─── Auto-generate file description ─────────────────────────────────────────
function generateFileDescription(filePath: string, lang: string, ext: string, lineCount: number, content: string, summary: string, externals: string | null): string | null {
  const name = path.basename(filePath);
  const exports = parseFileExports(content, ext);
  const imports = parseFileImports(content, ext);
  const localImports = imports.filter(i => i.source.startsWith("."));
  const externalPkgs = externals ? externals.split(", ") : [];

  const parts: string[] = [];

  // Identify file role from name patterns
  if (name === "index.ts" || name === "index.js") parts.push("Entry point");
  else if (name.includes("setup")) parts.push("Setup/bootstrap script");
  else if (name.includes("schema")) parts.push("Schema definitions");
  else if (name.includes("config")) parts.push("Configuration");
  else if (name.endsWith(".test.ts") || name.endsWith(".spec.ts") || name.endsWith(".test.js") || name.endsWith(".spec.js") || name.endsWith(".test.tsx") || name.endsWith(".spec.tsx")) parts.push("Test suite");
  else if (name.includes("middleware")) parts.push("Middleware");
  else if (/^use[A-Z]/.test(name.replace(/\.\w+$/, ""))) parts.push("React hook");
  else if (name.includes("hook")) parts.push("Hook");
  else if (name.includes("util")) parts.push("Utility functions");
  else if (name.includes("helper")) parts.push("Helper functions");
  else if (name.includes("constant")) parts.push("Constants");
  else if (name.includes("types") || name.endsWith(".d.ts")) parts.push("Type definitions");

  // What does it export?
  if (exports.length > 0) {
    const fns = exports.filter(e => e.kind === "function").map(e => e.name);
    const types = exports.filter(e => ["type", "interface", "enum", "trait"].includes(e.kind)).map(e => e.name);
    const classes = exports.filter(e => e.kind === "class").map(e => e.name);
    const consts = exports.filter(e => e.kind === "const").map(e => e.name);
    if (fns.length) parts.push(`exports ${fns.join(", ")}`);
    if (classes.length) parts.push(`defines ${classes.join(", ")}`);
    if (types.length) parts.push(`types: ${types.join(", ")}`);
    if (consts.length > 0 && consts.length <= 3) parts.push(`constants: ${consts.join(", ")}`);
  }

  // What does it depend on?
  if (externalPkgs.length) {
    parts.push(`uses ${externalPkgs.join(", ")}`);
  }

  // Internal imports
  if (localImports.length) {
    const imported = localImports.map(i => {
      const base = path.basename(i.source).replace(/\.(m|c)?js$/, "");
      return i.symbols.length ? `${i.symbols.join(", ")} from ${base}` : base;
    });
    if (imported.length <= 3) parts.push(`imports ${imported.join("; ")}`);
  }

  // Size context
  if (lineCount > 500) parts.push(`${lineCount} lines`);

  // For non-code files, use summary if meaningful or fall back to extension-based heuristics
  if (!PARSEABLE_EXTENSIONS.has(ext)) {
    if (ext === ".md" || ext === ".mdx") {
      return summary !== name ? summary : "Markdown document";
    }
    if (ext === ".json") {
      return summary !== name ? summary : "Configuration file";
    }
    if (ext === ".css" || ext === ".scss" || ext === ".sass" || ext === ".less") {
      if (parts.length === 0) parts.push("Stylesheet");
    }
    if (ext === ".html" || ext === ".htm") {
      if (parts.length === 0) parts.push("HTML document");
    }
    if (ext === ".yaml" || ext === ".yml" || ext === ".toml" || ext === ".ini" || ext === ".cfg") {
      if (parts.length === 0) parts.push("Configuration file");
    }
    if (ext === ".sql") {
      if (parts.length === 0) parts.push("SQL script");
    }
    if (ext === ".sh" || ext === ".bash" || ext === ".zsh") {
      if (parts.length === 0) parts.push("Shell script");
    }
    if (ext === ".graphql" || ext === ".gql") {
      if (parts.length === 0) parts.push("GraphQL schema/queries");
    }
    if (ext === ".prisma") {
      if (parts.length === 0) parts.push("Prisma schema");
    }
    if (ext === ".proto") {
      if (parts.length === 0) parts.push("Protocol Buffer definitions");
    }
    if (ext === ".dockerfile" || name === "Dockerfile" || name.startsWith("Dockerfile.")) {
      if (parts.length === 0) parts.push("Docker configuration");
    }
    return parts.length ? parts.join(". ") + "." : null;
  }

  // For parseable (JS/TS) files with no exports and no imports, use path-based heuristics
  if (parts.length === 0 && exports.length === 0 && imports.length === 0) {
    // Extension-based fallback for test files already handled above via name patterns
    // Use directory path for additional context
    const dirName = path.basename(path.dirname(filePath));
    const pathHints: Record<string, string> = {
      middleware: "Middleware module",
      hooks: "Hook module",
      utils: "Utility module",
      helpers: "Helper module",
      constants: "Constants module",
      types: "Type definitions module",
      components: "UI component",
      services: "Service module",
      models: "Data model",
      lib: "Library module",
      config: "Configuration module",
      scripts: "Script",
      api: "API handler",
      routes: "Route handler",
      pages: "Page component",
      layouts: "Layout component",
      store: "State store",
      stores: "State store",
    };
    const hint = pathHints[dirName.toLowerCase()];
    if (hint) parts.push(hint);
  }

  if (parts.length === 0) return null;
  // Capitalize first letter
  const desc = parts.join(". ");
  return desc.charAt(0).toUpperCase() + desc.slice(1) + ".";
}

// ─── Auto-generate directory description ────────────────────────────────────
function generateDirDescription(dirPath: string, stats: { files: number; size: number; lines: number; langs: Map<string, number> }, rootDir: string): string {
  const name = path.basename(dirPath);
  const topLangs = Array.from(stats.langs.entries()).sort((a, b) => b[1] - a[1]);
  const langStr = topLangs.slice(0, 2).map(([l]) => l).join(" and ");

  // Check what files are in this direct directory
  const dirFiles = fs.readdirSync(dirPath, { withFileTypes: true });
  const fileNames = dirFiles.filter(e => e.isFile()).map(e => e.name);
  const subDirs = dirFiles.filter(e => e.isDirectory() && !SKIP_DIRS.has(e.name)).map(e => e.name);

  // Try to infer purpose from directory name
  const nameHints: Record<string, string> = {
    src: "Source code",
    lib: "Library modules",
    server: "Server-side logic",
    client: "Client-side code",
    dashboard: "Dashboard UI",
    api: "API endpoints",
    components: "UI components",
    utils: "Utility functions",
    helpers: "Helper functions",
    types: "Type definitions",
    models: "Data models",
    services: "Service layer",
    middleware: "Middleware",
    routes: "Route definitions",
    config: "Configuration",
    scripts: "Build/utility scripts",
    test: "Test suites",
    tests: "Test suites",
    __tests__: "Test suites",
    docs: "Documentation",
    guide: "Guides and tutorials",
    tools: "Tool documentation",
    database: "Database utilities",
    db: "Database layer",
    public: "Static assets",
    assets: "Assets and resources",
    styles: "Stylesheets",
  };

  const hint = nameHints[name.toLowerCase()];
  const parts: string[] = [];

  if (hint) parts.push(hint);

  if (langStr && !hint) parts.push(`${langStr} modules`);

  if (subDirs.length) {
    parts.push(`contains ${subDirs.join(", ")}`);
  }

  parts.push(`${stats.files} file${stats.files !== 1 ? "s" : ""}, ${stats.lines.toLocaleString()} lines`);

  return parts.join(". ") + ".";
}

// ─── Main indexer ────────────────────────────────────────────────────────────
/**
 * Directories index_directory is permitted to read. Defaults to the process
 * working directory; CODE_CONTEXT_ALLOWED_ROOTS (comma-separated absolute
 * paths) adds more. Prevents an untrusted caller (e.g. the unauthenticated
 * dashboard API) from indexing arbitrary locations like ~/.ssh or /etc (#14).
 */
function allowedIndexRoots(): string[] {
  const roots = [process.cwd()];
  const env = process.env.CODE_CONTEXT_ALLOWED_ROOTS;
  if (env && env.trim()) {
    for (const p of env.split(",")) {
      const trimmed = p.trim();
      if (trimmed) roots.push(path.resolve(trimmed));
    }
  }
  return roots;
}

interface FileStatements {
  upsertFile: Database.Statement;
  getFileId: Database.Statement;
  getDescription: Database.Statement;
  setDescription: Database.Statement;
  clearExports: Database.Statement;
  insertExport: Database.Statement;
  clearDeps: Database.Statement;
  insertDep: Database.Statement;
  setExternals: Database.Statement;
  phpDeclared: Database.Statement;
}

function prepareFileStatements(db: Database.Database): FileStatements {
  return {
    upsertFile: db.prepare(`
      INSERT INTO files (path, language, extension, size_bytes, line_count, summary, external_imports, import_lines, content, created_at, modified_at, indexed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(path) DO UPDATE SET
        language=excluded.language, extension=excluded.extension,
        size_bytes=excluded.size_bytes, line_count=excluded.line_count,
        summary=excluded.summary, external_imports=excluded.external_imports,
        import_lines=excluded.import_lines, content=excluded.content,
        created_at=excluded.created_at, modified_at=excluded.modified_at,
        indexed_at=excluded.indexed_at
    `),
    getFileId: db.prepare(`SELECT id FROM files WHERE path = ?`),
    getDescription: db.prepare(`SELECT description FROM files WHERE id = ?`),
    setDescription: db.prepare(`UPDATE files SET description = ? WHERE id = ?`),
    clearExports: db.prepare(`DELETE FROM exports WHERE file_id = ?`),
    insertExport: db.prepare(`INSERT INTO exports (file_id, name, kind, description, signature, line) VALUES (?, ?, ?, ?, ?, ?)`),
    clearDeps: db.prepare(`DELETE FROM dependencies WHERE source_id = ?`),
    insertDep: db.prepare(`INSERT OR IGNORE INTO dependencies (source_id, target_id, symbols) VALUES (?, ?, ?)`),
    setExternals: db.prepare(`UPDATE files SET external_imports = ? WHERE id = ?`),
    // PHP exports keep the namespace-qualified name in exports.description (CCA-16)
    phpDeclared: db.prepare(
      `SELECT f.path, e.name, e.kind FROM exports e JOIN files f ON f.id = e.file_id
       WHERE e.name = ? AND e.description = ? AND f.extension = '.php' ORDER BY f.path LIMIT 5`,
    ),
  };
}

/** The index as PhpResolver sees it: indexed paths and PHP declarations by qualified name. */
export function phpLookup(db: Database.Database): PhpLookup {
  return phpLookupFrom(prepareFileStatements(db));
}

/**
 * Upsert one file row and its exports. Returns its line count and export
 * count, or null when the file is unreadable or binary (no row written).
 */
function storeFile(st: FileStatements, filePath: string, rootDir: string, aliases: AliasResolver): { lines: number; exports: number; content: string } | null {
  const ext = path.extname(filePath).toLowerCase();
  const lang = LANG_MAP[ext] ?? "unknown";
  let meta: ReturnType<typeof getFileMeta>;
  try { meta = getFileMeta(filePath); } catch { return null; }
  const content = readText(filePath);
  if (content === null) return null;

  const lineCount = countLines(content);
  const summary = extractSummary(content, filePath, ext);

  let externals: string | null = null;
  // PHP: parsed once; edges and exact externals follow in storeDeps (phase 2),
  // here the externals are the use/qualified names outside the project's PSR-4
  // prefixes (enough for the auto description).
  const php: PhpParse | null = ext === PHP_EXTENSION ? parsePhp(content) : null;
  if (php) {
    const resolver = new PhpResolver(rootDir, { isIndexed: () => false, declared: () => [] });
    externals = [...new Set(php.refs.map((r) => resolver.externalOf(r, filePath)).filter((x): x is string => !!x))].sort().join(", ") || null;
  } else if (PARSEABLE_EXTENSIONS.has(ext)) {
    externals = extractExternalImports(parseImports(content), filePath, aliases).join(", ") || null;
  } else if (PYTHON_EXTENSIONS.has(ext)) {
    externals = extractPythonExternalPackages(content, filePath, rootDir).join(", ") || null;
  }

  const imports = php ? serializeImportLines(php.useLines) : isParsedExtension(ext) ? serializeImportLines(importLines(content, ext)) : null;
  st.upsertFile.run(filePath, lang, ext, meta.sizeBytes, lineCount, summary, externals, imports, content, meta.createdAt, meta.modifiedAt);
  const row = st.getFileId.get(filePath) as { id: number };

  // Auto-generate description if none set manually
  const existing = st.getDescription.get(row.id) as { description: string | null };
  if (!existing.description) {
    const autoDesc = generateFileDescription(filePath, lang, ext, lineCount, content, summary, externals);
    if (autoDesc) st.setDescription.run(autoDesc, row.id);
  }

  st.clearExports.run(row.id);
  let exportCount = 0;
  if (php) {
    // name = short name (graph symbols, find_symbol); description = qualified name
    for (const e of php.exports) st.insertExport.run(row.id, e.name, e.kind, e.fqn, e.signature, e.line);
    return { lines: lineCount, exports: php.exports.length, content };
  }
  const details = isParsedExtension(ext) ? exportDetails(content, ext) : new Map();
  for (const exp of parseFileExports(content, ext)) {
    const d = details.get(exp.name);
    st.insertExport.run(row.id, exp.name, exp.kind, exp.description, d?.signature ?? null, d?.line ?? null);
    exportCount++;
  }
  return { lines: lineCount, exports: exportCount, content };
}

/** Rebuild the outgoing dependency edges of one JS/TS, Python or PHP file. */
function storeDeps(st: FileStatements, filePath: string, content: string, rootDir: string, aliases: AliasResolver, php?: PhpResolver): number {
  const ext = path.extname(filePath).toLowerCase();
  if (!isParsedExtension(ext)) return 0;
  const sourceRow = st.getFileId.get(filePath) as { id: number } | undefined;
  if (!sourceRow) return 0;
  st.clearDeps.run(sourceRow.id);
  if (ext === PHP_EXTENSION) {
    const resolver = php ?? new PhpResolver(rootDir, phpLookupFrom(st));
    const { edges, externals } = phpEdges(parsePhp(content), filePath, resolver);
    st.setExternals.run(externals.join(", ") || null, sourceRow.id);
    let n = 0;
    for (const [target, e] of edges) {
      const targetRow = st.getFileId.get(target) as { id: number } | undefined;
      if (!targetRow || targetRow.id === sourceRow.id) continue;
      st.insertDep.run(sourceRow.id, targetRow.id, [...e.symbols].join(", "));
      n++;
    }
    return n;
  }
  // One edge per target (UNIQUE(source_id, target_id)): every statement that
  // reaches the same file adds its symbols to that edge, in source order.
  const byTarget = new Map<number, Set<string>>();
  for (const imp of parseFileImports(content, ext)) {
    const targets = PYTHON_EXTENSIONS.has(ext)
      ? resolvePythonImportTargets(imp.source, imp.symbols, filePath, rootDir, imp.fromImport !== false)
      : [resolveImportPath(imp.source, filePath, rootDir, aliases)].filter((t): t is string => !!t);
    for (const resolved of targets) {
      const targetRow = st.getFileId.get(resolved) as { id: number } | undefined;
      if (!targetRow || targetRow.id === sourceRow.id) continue;
      const syms = byTarget.get(targetRow.id) ?? new Set<string>();
      for (const s of imp.symbols) syms.add(s);
      byTarget.set(targetRow.id, syms);
    }
  }
  for (const [targetId, syms] of byTarget) st.insertDep.run(sourceRow.id, targetId, [...syms].join(", "));
  return byTarget.size;
}

function phpLookupFrom(st: FileStatements): PhpLookup {
  return {
    isIndexed: (p) => st.getFileId.get(p) !== undefined,
    declared: (fqn) => st.phpDeclared.all(fqn.slice(fqn.lastIndexOf("\\") + 1), fqn) as Array<{ path: string; name: string; kind: string }>,
  };
}

/** Delete file rows (and their exports/edges) by path. Returns rows removed. */
export function removeFiles(db: Database.Database, paths: Iterable<string>): number {
  const getId = db.prepare(`SELECT id FROM files WHERE path = ?`);
  const delExports = db.prepare(`DELETE FROM exports WHERE file_id = ?`);
  const delDeps = db.prepare(`DELETE FROM dependencies WHERE source_id = ? OR target_id = ?`);
  const delFile = db.prepare(`DELETE FROM files WHERE id = ?`);
  let n = 0;
  db.transaction(() => {
    for (const p of paths) {
      const row = getId.get(p) as { id: number } | undefined;
      if (!row) continue;
      delExports.run(row.id);
      delDeps.run(row.id, row.id);
      delFile.run(row.id);
      n++;
    }
  })();
  return n;
}

/**
 * Bring a handful of files up to date without walking their repo: re-read the
 * ones that exist and pass the policy, drop the ones that are gone or now
 * denied. Changes land in the change log like a full index would log them.
 * `rootDir` bounds import resolution and the policy's ancestor check.
 */
export function refreshFiles(
  db: Database.Database,
  filePaths: string[],
  rootDir: string,
  isIgnored?: (file: string) => boolean,
): { reindexed: number; dropped: number } {
  // Rows are keyed by realpath (CCA-01): a caller may hand in the root or the
  // files under their symlinked spelling; both are rebased onto the realpath.
  const lexRoot = path.resolve(rootDir);
  let root: string;
  try { root = fs.realpathSync(lexRoot); } catch { return { reindexed: 0, dropped: 0 }; }
  const realRoot = root;
  const rebase = (p: string): string => {
    const abs = path.resolve(p);
    if (isPathInside(abs, root)) return abs;
    return isPathInside(abs, lexRoot) ? path.join(root, path.relative(lexRoot, abs)) : abs;
  };
  const unique = Array.from(new Set(filePaths.map(rebase))).filter((p) => isPathInside(p, root));
  if (unique.length === 0) return { reindexed: 0, dropped: 0 };
  const before = snapshotFromDb(db, { paths: unique });
  const st0 = prepareFileStatements(db);
  const aliases = new AliasResolver(root);
  const keep: { path: string; content: string }[] = [];
  const drop: string[] = [];
  db.transaction(() => {
    for (const p of unique) {
      // One gate for every index write (admitFile): normalisation, deny list on
      // every segment of the lexical AND the resolved path, no symlinks,
      // realpath containment. Drop only on evidence; `unreadable` (EACCES,
      // EBUSY, mid-write) keeps the existing row — a stale answer beats a
      // silently missing file.
      const adm = admitFile(p, root, realRoot);
      if (!adm.ok) { if (adm.reason !== "unreadable") drop.push(p); continue; }
      if (isIgnored?.(p)) { drop.push(p); continue; }
      const stored = storeFile(st0, p, root, aliases);
      if (stored) keep.push({ path: p, content: stored.content });
      else if (readText(p) === null && fs.existsSync(p) && isBinaryOnDisk(p)) drop.push(p);
    }
    const php = new PhpResolver(root, phpLookupFrom(st0));
    for (const k of keep) storeDeps(st0, k.path, k.content, root, aliases, php);
  })();
  const dropped = removeFiles(db, drop);
  diffAndLogChanges(db, before, snapshotFromDb(db, { paths: unique }));
  return { reindexed: keep.length, dropped };
}

/** Remember the commit a repo root was indexed at (null for non-git roots). */
export function recordIndexedRoot(db: Database.Database, rootDir: string, head: string | null, fileCount: number): void {
  db.prepare(`
    INSERT INTO indexed_repos (root, head, indexed_at, file_count) VALUES (?, ?, datetime('now'), ?)
    ON CONFLICT(root) DO UPDATE SET head=excluded.head, indexed_at=excluded.indexed_at, file_count=excluded.file_count
  `).run(realPathOf(rootDir), head, fileCount);
}

/** realpath of `p`, or `p` resolved when it cannot be resolved (missing, EACCES). */
export function realPathOf(p: string): string {
  try { return fs.realpathSync(p); } catch { return path.resolve(p); }
}

/**
 * Move every row stored under `fromRoot` (an unresolved spelling, e.g.
 * /var/folders/…) to the same path under `toRoot` (its realpath). Databases
 * written before 2.12 keyed rows by the root as given; without this a
 * re-index would add a second, differently-spelled row per file. When the
 * realpath row already exists the old row is dropped (same file, newer row
 * wins). Manual descriptions and change history move with their rows.
 * Returns the number of file rows moved or dropped.
 */
export function rebaseIndexedRoot(db: Database.Database, fromRoot: string, toRoot: string): number {
  const from = path.resolve(fromRoot);
  const to = path.resolve(toRoot);
  if (from === to) return 0;
  const prefix = from + path.sep;
  const moved = (p: string): string => (p === from ? to : to + p.slice(from.length));
  const under = `path = ? OR substr(path, 1, ?) = ?`;
  let n = 0;
  db.transaction(() => {
    const fileRows = db.prepare(`SELECT id, path FROM files WHERE ${under}`).all(from, prefix.length, prefix) as { id: number; path: string }[];
    const exists = db.prepare(`SELECT id FROM files WHERE path = ?`);
    const setPath = db.prepare(`UPDATE files SET path = ? WHERE id = ?`);
    const dupes: string[] = [];
    for (const r of fileRows) {
      const target = moved(r.path);
      if (exists.get(target)) dupes.push(r.path);
      else setPath.run(target, r.id);
      n++;
    }
    removeFiles(db, dupes);

    const dirRows = db.prepare(`SELECT id, path, parent_path FROM directories WHERE ${under}`).all(from, prefix.length, prefix) as { id: number; path: string; parent_path: string | null }[];
    const dirExists = db.prepare(`SELECT id FROM directories WHERE path = ?`);
    const setDir = db.prepare(`UPDATE directories SET path = ?, parent_path = ? WHERE id = ?`);
    const delDir = db.prepare(`DELETE FROM directories WHERE id = ?`);
    for (const d of dirRows) {
      const target = moved(d.path);
      const parent = d.parent_path && (d.parent_path === from || d.parent_path.startsWith(prefix)) ? moved(d.parent_path) : d.parent_path;
      if (dirExists.get(target)) delDir.run(d.id);
      else setDir.run(target, parent, d.id);
    }

    db.prepare(`UPDATE changes SET file_path = ? || substr(file_path, ?) WHERE substr(file_path, 1, ?) = ?`)
      .run(to, from.length + 1, prefix.length, prefix);

    const repo = db.prepare(`SELECT root FROM indexed_repos WHERE root = ?`);
    if (repo.get(from)) {
      if (repo.get(to)) db.prepare(`DELETE FROM indexed_repos WHERE root = ?`).run(from);
      else db.prepare(`UPDATE indexed_repos SET root = ? WHERE root = ?`).run(to, from);
    }
  })();
  return n;
}

/**
 * Boot-time migration: every indexed root stored under a spelling that is not
 * its realpath is rebased onto the realpath (rebaseIndexedRoot). Roots that no
 * longer exist are left alone (reindex --prune-missing owns those).
 */
export function migrateUnresolvedRoots(db: Database.Database): { roots: number; files: number } {
  let roots: { root: string }[];
  try { roots = db.prepare(`SELECT root FROM indexed_repos`).all() as { root: string }[]; } catch { return { roots: 0, files: 0 }; }
  const out = { roots: 0, files: 0 };
  for (const { root } of roots) {
    let real: string;
    try { real = fs.realpathSync(root); } catch { continue; }
    if (real === root) continue;
    out.files += rebaseIndexedRoot(db, root, real);
    out.roots++;
  }
  return out;
}

export function indexDirectory(db: Database.Database, dirPath: string): { files: number; exports: number; deps: number; prunedFiles: number; prunedDirs: number; root: string } {
  let rootDir = path.resolve(dirPath);
  const roots = allowedIndexRoots();
  // Lexical AND resolved: a symlinked root pointing outside the sandbox is refused.
  const realOf = (p: string): string => { try { return fs.realpathSync(p); } catch { return p; } };
  const realRootDir = realOf(rootDir);
  // The given path may use either spelling of an allowed root (/var/… or
  // /private/var/…): agents pass the realpath they resolved their cwd to.
  if (!roots.some(r => (isPathInside(rootDir, r) || isPathInside(rootDir, realOf(r))) && isPathInside(realRootDir, realOf(r)))) {
    throw new Error(
      `Refusing to index '${rootDir}': outside the allowed sandbox. ` +
        `Allowed roots: ${roots.join(", ")}. Set CODE_CONTEXT_ALLOWED_ROOTS ` +
        `(comma-separated absolute paths) to permit additional locations.`,
    );
  }
  if (!fs.existsSync(rootDir)) throw new Error(`Directory not found: ${rootDir}`);
  const stat = fs.statSync(rootDir);
  if (!stat.isDirectory()) throw new Error(`Path is not a directory: ${rootDir}`);
  // Store the realpath (CCA-01): a symlinked root and its target index
  // identically, and agents that resolve their cwd can read the paths back.
  // Rows from an older index under the symlinked spelling move over first.
  if (realRootDir !== rootDir) {
    rebaseIndexedRoot(db, rootDir, realRootDir);
    rootDir = realRootDir;
  }

  // HEAD is read before the listing: a commit landing mid-index then shows up
  // as a HEAD change on the next read and gets diffed, never silently skipped.
  const head = isGitCheckout(rootDir) ? readGitHead(rootDir) : null;

  // Snapshot before indexing (reads old content from DB), scoped to this root
  const before = snapshotFromDb(db, { root: rootDir });

  const candidates = listIndexableFiles(rootDir);
  const st = prepareFileStatements(db);
  const aliases = new AliasResolver(rootDir);

  let exportCount = 0;
  let depCount = 0;
  const filePaths: string[] = [];
  const lineCounts = new Map<string, number>();

  // Phase 1: index all files
  db.transaction(() => {
    for (const filePath of candidates) {
      const stored = storeFile(st, filePath, rootDir, aliases);
      if (!stored) continue;
      filePaths.push(filePath);
      lineCounts.set(filePath, stored.lines);
      exportCount += stored.exports;
    }
  })();

  // Phase 2: resolve dependencies (JS/TS, Python and PHP)
  const php = new PhpResolver(rootDir, phpLookupFrom(st));
  db.transaction(() => {
    for (const filePath of filePaths) {
      if (!isParsedExtension(path.extname(filePath).toLowerCase())) continue;
      const content = readText(filePath);
      if (content === null) continue;
      depCount += storeDeps(st, filePath, content, rootDir, aliases, php);
    }
  })();

  // Phase 3: index directories
  const seenDirs = new Set<string>();
  const indexDirs = db.transaction(() => {
    const upsertDir = db.prepare(`
      INSERT INTO directories (path, name, parent_path, depth, file_count, total_size_bytes, total_lines, language_breakdown, indexed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(path) DO UPDATE SET
        name=excluded.name, parent_path=excluded.parent_path, depth=excluded.depth,
        file_count=excluded.file_count, total_size_bytes=excluded.total_size_bytes,
        total_lines=excluded.total_lines, language_breakdown=excluded.language_breakdown,
        indexed_at=excluded.indexed_at
    `);

    // Collect all unique directories from file paths
    const dirMap = new Map<string, { files: number; size: number; lines: number; langs: Map<string, number> }>();
    for (const filePath of filePaths) {
      let dir = path.dirname(filePath);
      const ext = path.extname(filePath).toLowerCase();
      const lang = LANG_MAP[ext] ?? "unknown";
      let size = 0;
      try { size = fs.statSync(filePath).size; } catch { /* vanished mid-index */ }
      const lineCount = lineCounts.get(filePath) ?? 0;

      // Walk up from the file's directory to the root, aggregating stats
      while (dir.length >= rootDir.length) {
        if (!dirMap.has(dir)) {
          dirMap.set(dir, { files: 0, size: 0, lines: 0, langs: new Map() });
        }
        const entry = dirMap.get(dir)!;
        entry.files++;
        entry.size += size;
        entry.lines += lineCount;
        entry.langs.set(lang, (entry.langs.get(lang) ?? 0) + 1);

        if (dir === rootDir) break;
        dir = path.dirname(dir);
      }
    }

    for (const [dirPath, stats] of dirMap) {
      seenDirs.add(dirPath);
      const name = path.basename(dirPath);
      const parentPath = dirPath === rootDir ? null : path.dirname(dirPath);
      const depth = dirPath === rootDir ? 0 : dirPath.slice(rootDir.length + 1).split(path.sep).length;
      const langBreakdown = JSON.stringify(
        Array.from(stats.langs.entries())
          .sort((a, b) => b[1] - a[1])
          .map(([lang, count]) => ({ lang, count }))
      );
      upsertDir.run(dirPath, name, parentPath, depth, stats.files, stats.size, stats.lines, langBreakdown);

      // Auto-generate description if none set manually
      const existingDir = db.prepare(`SELECT description FROM directories WHERE path = ?`).get(dirPath) as { description: string | null } | undefined;
      if (!existingDir?.description) {
        const autoDesc = generateDirDescription(dirPath, stats, rootDir);
        db.prepare(`UPDATE directories SET description = ? WHERE path = ?`).run(autoDesc, dirPath);
      }
    }
  });
  indexDirs();

  // Phase 3.5: prune rows whose files/directories vanished from disk — or are
  // now excluded by the policy or a .gitignore, which is the same thing from
  // the index's point of view. Scoped to rootDir — indexing a subdirectory
  // must never evict sibling rows outside it. Child rows are deleted explicitly
  // so pruning does not depend on the caller's foreign_keys pragma. Runs before
  // the Phase-4 snapshot so pruned files land in the changes log as "delete".
  const seenFiles = new Set(filePaths);
  const pruned = { files: 0, dirs: 0 };
  const prefix = rootDir.endsWith(path.sep) ? rootDir : rootDir + path.sep;
  const fileRows = db.prepare(`SELECT path FROM files WHERE substr(path, 1, ?) = ?`).all(prefix.length, prefix) as { path: string }[];
  db.transaction(() => {
    pruned.files = removeFiles(db, fileRows.map(r => r.path).filter(p => !seenFiles.has(p)));
    const dirRows = db.prepare(`SELECT id, path FROM directories`).all() as { id: number; path: string }[];
    const deleteDir = db.prepare(`DELETE FROM directories WHERE id = ?`);
    for (const row of dirRows) {
      if (!isPathInside(row.path, rootDir) || seenDirs.has(row.path)) continue;
      deleteDir.run(row.id);
      pruned.dirs++;
    }
  })();

  // Phase 4: diff and log changes (after snapshot reads new content from DB)
  const after = snapshotFromDb(db, { root: rootDir });
  diffAndLogChanges(db, before, after);

  recordIndexedRoot(db, rootDir, head, filePaths.length);

  return { files: filePaths.length, exports: exportCount, deps: depCount, prunedFiles: pruned.files, prunedDirs: pruned.dirs, root: rootDir };
}
