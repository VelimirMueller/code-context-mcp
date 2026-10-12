/**
 * PHP structure for the code index (CCA-16, #148): declarations, `use`
 * imports and the class references that become dependency edges.
 *
 * There is no PHP runtime and no AST here. Two passes, both linear:
 *   1. stripPhp: a small state machine blanks comments, strings, heredoc /
 *      nowdoc bodies and inline HTML to spaces (newlines kept), so offsets and
 *      line numbers stay valid and nothing inside a comment or a string can
 *      create an export or an edge.
 *   2. a tokenizer + one pass over the tokens: namespace, `use` (grouped,
 *      aliased, `use function`, `use const`), class / interface / trait / enum
 *      / function / const declarations, `extends`, `implements`, trait `use`,
 *      and class references in code (`new X`, `X::`, `instanceof`, `catch`,
 *      type hints, qualified `\A\B` names).
 *
 * Names are resolved the way PHP does: fully qualified as written, else
 * through the file's `use` aliases, else relative to the current namespace.
 * An unqualified, un-imported class name is a same-namespace guess: it becomes
 * an edge only when such a class is indexed, and never an external package.
 *
 * Files are found through the nearest composer.json `autoload` /
 * `autoload-dev` PSR-4 maps (paths relative to that composer.json, every
 * composer.json up to the index root is tried), then through the indexed
 * declarations themselves (classmap, `files` helpers, functions, constants).
 */
import fs from "node:fs";
import path from "node:path";
import { oneLine, MAX_STORED_IMPORT_LINES, type ImportLine } from "./signatures.js";

export type PhpRefKind = "class" | "function" | "const";

export interface PhpExport {
  /** Short name (`OrderService`), what find_symbol and edge symbols match. */
  name: string;
  /** Namespace-qualified name without a leading backslash (`App\Services\OrderService`). */
  fqn: string;
  kind: "class" | "interface" | "trait" | "enum" | "function" | "const";
  signature: string;
  line: number;
}

export interface PhpRef {
  fqn: string;
  kind: PhpRefKind;
  line: number;
  /** True for a name taken from a top-level `use` statement. */
  fromUse: boolean;
  /** Unqualified, un-imported name: a same-namespace (or global) guess. */
  tentative: boolean;
}

export interface PhpParse {
  /** Namespace of the first declaration (or the last `namespace` seen). */
  namespace: string;
  exports: PhpExport[];
  /** Top-level `use` statements, one line each (files.import_lines). */
  useLines: ImportLine[];
  refs: PhpRef[];
}

// ─── Pass 1: blank comments, strings and inline HTML ─────────────────────────

