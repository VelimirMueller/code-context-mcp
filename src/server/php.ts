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
 * Untrusted input: the indexer runs on every file of a cloned repo, inside the
 * MCP server and the dashboard watcher. Every pass is linear in the file size
 * (no backtracking-prone regex on unbounded input, no recursion, no rescans),
 * and hard caps bound the rest: files over MAX_PHP_PARSE_BYTES get no
 * structure at all, and tokens, exports, references and name lengths are
 * capped per file (PhpParse.limited says which cap was hit).
 *
 * Files are found through the nearest composer.json `autoload` /
 * `autoload-dev` PSR-4 maps (paths relative to that composer.json, every
 * composer.json up to the index root is tried), then through the indexed
 * declarations themselves (classmap, `files` helpers, functions, constants).
 */
import fs from "node:fs";
import path from "node:path";
import { oneLine, MAX_SIGNATURE_CHARS, MAX_STORED_IMPORT_LINES, type ImportLine } from "./signatures.js";

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
  /**
   * Set when the file was not parsed (too large) or a per-file cap cut the
   * parse short: a short note for the file summary. Normal files never set it.
   */
  limited?: string;
  /** Namespace of the first declaration (or the last `namespace` seen). */
  namespace: string;
  exports: PhpExport[];
  /** Top-level `use` statements, one line each (files.import_lines). */
  useLines: ImportLine[];
  refs: PhpRef[];
}

// ─── Limits (crafted files must not hang or exhaust the process) ─────────────

/** Larger files (UTF-8 bytes) are indexed as plain files: no exports, use lines or edges. */
export const MAX_PHP_PARSE_BYTES = 2 * 1024 * 1024;
/** Tokens read per file; the rest of a larger token stream is not parsed. */
export const MAX_PHP_TOKENS = 500_000;
/** Declarations (exports) kept per file (the most in 34k real vendor files: 379). */
export const MAX_PHP_EXPORTS = 2_000;
/** Distinct references (future edges) kept per file (the most in 34k real vendor files: 624). */
export const MAX_PHP_REFS = 10_000;
/** Longest namespace / declaration name / qualified reference taken (characters). */
export const MAX_PHP_NAME_CHARS = 1_024;
/**
 * Most source characters a signature or use line is cut from. oneLine keeps
 * MAX_SIGNATURE_CHARS (160) of it anyway, so only a header with kilobytes of
 * whitespace could read differently.
 */
const MAX_SIGNATURE_SOURCE = 4_096;
/** Names between `const` and the constant name (`const string NAME =` has one). */
const MAX_CONST_TYPE_NAMES = 4;

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
 * is skipped with its own brace depth. Iterative with an explicit stack: a
 * crafted file can nest `"{$"{$…` without bound, and recursion would overflow
 * the call stack.
 */
function skipDouble(src: string, i: number, quote: string): number {
  const n = src.length;
  let j = i + 1;
  while (j < n) {
    const c = src[j];
    if (c === "\\") j += 2;
    else if (c === quote) return j + 1;
    else if ((c === "{" && src[j + 1] === "$") || (c === "$" && src[j + 1] === "{")) return skipInterpolated(src, j, quote);
    else j++;
  }
  return n;
}

/** skipDouble from the first `{$` / `${` at `j` on, with a stack of open strings and brace depths. */
function skipInterpolated(src: string, j: number, quote: string): number {
  const n = src.length;
  // frames: STRING (inside a "…" string; the outermost may be `…`) or a brace depth >= 1 (inside {$…})
  const STRING = 0;
  const frames: number[] = [STRING, 1];
  j += 2;
  while (j < n) {
    const top = frames[frames.length - 1];
    const c = src[j];
    if (top === STRING) {
      if (c === "\\") { j += 2; continue; }
      if (c === (frames.length === 1 ? quote : '"')) {
        frames.pop();
        j++;
        if (frames.length === 0) return j;
        continue;
      }
      if ((c === "{" && src[j + 1] === "$") || (c === "$" && src[j + 1] === "{")) { frames.push(1); j += 2; continue; }
      j++;
    } else if (c === "'") {
      j = skipSingle(src, j);
    } else if (c === '"') {
      frames.push(STRING);
      j++;
    } else {
      if (c === "{") frames[frames.length - 1] = top + 1;
      else if (c === "}") { if (top === 1) frames.pop(); else frames[frames.length - 1] = top - 1; }
      j++;
    }
  }
  return n;
}