const OPEN_TAG = /<\?(?:php\b|=)/gi;
const INTERESTING = /[?#/'"`<]/g;
const HEREDOC_START = /<<<[ \t]*(["']?)([A-Za-z_\x80-\uffff][\w\x80-\uffff]*)\1\r?\n/y;

/** End (exclusive) of a single-quoted string starting at `i`. */
function skipSingle(src: string, i: number): number {
  const n = src.length;
  let j = i + 1;
  while (j < n) {
    const c = src[j];
    if (c === "\\") j += 2;
    else if (c === "'") return j + 1;
    else j++;
  }
  return n;
}

/**
 * End (exclusive) of a double-quoted or backtick string starting at `i`.
 * `{$…}` / `${…}` interpolation may hold nested quotes (`"{$a["k"]}"`), so it
 * is skipped with its own brace depth.
 */
function skipDouble(src: string, i: number, quote: string): number {
  const n = src.length;
  let j = i + 1;
  while (j < n) {
    const c = src[j];
    if (c === "\\") { j += 2; continue; }
    if (c === quote) return j + 1;
    if ((c === "{" && src[j + 1] === "$") || (c === "$" && src[j + 1] === "{")) {
      let depth = 1;
      j += 2;
      while (j < n && depth > 0) {
        const d = src[j];
        if (d === "'") j = skipSingle(src, j);
        else if (d === '"') j = skipDouble(src, j, '"');
        else { if (d === "{") depth++; else if (d === "}") depth--; j++; }
      }
      continue;
    }
    j++;
  }
  return n;
}

/**
 * The source with every comment, string literal, heredoc/nowdoc and inline
 * HTML (outside `<?php … ?>`) replaced by spaces. Newlines are kept and the
 * length is unchanged, so a position in the result is a position in `src`.
 * PHP 8 attributes (`#[…]`) are code, not comments, and stay.
 */
export function stripPhp(src: string): string {
  const n = src.length;
  const parts: string[] = [];
  const keep = (a: number, b: number) => { if (b > a) parts.push(src.slice(a, b)); };
  const blank = (a: number, b: number) => { if (b > a) parts.push(src.slice(a, b).replace(/[^\n]/g, " ")); };
  /** Blank inline HTML from `from` through the next open tag; returns where PHP resumes. */
  const html = (from: number): number => {
    OPEN_TAG.lastIndex = from;
    const m = OPEN_TAG.exec(src);
    const end = m ? m.index + m[0].length : n;
    blank(from, end);
    return end;
  };

  let i = html(0);
  let code = i; // start of the current run of code
  while (i < n) {
    INTERESTING.lastIndex = i;
    const m = INTERESTING.exec(src);
    if (!m) break;
    i = m.index;
    const c = src[i];
    const next = src[i + 1];
    let end = -1;
    if (c === "?" && next === ">") {
      keep(code, i);
      i = html(i);
      code = i;
      continue;
    } else if ((c === "#" && next !== "[") || (c === "/" && next === "/")) {
      // line comment: ends at the newline or before a closing tag
      let j = i;
      while (j < n && src[j] !== "\n" && !(src[j] === "?" && src[j + 1] === ">")) j++;
      end = j;
    } else if (c === "/" && next === "*") {
      const e = src.indexOf("*/", i + 2);
      end = e < 0 ? n : e + 2;
    } else if (c === "'") {
      end = skipSingle(src, i);
    } else if (c === '"' || c === "`") {
      end = skipDouble(src, i, c);
    } else if (c === "<" && next === "<" && src[i + 2] === "<") {
      HEREDOC_START.lastIndex = i;
      const h = HEREDOC_START.exec(src);
      if (h) {
        // PHP 7.3+: the closing marker may be indented and followed by `;`, `,`, `)`…
        const close = new RegExp(String.raw`^[ \t]*${h[2]}(?![\w\x80-\uffff])`, "gm");
        close.lastIndex = i + h[0].length;
        const cm = close.exec(src);
        end = cm ? cm.index + cm[0].length : n;
      }
    }
    if (end < 0) { i++; continue; }
    keep(code, i);
    blank(i, end);
    i = end;
    code = i;
  }
  keep(code, n);
  return parts.join("");
}

// ─── Pass 2: tokens and declarations ─────────────────────────────────────────

const NAME_CHARS = String.raw`[A-Za-z_\x80-\uffff][\w\x80-\uffff]*`;
// name (optionally qualified / fully qualified) | $var | punctuation the parser needs | number
const TOKEN = new RegExp(
  String.raw`(\\?${NAME_CHARS}(?:\\${NAME_CHARS})*)|(\$+${NAME_CHARS})|(::|\?->|->|=>|[{}()\[\];,:|&?=])|(\d[\w.]*)`,
  "g",
);

const enum T { Name, Var, Punct, Num }
interface Tok { t: T; s: string; pos: number }

function tokenize(code: string): Tok[] {
  const out: Tok[] = [];
  TOKEN.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TOKEN.exec(code)) !== null) {
    const t = m[1] !== undefined ? T.Name : m[2] !== undefined ? T.Var : m[3] !== undefined ? T.Punct : T.Num;
    out.push({ t, s: m[0], pos: m.index });
  }
  return out;
}

/** Names that are never a class reference (compared lower-case). */
const NOT_A_CLASS = new Set([
  "self", "static", "parent", "true", "false", "null", "array", "callable", "iterable", "object",
  "mixed", "void", "never", "bool", "boolean", "int", "integer", "float", "double", "string", "list",
  "class", "interface", "trait", "enum", "function", "fn", "new", "clone", "instanceof", "insteadof",
  "namespace", "use", "as", "const", "case", "default", "match", "yield", "from", "and", "or", "xor",
]);
/** Constructs followed by `(` that are not function calls. */
const NOT_A_FUNCTION = new Set([
  "if", "elseif", "while", "for", "foreach", "switch", "match", "array", "list", "isset", "unset",
  "empty", "eval", "exit", "die", "include", "include_once", "require", "require_once", "print",
  "echo", "return", "fn", "function", "declare", "catch", "new", "clone", "yield", "static", "self",
  "parent", "and", "or", "xor", "instanceof", "global", "use", "as", "class", "enum",
]);
const MODIFIERS = new Set(["abstract", "final", "readonly"]);
const CLASS_LIKE = new Set(["class", "interface", "trait", "enum"]);

const isStudly = (s: string): boolean => /^[A-Z]/.test(s) && /[a-z]/.test(s);
const lastSegment = (fqn: string): string => fqn.slice(fqn.lastIndexOf("\\") + 1);
const qualify = (ns: string, name: string): string => (ns ? `${ns}\\${name}` : name);

/** 1-based line of `pos`, via a precomputed table of line starts. */
function lineFinder(content: string): (pos: number) => number {
  const starts = [0];
  for (let i = content.indexOf("\n"); i >= 0; i = content.indexOf("\n", i + 1)) starts.push(i + 1);
  return (pos: number) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= pos) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
}