const isLabelChar = (code: number): boolean =>
  (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 95 || code >= 0x80;
const isLineBreak = (code: number): boolean => code === 10 || code === 13 || code === 0x2028 || code === 0x2029;

/**
 * End (exclusive) of the closing marker of a heredoc / nowdoc whose
 * body starts at `from`: `label` at the start of a line after optional spaces
 * or tabs (PHP 7.3+), not followed by a label character; -1 when absent.
 * A plain indexOf scan, so a long body costs one linear pass and no regex is
 * built from file content.
 */
function heredocClose(src: string, label: string, from: number): number {
  for (let k = src.indexOf(label, from); k >= 0; k = src.indexOf(label, k + 1)) {
    const after = k + label.length;
    if (after < src.length && isLabelChar(src.charCodeAt(after))) continue;
    let b = k;
    while (b > from && (src[b - 1] === " " || src[b - 1] === "\t")) b--;
    if (b === from || isLineBreak(src.charCodeAt(b - 1))) return after;
  }
  return -1;
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
        const close = heredocClose(src, h[2], i + h[0].length);
        end = close < 0 ? n : close;
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
// name (optionally qualified / fully qualified) | $var | punctuation the parser needs | number.
// No alternative can backtrack over an unbounded run: a name's `\` segments
// each need a backslash, and `$var` takes one `$` (`$$x` reads as `$` + `$x`;
// `\$+name` was quadratic on a long run of `$`).
const TOKEN = new RegExp(
  String.raw`(\\?${NAME_CHARS}(?:\\${NAME_CHARS})*)|(\$${NAME_CHARS})|(::|\?->|->|=>|[{}()\[\];,:|&?=])|(\d[\w.]*)`,
  "g",
);

const enum T { Name, Var, Punct, Num }
interface Tok { t: T; s: string; pos: number }

function tokenize(code: string): { toks: Tok[]; capped: boolean } {
  const out: Tok[] = [];
  TOKEN.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TOKEN.exec(code)) !== null) {
    if (out.length >= MAX_PHP_TOKENS) return { toks: out, capped: true };
    const t = m[1] !== undefined ? T.Name : m[2] !== undefined ? T.Var : m[3] !== undefined ? T.Punct : T.Num;
    out.push({ t, s: m[0], pos: m.index });
  }
  return { toks: out, capped: false };
}

/**
 * For every token i: the index of the first `{` or `;` at j >= i that is not
 * inside a `(…)` group opened at or after i (toks.length when none). This is
 * what the old per-header forward scan returned, computed for all headers in
 * one right-to-left sweep, O(n log n): rescanning to the end of the file for
 * every `class X` / `function f(` without a body was quadratic.
 */
function headerEnds(toks: Tok[]): Int32Array {
  const n = toks.length;
  // P[j]: open minus close parens among toks[0..j)
  const P = new Int32Array(n + 1);
  for (let j = 0; j < n; j++) {
    const s = toks[j].s;
    P[j + 1] = P[j] + (s === "(" ? 1 : s === ")" ? -1 : 0);
  }
  // stack[0..top): stop tokens, nearest on top; P[stack[k]] strictly increases with k
  const stack = new Int32Array(n);
  let top = 0;
  const out = new Int32Array(n);
  for (let i = n - 1; i >= 0; i--) {
    const s = toks[i].s;
    if (s === "{" || s === ";") {
      while (top > 0 && P[stack[top - 1]] >= P[i]) top--;
      stack[top++] = i;
    }
    // the nearest stop j with P[j] <= P[i]: the highest stack entry with that property
    let lo = 0;
    let hi = top - 1;
    let ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (P[stack[mid]] <= P[i]) { ans = mid; lo = mid + 1; } else hi = mid - 1;
    }
    out[i] = ans < 0 ? n : stack[ans];
  }
  return out;
}

/** Names that are never a class reference (compared lower-case). */
const NOT_A_CLASS = new Set([
  "self", "static", "parent", "true", "false", "null", "array", "callable", "iterable", "object",
  "mixed", "void", "never", "bool", "boolean", "int", "integer", "float", "double", "string", "list",
  "class", "interface", "trait", "enum", "function", "fn", "new", "clone", "instanceof", "insteadof",
  "namespace", "use", "as", "const", "case", "default", "match", "yield", "from", "and", "or", "xor",
  "extends", "implements",
]);
/** Constructs followed by `(` that are not function calls. */
const NOT_A_FUNCTION = new Set([
  "if", "elseif", "while", "for", "foreach", "switch", "match", "array", "list", "isset", "unset",
  "empty", "eval", "exit", "die", "include", "include_once", "require", "require_once", "print",
  "echo", "return", "fn", "function", "declare", "catch", "new", "clone", "yield", "static", "self",
  "parent", "and", "or", "xor", "instanceof", "global", "use", "as", "class", "enum",
]);
const MODIFIERS = new Set(["abstract", "final", "readonly"]);
const HEADER_KEYWORDS = new Set(["extends", "implements"]);
const CLASS_LIKE = new Set(["class", "interface", "trait", "enum"]);

const isStudly = (s: string): boolean => /^[A-Z]/.test(s) && /[a-z]/.test(s);
const lastSegment = (fqn: string): string => fqn.slice(fqn.lastIndexOf("\\") + 1);
const qualify = (ns: string, name: string): string => (ns ? `${ns}\\${name}` : name);

/**
 * oneLine(content.slice(from, to)) without reading more than it needs: a
 * header without a body can run to the end of the file, and cutting it for
 * each of thousands of declarations was quadratic. The slice grows until its
 * collapsed text is long enough that oneLine's 160-character cut cannot change
 * (its rewrites shrink text at most 3:1 and differ only in the last few
 * characters of a cut), capped at MAX_SIGNATURE_SOURCE.
 */