/**
 * Parse one PHP file: its declarations (exports), its top-level `use` lines,
 * and every class / function / constant it references, resolved to fully
 * qualified names by PHP's rules. Comments, strings and inline HTML never
 * contribute (stripPhp).
 */
export function parsePhp(content: string): PhpParse {
  const code = stripPhp(content);
  const toks = tokenize(code);
  const lineOf = lineFinder(content);
  const exports: PhpExport[] = [];
  const useLines: ImportLine[] = [];
  const refs: PhpRef[] = [];
  const seenRefs = new Set<string>();

  let ns = "";
  let firstNs: string | null = null;
  let nsDepth = 0; // brace depth of top-level statements (1 inside `namespace X { … }`)
  let depth = 0;
  let classAliases = new Map<string, string>();
  let fnAliases = new Map<string, string>();
  let constAliases = new Map<string, string>();
  const classBodies: number[] = []; // depth inside each open class-like body
  let pendingClass = false; // a class header is open: the next `{` starts its body

  const addRef = (fqn: string, kind: PhpRefKind, pos: number, fromUse: boolean, tentative: boolean) => {
    if (!fqn) return;
    const key = `${kind}:${fqn.toLowerCase()}`;
    if (seenRefs.has(key)) {
      // a later `use` of a name first seen in code still marks it as imported
      if (fromUse) for (const r of refs) if (r.kind === kind && r.fqn.toLowerCase() === fqn.toLowerCase()) { r.fromUse = true; r.tentative = false; }
      return;
    }
    seenRefs.add(key);
    refs.push({ fqn, kind, line: lineOf(pos), fromUse, tentative });
  };

  /** Resolve a class name as written in code; null for self/static/parent and the like. */
  const resolveClass = (name: string): { fqn: string; tentative: boolean } | null => {
    if (name.startsWith("\\")) return { fqn: name.slice(1), tentative: false };
    if (NOT_A_CLASS.has(name.toLowerCase())) return null;
    if (/^namespace\\/i.test(name)) return { fqn: qualify(ns, name.slice(10)), tentative: false };
    const cut = name.indexOf("\\");
    const first = cut < 0 ? name : name.slice(0, cut);
    const alias = classAliases.get(first.toLowerCase());
    if (alias) return { fqn: cut < 0 ? alias : alias + name.slice(cut), tentative: false };
    return { fqn: qualify(ns, name), tentative: cut < 0 };
  };
  const classRef = (tok: Tok) => {
    const r = resolveClass(tok.s);
    if (r) addRef(r.fqn, "class", tok.pos, false, r.tentative);
  };
  const resolveMember = (name: string, aliases: Map<string, string>, kind: PhpRefKind, pos: number) => {
    if (name.startsWith("\\")) { if (name.indexOf("\\", 1) > 0) addRef(name.slice(1), kind, pos, false, false); return; }
    if (/^namespace\\/i.test(name)) { addRef(qualify(ns, name.slice(10)), kind, pos, false, false); return; }
    const cut = name.indexOf("\\");
    if (cut >= 0) {
      const alias = classAliases.get(name.slice(0, cut).toLowerCase());
      addRef(alias ? alias + name.slice(cut) : qualify(ns, name), kind, pos, false, false);
      return;
    }
    const alias = aliases.get(kind === "const" ? name : name.toLowerCase());
    if (alias) addRef(alias, kind, pos, false, false);
    else if (kind === "function") addRef(qualify(ns, name), kind, pos, false, true); // falls back to global
  };

  /** Parse `use …;` at tokens[i] (the `use`); returns the index of its `;`. */
  const parseUse = (i: number): number => {
    const start = toks[i].pos;
    let j = i + 1;
    let kind: PhpRefKind = "class";
    const add = (fqnRaw: string, k: PhpRefKind, alias: string | null, pos: number) => {
      const fqn = fqnRaw.replace(/^\\/, "");
      const as = alias ?? lastSegment(fqn);
      if (k === "class") classAliases.set(as.toLowerCase(), fqn);
      else if (k === "function") fnAliases.set(as.toLowerCase(), fqn);
      else constAliases.set(as, fqn);
      addRef(fqn, k, pos, true, false);
    };
    const kindAt = (k: number): PhpRefKind | null => {
      const s = toks[k]?.t === T.Name ? toks[k].s.toLowerCase() : "";
      return s === "function" ? "function" : s === "const" ? "const" : null;
    };
    const k0 = kindAt(j);
    if (k0 && toks[j + 1]?.t === T.Name) { kind = k0; j++; }
    while (j < toks.length && toks[j].s !== ";") {
      const tok = toks[j];
      if (tok.t !== T.Name) { j++; continue; }
      const prefix = tok.s;
      if (toks[j + 1]?.s === "{") {
        // grouped: use A\B\{C, D as E, function f, const G};
        j += 2;
        while (j < toks.length && toks[j].s !== "}" && toks[j].s !== ";") {
          let k = kind;
          const ki = kindAt(j);
          if (ki && toks[j + 1]?.t === T.Name) { k = ki; j++; }
          if (toks[j].t === T.Name) {
            const name = toks[j].s;
            let alias: string | null = null;
            if (toks[j + 1]?.s.toLowerCase() === "as" && toks[j + 2]?.t === T.Name) { alias = toks[j + 2].s; j += 2; }
            add(`${prefix.replace(/\\$/, "")}\\${name}`, k, alias, start);
          }
          j++;
        }
        if (toks[j]?.s === "}") j++;
        continue;
      }
      let alias: string | null = null;
      if (toks[j + 1]?.s.toLowerCase() === "as" && toks[j + 2]?.t === T.Name) { alias = toks[j + 2].s; add(prefix, kind, alias, start); j += 3; continue; }
      add(prefix, kind, alias, start);
      j++;
    }
    const endPos = j < toks.length ? toks[j].pos + 1 : content.length;
    if (useLines.length < MAX_STORED_IMPORT_LINES) useLines.push({ line: lineOf(start), text: oneLine(content.slice(start, endPos)) });
    return j;
  };

  /** Index of the `{` or `;` ending a header that starts at tokens[i], skipping (…) groups. */
  const headerEnd = (i: number): number => {
    let paren = 0;
    for (let j = i; j < toks.length; j++) {
      const s = toks[j].s;
      if (s === "(") paren++;
      else if (s === ")") paren--;
      else if (paren <= 0 && (s === "{" || s === ";")) return j;
    }
    return toks.length;
  };
  const sliceTo = (from: number, endTok: number): string =>
    oneLine(content.slice(from, endTok < toks.length ? toks[endTok].pos : content.length));

  const atTop = () => depth === nsDepth && classBodies.length === 0;

  for (let i = 0; i < toks.length; i++) {
    const tok = toks[i];
    const prev = toks[i - 1];
    const next = toks[i + 1];

    if (tok.t === T.Punct) {
      if (tok.s === "{") {
        depth++;
        if (pendingClass) { classBodies.push(depth); pendingClass = false; }
      } else if (tok.s === "}") {
        if (classBodies.length && classBodies[classBodies.length - 1] === depth) classBodies.pop();
        depth--;
        if (depth < nsDepth) nsDepth = depth; // end of a braced namespace
      }
      continue;
    }
    if (tok.t !== T.Name) continue;
    const lower = tok.s.toLowerCase();
    const afterMember = prev && (prev.s === "->" || prev.s === "?->" || prev.s === "::");
    if (afterMember) continue; // ->method, ::CONST, ::class: not a declaration or a class name

    // namespace X;  namespace X { … }  namespace { … }
    if (lower === "namespace" && depth === 0 && (next?.t === T.Name || next?.s === "{")) {
      if (next.t === T.Name) { ns = next.s.replace(/^\\/, ""); i++; } else ns = "";
      if (firstNs === null) firstNs = ns;
      classAliases = new Map();
      fnAliases = new Map();
      constAliases = new Map();
      if (toks[i + 1]?.s === "{") { depth++; nsDepth = depth; i++; }
      continue;
    }

    if (lower === "use" && next?.s !== "(") {
      if (classBodies.length && classBodies[classBodies.length - 1] === depth) {
        // trait use inside a class body: names until `;` or the `{` of an adaptation block
        let j = i + 1;
        for (; j < toks.length && toks[j].s !== ";" && toks[j].s !== "{"; j++) if (toks[j].t === T.Name) classRef(toks[j]);
        i = j - 1; // let the main loop see the `{` (depth tracking)
        continue;
      }
      if (depth === nsDepth && classBodies.length === 0) { i = parseUse(i); continue; }
      continue;
    }

    if (CLASS_LIKE.has(lower)) {
      const anonymous = lower === "class" && prev?.s.toLowerCase() === "new";
      const named = next?.t === T.Name && !NOT_A_CLASS.has(next.s.toLowerCase()) && !next.s.includes("\\");
      // `enum` is not reserved: only `enum Name {`, `enum Name:` or `enum Name implements` declare one
      const isDecl = lower !== "enum" || (named && ["{", ":"].includes(toks[i + 2]?.s ?? "") || toks[i + 2]?.s.toLowerCase() === "implements");
      if (!isDecl || (!named && !anonymous)) continue;
      pendingClass = true;
      const end = headerEnd(i);
      // extends / implements lists
      for (let j = i + 1; j < end; j++) {
        const w = toks[j].s.toLowerCase();
        if (w !== "extends" && w !== "implements") continue;
        for (j++; j < end && toks[j].t === T.Name && !["extends", "implements"].includes(toks[j].s.toLowerCase()); j++) {
          classRef(toks[j]);
          if (toks[j + 1]?.s !== ",") break;
          j++;
        }
      }
      if (named && atTop()) {
        let first = i;
        while (first > 0 && toks[first - 1].t === T.Name && MODIFIERS.has(toks[first - 1].s.toLowerCase())) first--;
        const name = next.s;
        exports.push({ name, fqn: qualify(ns, name), kind: lower as PhpExport["kind"], signature: sliceTo(toks[first].pos, end), line: lineOf(toks[first].pos) });
        if (firstNs === null) firstNs = ns;
      }
      i = (anonymous ? i : i + 1); // the header's names were handled; `{` comes through the loop
      continue;
    }

    if (lower === "function") {
      let j = i + 1;
      if (toks[j]?.s === "&") j++;
      const nameTok = toks[j];
      if (nameTok?.t === T.Name && toks[j + 1]?.s === "(") {
        if (classBodies.length === 0 && !nameTok.s.includes("\\")) {
          const end = headerEnd(j + 1);
          exports.push({ name: nameTok.s, fqn: qualify(ns, nameTok.s), kind: "function", signature: sliceTo(tok.pos, end), line: lineOf(tok.pos) });
        }
        i = j; // skip the name
      }
      continue;
    }

    if (lower === "const") {
      // `const NAME =` (a typed class constant puts a type first: `const string NAME =`)
      let j = i + 1;
      while (toks[j]?.t === T.Name && toks[j + 1]?.t === T.Name) j++;
      if (toks[j]?.t === T.Name && toks[j + 1]?.s === "=") {
        if (atTop()) {
          const end = headerEnd(j);
          exports.push({ name: toks[j].s, fqn: qualify(ns, toks[j].s), kind: "const", signature: sliceTo(tok.pos, end), line: lineOf(tok.pos) });
        }
        i = j;
      }
      continue;
    }

    if (lower === "new" || lower === "instanceof") {
      if (next?.t === T.Name && !CLASS_LIKE.has(next.s.toLowerCase())) { classRef(next); i++; }
      continue;
    }
    if (lower === "catch" && next?.s === "(") {
      let j = i + 2;
      for (; j < toks.length && toks[j].t === T.Name; j++) { classRef(toks[j]); if (toks[j + 1]?.s !== "|") break; j++; }
      i = j;
      continue;
    }
    if (prev && prev.t === T.Name && ["case", "goto", "as", "insteadof"].includes(prev.s.toLowerCase()) && next?.s !== "::") continue;

    // A name in code: Foo:: / type hint / attribute / call / constant.
    if (next?.s === "::") { classRef(tok); continue; }
    const qualified = tok.s.includes("\\");
    if (next?.s === "(") {
      if (!NOT_A_FUNCTION.has(lower)) resolveMember(tok.s, fnAliases, "function", tok.pos);
      continue;
    }
    if (next?.s === ":" && (prev?.s === "(" || prev?.s === ",")) continue; // named argument
    if (qualified) { classRef(tok); continue; }
    if (constAliases.has(tok.s)) { addRef(constAliases.get(tok.s)!, "const", tok.pos, false, false); continue; }
    if (isStudly(tok.s)) classRef(tok);
  }

  return { namespace: firstNs ?? ns, exports, useLines, refs };
}