function boundedOneLine(content: string, from: number, to: number): string {
  const enough = 3 * (MAX_SIGNATURE_CHARS + 8);
  for (let lim = 512; ; lim *= 2) {
    const cut = Math.min(to, from + lim, from + MAX_SIGNATURE_SOURCE);
    const text = content.slice(from, cut);
    if (cut === to || cut === from + MAX_SIGNATURE_SOURCE || text.replace(/\s+/g, " ").trim().length >= enough) return oneLine(text);
  }
}

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
  // a UTF-16 code unit is at most 3 UTF-8 bytes: count bytes only near the limit
  if (content.length > MAX_PHP_PARSE_BYTES || (content.length * 3 > MAX_PHP_PARSE_BYTES && Buffer.byteLength(content, "utf8") > MAX_PHP_PARSE_BYTES)) {
    return { limited: `PHP structure not indexed: file larger than ${MAX_PHP_PARSE_BYTES / (1024 * 1024)} MB`, namespace: "", exports: [], useLines: [], refs: [] };
  }
  const code = stripPhp(content);
  const { toks, capped } = tokenize(code);
  const lineOf = lineFinder(content);
  const exports: PhpExport[] = [];
  const useLines: ImportLine[] = [];
  const refs: PhpRef[] = [];
  const seenRefs = new Map<string, PhpRef>();
  const limits = new Set<string>();
  if (capped) limits.add(`first ${MAX_PHP_TOKENS} tokens`);
  /** Room for one more export? Checked before its signature is cut from the source. */
  const canExport = (): boolean => {
    if (exports.length < MAX_PHP_EXPORTS) return true;
    limits.add(`first ${MAX_PHP_EXPORTS} declarations`);
    return false;
  };
  /** A namespace / declaration name short enough to keep (crafted names can be megabytes). */
  const sane = (name: string): boolean => {
    if (name.length <= MAX_PHP_NAME_CHARS) return true;
    limits.add(`names over ${MAX_PHP_NAME_CHARS} characters skipped`);
    return false;
  };

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
    if (!fqn || !sane(fqn)) return;
    const key = `${kind}:${fqn.toLowerCase()}`;
    const seen = seenRefs.get(key);
    if (seen) {
      // a later `use` of a name first seen in code still marks it as imported
      if (fromUse) { seen.fromUse = true; seen.tentative = false; }
      return;
    }
    if (refs.length >= MAX_PHP_REFS) { limits.add(`first ${MAX_PHP_REFS} references`); return; }
    const ref: PhpRef = { fqn, kind, line: lineOf(pos), fromUse, tentative };
    seenRefs.set(key, ref);
    refs.push(ref);
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
    if (useLines.length < MAX_STORED_IMPORT_LINES) useLines.push({ line: lineOf(start), text: boundedOneLine(content, start, endPos) });
    return j;
  };

  /** Index of the `{` or `;` ending a header that starts at tokens[i], skipping (…) groups. */
  // A short forward scan answers almost every real header; a longer one (or
  // a crafted file's endless one) is looked up in the precomputed table.
  let ends: Int32Array | null = null;
  const headerEnd = (i: number): number => {
    let paren = 0;
    for (let j = i, stop = Math.min(toks.length, i + 64); j < stop; j++) {
      const s = toks[j].s;
      if (s === "(") paren++;
      else if (s === ")") paren--;
      else if (paren <= 0 && (s === "{" || s === ";")) return j;
    }
    if (i + 64 >= toks.length) return toks.length;
    ends ??= headerEnds(toks);
    return ends[i];
  };
  const sliceTo = (from: number, endTok: number): string => boundedOneLine(content, from, endTok < toks.length ? toks[endTok].pos : content.length);

  /**
   * `extends` / `implements` keywords not yet handled, as a union-find "next
   * unhandled at or after j" (toks.length = none). Headers without a `{` can
   * overlap (`class A class B …`); each keyword's name list is read once, by
   * the first header that reaches it, exactly as before, instead of once per
   * overlapping header (quadratic).
   */
  let kwNext: Int32Array | null = null;
  const nextKeyword = (j: number): number => {
    if (!kwNext) {
      kwNext = new Int32Array(toks.length + 1);
      for (let k = 0; k < toks.length; k++) {
        const { t, s } = toks[k];
        kwNext[k] = t === T.Name && (s.length === 7 || s.length === 10) && HEADER_KEYWORDS.has(s.toLowerCase()) ? k : k + 1;
      }
      kwNext[toks.length] = toks.length;
    }
    const nx = kwNext;
    let k = Math.min(j, toks.length);
    while (nx[k] !== k) { nx[k] = nx[nx[k]]; k = nx[k]; }
    return k;
  };

  const atTop = () => depth === nsDepth && classBodies.length === 0;

  /** Index of the `[` matching each `]` (-1 when unmatched); built on first use, one pass. */
  let openOf: Int32Array | null = null;
  const matchingOpen = (k: number): number => {
    if (!openOf) {
      openOf = new Int32Array(toks.length).fill(-1);
      const stack: number[] = [];
      for (let j = 0; j < toks.length; j++) {
        if (toks[j].s === "[") stack.push(j);
        else if (toks[j].s === "]" && stack.length) openOf[j] = stack.pop()!;
      }
    }
    return openOf[k];
  };
  /**
   * `class` at tokens[i] is anonymous: `new class`, `new readonly class`
   * (PHP 8.3), `new #[Attr] class`. Walks back over modifiers and whole
   * attribute groups only, each group by one `class` at most, so it stays linear.
   */
  const isAnonymousClass = (i: number): boolean => {
    let k = i - 1;
    while (k >= 0) {
      const t = toks[k];
      if (t.t === T.Name && MODIFIERS.has(t.s.toLowerCase())) { k--; continue; }
      if (t.s === "]") {
        const open = matchingOpen(k);
        if (open < 0 || code[toks[open].pos - 1] !== "#") return false;
        k = open - 1;
        continue;
      }
      break;
    }
    return k >= 0 && toks[k].t === T.Name && toks[k].s.toLowerCase() === "new";
  };

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
      if (next.t === T.Name) { ns = sane(next.s) ? next.s.replace(/^\\/, "") : ""; i++; } else ns = "";
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
      const anonymous = lower === "class" && isAnonymousClass(i);
      const named = !anonymous && next?.t === T.Name && !NOT_A_CLASS.has(next.s.toLowerCase()) && !next.s.includes("\\");
      // `enum` is not reserved: only `enum Name {`, `enum Name:` or `enum Name implements` declare one
      const isDecl = lower !== "enum" || (named && ["{", ":"].includes(toks[i + 2]?.s ?? "") || toks[i + 2]?.s.toLowerCase() === "implements");
      if (!isDecl || (!named && !anonymous)) continue;
      pendingClass = true;
      const end = headerEnd(i);
      // extends / implements lists
      for (let k = nextKeyword(i + 1); k < end; k = nextKeyword(k + 1)) {
        kwNext![k] = k + 1; // handled
        for (let j = k + 1; j < end && toks[j].t === T.Name && !HEADER_KEYWORDS.has(toks[j].s.toLowerCase()); j++) {
          classRef(toks[j]);
          if (toks[j + 1]?.s !== ",") break;
          j++;
        }
      }
      if (named && atTop() && sane(next.s) && canExport()) {
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
        if (classBodies.length === 0 && !nameTok.s.includes("\\") && sane(nameTok.s) && canExport()) {
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
      while (toks[j]?.t === T.Name && toks[j + 1]?.t === T.Name && j - i < MAX_CONST_TYPE_NAMES) j++;
      if (toks[j]?.t === T.Name && toks[j + 1]?.s === "=") {
        if (atTop() && sane(toks[j].s) && canExport()) {
          const end = headerEnd(j);
          exports.push({ name: toks[j].s, fqn: qualify(ns, toks[j].s), kind: "const", signature: sliceTo(tok.pos, end), line: lineOf(tok.pos) });
        }
        i = j;
      }
      continue;
    }

    if (lower === "new" || lower === "instanceof") {
      // `new readonly class` (PHP 8.3): the modifier is not a class name
      if (next?.t === T.Name && !CLASS_LIKE.has(next.s.toLowerCase()) && !MODIFIERS.has(next.s.toLowerCase())) { classRef(next); i++; }
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

  const result: PhpParse = { namespace: firstNs ?? ns, exports, useLines, refs };
  if (limits.size) result.limited = `PHP structure capped: ${[...limits].join(", ")}`;
  return result;
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

// A crafted repo can ship a huge composer.json, thousands of PSR-4 prefixes or
// a composer.json in every directory; these bound the work per reference.
/** composer.json files larger than this are ignored. */
export const MAX_COMPOSER_JSON_BYTES = 1024 * 1024;
/** PSR-4 prefixes read per composer.json (autoload + autoload-dev). */
export const MAX_PSR4_ENTRIES = 256;
/** Base directories read per PSR-4 prefix. */
const MAX_PSR4_DIRS = 16;
/** composer.json files consulted per directory, nearest first. */
export const MAX_COMPOSER_CHAIN = 8;
/** Candidate files checked per class reference. */
const MAX_PSR4_CANDIDATES = 64;

function readPsr4(composerPath: string): Psr4Map | null {
  type Autoload = { "psr-4"?: Record<string, unknown> } | undefined;
  let json: { autoload?: Autoload; "autoload-dev"?: Autoload } | null;
  try {
    if (fs.statSync(composerPath).size > MAX_COMPOSER_JSON_BYTES) return null;
    json = JSON.parse(fs.readFileSync(composerPath, "utf-8"));
  } catch { return null; }
  const dir = path.dirname(composerPath);
  const entries: Psr4Map["entries"] = [];
  for (const section of [json?.autoload?.["psr-4"], json?.["autoload-dev"]?.["psr-4"]]) {
    if (!section || typeof section !== "object") continue;
    for (const [rawPrefix, target] of Object.entries(section)) {
      if (entries.length >= MAX_PSR4_ENTRIES) break;
      if (rawPrefix.length > MAX_PHP_NAME_CHARS) continue;
      // trim by hand: /\\*$/ on a long run of backslashes backtracks quadratically
      let a = 0;
      let b = rawPrefix.length;
      while (a < b && rawPrefix[a] === "\\") a++;
      while (b > a && rawPrefix[b - 1] === "\\") b--;
      const prefix = a < b ? `${rawPrefix.slice(a, b)}\\` : "";
      const dirs = (Array.isArray(target) ? target : [target]).slice(0, MAX_PSR4_DIRS).filter((d): d is string => typeof d === "string").map((d) => path.resolve(dir, d));
      if (dirs.length) entries.push({ prefix, dirs });
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
      chain = own ? [own, ...parent].slice(0, MAX_COMPOSER_CHAIN) : parent;
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
      let budget = MAX_PSR4_CANDIDATES;
      psr4: for (const map of this.psr4For(path.dirname(fromFile))) {
        for (const { prefix, dirs } of map.entries) {
          if (!fqn.startsWith(prefix) || fqn.length === prefix.length) continue;
          const rel = fqn.slice(prefix.length).split("\\").join("/") + ".php";
          for (const d of dirs) {
            if (budget-- <= 0) break psr4;
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