// ─── Resolution: composer.json PSR-4, then the indexed declarations ─────────

interface Psr4Map {
  dir: string;
  /** prefix (`App\`, or "" for the fallback) → absolute base dirs; longest prefix first */
  entries: Array<{ prefix: string; dirs: string[] }>;
}

/** What the resolver needs from the index. */
export interface PhpLookup {
  /** True when this absolute path is an indexed file. */
  isIndexed(p: string): boolean;
  /** Indexed PHP declarations of this namespace-qualified name. */
  declared(fqn: string): Array<{ path: string; name: string; kind: string }>;
}

const CLASS_KINDS = new Set(["class", "interface", "trait", "enum"]);

function readPsr4(composerPath: string): Psr4Map | null {
  type Autoload = { "psr-4"?: Record<string, unknown> } | undefined;
  let json: { autoload?: Autoload; "autoload-dev"?: Autoload } | null;
  try { json = JSON.parse(fs.readFileSync(composerPath, "utf-8")); } catch { return null; }
  const dir = path.dirname(composerPath);
  const entries: Psr4Map["entries"] = [];
  for (const section of [json?.autoload?.["psr-4"], json?.["autoload-dev"]?.["psr-4"]]) {
    if (!section || typeof section !== "object") continue;
    for (const [rawPrefix, target] of Object.entries(section)) {
      const prefix = rawPrefix.replace(/^\\+/, "").replace(/\\*$/, rawPrefix ? "\\" : "");
      const dirs = (Array.isArray(target) ? target : [target]).filter((d): d is string => typeof d === "string").map((d) => path.resolve(dir, d));
      if (dirs.length) entries.push({ prefix: prefix === "\\" ? "" : prefix, dirs });
    }
  }
  entries.sort((a, b) => b.prefix.length - a.prefix.length);
  return { dir, entries };
}

/**
 * Resolves PHP references to indexed files. One instance per index run: it
 * caches composer.json maps per directory and declaration lookups per name.
 */
export class PhpResolver {
  private readonly chains = new Map<string, Psr4Map[]>();
  private readonly composers = new Map<string, Psr4Map | null>();
  private readonly decls = new Map<string, Array<{ path: string; name: string; kind: string }>>();

  constructor(private readonly rootDir: string, private readonly lookup: PhpLookup) {}

  /** composer.json PSR-4 maps from `dir` up to the index root, nearest first. */
  psr4For(dir: string): Psr4Map[] {
    const hit = this.chains.get(dir);
    if (hit) return hit;
    let chain: Psr4Map[];
    const rel = path.relative(this.rootDir, dir);
    if (rel.startsWith("..") || path.isAbsolute(rel)) chain = [];
    else {
      let own = this.composers.get(dir);
      if (own === undefined) {
        const file = path.join(dir, "composer.json");
        own = fs.existsSync(file) ? readPsr4(file) : null;
        this.composers.set(dir, own);
      }
      const parent = dir === this.rootDir ? [] : this.psr4For(path.dirname(dir));
      chain = own ? [own, ...parent] : parent;
    }
    this.chains.set(dir, chain);
    return chain;
  }

  private declaredAs(fqn: string): Array<{ path: string; name: string; kind: string }> {
    let d = this.decls.get(fqn);
    if (!d) { d = this.lookup.declared(fqn); this.decls.set(fqn, d); }
    return d;
  }

  /** The indexed file a reference lands in, with the name it declares there; null when not indexed. */
  resolve(ref: PhpRef, fromFile: string): { path: string; name: string } | null {
    const fqn = ref.fqn;
    if (ref.kind === "class") {
      for (const map of this.psr4For(path.dirname(fromFile))) {
        for (const { prefix, dirs } of map.entries) {
          if (!fqn.startsWith(prefix) || fqn.length === prefix.length) continue;
          const rel = fqn.slice(prefix.length).split("\\").join("/") + ".php";
          for (const d of dirs) {
            const candidate = path.join(d, rel);
            if (this.lookup.isIndexed(candidate)) return { path: candidate, name: lastSegment(fqn) };
          }
        }
      }
    }
    const want = (k: string) => (ref.kind === "class" ? CLASS_KINDS.has(k) : k === ref.kind);
    let hit = this.declaredAs(fqn).find((d) => want(d.kind));
    // An unqualified function call falls back to the global function of that name.
    if (!hit && ref.kind === "function" && ref.tentative && fqn.includes("\\")) hit = this.declaredAs(lastSegment(fqn)).find((d) => want(d.kind));
    return hit ? { path: hit.path, name: hit.name } : null;
  }

  /**
   * The external package (vendor namespace root) an unresolved reference
   * names, or null: guesses, global names (`\Exception`) and names under one
   * of this project's own PSR-4 prefixes are not external.
   */
  externalOf(ref: PhpRef, fromFile: string): string | null {
    if (ref.tentative || !ref.fqn.includes("\\")) return null;
    for (const map of this.psr4For(path.dirname(fromFile))) {
      for (const { prefix } of map.entries) if (prefix && ref.fqn.startsWith(prefix)) return null;
    }
    return ref.fqn.slice(0, ref.fqn.indexOf("\\"));
  }
}

/** Every resolved edge of a parsed file: target path → symbols, in source order. */
export function phpEdges(parsed: PhpParse, fromFile: string, resolver: PhpResolver): { edges: Map<string, { symbols: Set<string>; lines: number[]; useLines: number[] }>; externals: string[] } {
  const edges = new Map<string, { symbols: Set<string>; lines: number[]; useLines: number[] }>();
  const externals = new Set<string>();
  for (const ref of parsed.refs) {
    const hit = resolver.resolve(ref, fromFile);
    if (!hit) {
      const ext = resolver.externalOf(ref, fromFile);
      if (ext) externals.add(ext);
      continue;
    }
    if (hit.path === fromFile) continue;
    const e = edges.get(hit.path) ?? { symbols: new Set<string>(), lines: [], useLines: [] };
    e.symbols.add(hit.name);
    (ref.fromUse ? e.useLines : e.lines).push(ref.line);
    edges.set(hit.path, e);
  }
  return { edges, externals: [...externals].sort() };
}
