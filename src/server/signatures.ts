// CCA-04 (#119): one-line signatures, line numbers and raw import lines for
// get_file_context. In bench transcripts 60 % of get_file_context calls were
// followed by a full read of the same file because the result had export
// names but no signatures, no line numbers and no import lines.
//
// Regex + small scanner, like the export/import parsers in indexer.ts (there
// is no AST in this project). Everything here is best effort: a declaration
// the scanner does not understand gets a null signature and still has a line.

/** Longest signature / import line kept (chars, after whitespace collapse). */
export const MAX_SIGNATURE_CHARS = 160;
/** Import lines stored per file; a file with more is a generated barrel. */
export const MAX_STORED_IMPORT_LINES = 200;

/** JS/TS declaration exports. Shared with the export parser in indexer.ts. */
export const DEFAULT_EXPORT_SRC = String.raw`export\s+default\s+(function|class)\s+(\w+)`;
export const NAMED_EXPORT_SRC = String.raw`export\s+(?:async\s+)?(function|const|let|var|class|interface|type|enum)\s+(\w+)`;

const JS_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);
const PY_EXTENSIONS = new Set([".py", ".pyi"]);

export interface ExportDetail {
  line: number;
  signature: string | null;
}

export interface ImportLine {
  line: number;
  text: string;
}

/** Collapse whitespace and cap at MAX_SIGNATURE_CHARS with an ellipsis. */
export function oneLine(text: string): string {
  const s = text
    .replace(/\s+/g, " ")
    .trim()
    // a list broken over lines reads as one: `( a, b, )` → `(a, b)`
    .replace(/([([]) /g, "$1")
    .replace(/,? ([)\]])/g, "$1")
    .replace(/, }/g, " }")
    .replace(/= \| /, "= ");
  return s.length > MAX_SIGNATURE_CHARS ? s.slice(0, MAX_SIGNATURE_CHARS - 1).trimEnd() + "…" : s;
}

/** 1-based line number of `pos`, via a precomputed table of line starts. */
function lineFinder(content: string): (pos: number) => number {
  const starts = [0];
  for (let i = 0; i < content.length; i++) if (content[i] === "\n") starts.push(i + 1);
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

const OPEN = new Set(["(", "[", "<"]);
const CLOSE: Record<string, string> = { ")": "(", "]": "[", ">": "<" };
/** A `{` after one of these opens a type literal, not a body. */
const TYPE_BRACE_AFTER = new Set([":", "|", "&", ",", "<", "(", "["]);

/**
 * Scan a JS/TS declaration header from `start` and return it on one line.
 * function/class/interface/enum stop before the body `{`; const/let/var stop
 * at `;`, a top-level newline, or after an arrow `=>`; a `{`/`[` value right
 * after `=` is shown as `{…}` / `[…]`. type aliases stop at `;` or a newline.
 */
function scanJsHeader(content: string, start: number, kind: string): string | null {
  const limit = Math.min(content.length, start + 4000);
  const isValueKind = kind === "const" || kind === "let" || kind === "var" || kind === "type";
  let out = "";
  const stack: string[] = [];
  let braces = 0; // type-literal braces
  let lastSig = ""; // last non-space char written
  for (let i = start; i < limit; i++) {
    const ch = content[i];
    const next = content[i + 1];
    // comments
    if (ch === "/" && next === "/") { const nl = content.indexOf("\n", i); i = (nl < 0 ? limit : nl) - 1; continue; }
    if (ch === "/" && next === "*") { const end = content.indexOf("*/", i + 2); i = end < 0 ? limit : end + 1; continue; }
    // strings: copy through
    if (ch === "'" || ch === '"' || ch === "`") {
      let j = i + 1;
      while (j < limit && content[j] !== ch) { if (content[j] === "\\") j++; j++; }
      out += content.slice(i, j + 1);
      lastSig = ch;
      i = j;
      continue;
    }
    const depth = stack.length + braces;
    if (ch === "=" && next === ">") {
      out += "=>";
      lastSig = ">";
      i++;
      if (depth === 0 && isValueKind) return out;
      continue;
    }
    if (depth === 0) {
      if (ch === ";") return out;
      if (ch === "\n" && isValueKind && !/[=|&,(<:]\s*$/.test(out) && !/^\s*[|&]/.test(content.slice(i + 1, i + 200))) return out;
      if (ch === "{" && !TYPE_BRACE_AFTER.has(lastSig)) {
        if (isValueKind && lastSig === "=") return out + "{…}";
        if (isValueKind) return out;
        return out; // body of a function/class/interface/enum
      }
      if (ch === "[" && isValueKind && lastSig === "=") return out + "[…]";
    }
    if (OPEN.has(ch)) {
      // `<` only counts as a bracket in generic position (after a name or `(`/`,`)
      if (ch !== "<" || /[\w$)\]]$/.test(out.trimEnd()) || lastSig === "(" || lastSig === "," || lastSig === "=" || lastSig === ":") stack.push(ch);
    } else if (ch in CLOSE) {
      if (stack.length && stack[stack.length - 1] === CLOSE[ch]) stack.pop();
    } else if (ch === "{") {
      braces++;
    } else if (ch === "}") {
      if (braces > 0) braces--;
      else return out; // unbalanced: stop
    }
    out += ch;
    if (!/\s/.test(ch)) lastSig = ch;
    if (out.length > 2000) break;
  }
  return out.length ? out : null;
}

/** JS/TS exports: name → line of its `export` and its one-line signature. */
function jsExportDetails(content: string): Map<string, ExportDetail> {
  const lineOf = lineFinder(content);
  const details = new Map<string, ExportDetail>();
  const add = (name: string, d: ExportDetail) => { if (!details.has(name)) details.set(name, d); };
  for (const src of [DEFAULT_EXPORT_SRC, NAMED_EXPORT_SRC]) {
    const re = new RegExp(src, "g");
    let m: RegExpExecArray | null;
    while ((m = re.exec(content)) !== null) {
      // Signature starts after `export ` / `export default `, keeping `async`.
      const kwStart = m.index + m[0].indexOf(m[1], m[0].search(/\s/));
      const asyncStart = /async\s+$/.test(content.slice(m.index, kwStart)) ? content.lastIndexOf("async", kwStart) : kwStart;
      const raw = scanJsHeader(content, asyncStart, m[1]);
      add(m[2], { line: lineOf(m.index), signature: raw ? oneLine(raw) : null });
    }
  }
  // export { a, b as c } [from '…'] — line only, no signature
  const braceRe = /export\s+(?:type\s+)?\{([^}]+)\}/g;
  let m: RegExpExecArray | null;
  while ((m = braceRe.exec(content)) !== null) {
    const fromModule = /^\s*from\s+['"]/.test(content.slice(m.index + m[0].length));
    for (const item of m[1].split(",")) {
      const parts = item.trim().split(/\s+as\s+/);
      const name = fromModule && parts.length > 1 ? parts[1] : parts[0];
      if (name) add(name.trim(), { line: lineOf(m.index), signature: null });
    }
  }
  return details;
}

/** Position of the `:` that ends a Python def/class header, skipping brackets. */
function pyHeaderEnd(content: string, start: number): number {
  let depth = 0;
  for (let i = start; i < content.length && i < start + 4000; i++) {
    const ch = content[i];
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") depth--;
    else if (ch === ":" && depth <= 0) return i;
    else if (ch === "#") { const nl = content.indexOf("\n", i); if (nl < 0) break; i = nl; }
  }
  return -1;
}

/** Python top-level def/class/CONSTANT: name → line and one-line signature. */
function pyExportDetails(content: string): Map<string, ExportDetail> {
  const details = new Map<string, ExportDetail>();
  const code = blankTripleQuoted(content);
  const lines = code.split("\n");
  let offset = 0;
  for (let n = 0; n < lines.length; n++) {
    const line = lines[n];
    let m: RegExpExecArray | null;
    let name: string | null = null;
    let signature: string | null = null;
    if ((m = /^(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/.exec(line)) || (m = /^class\s+([A-Za-z_]\w*)/.exec(line))) {
      name = m[1];
      const end = pyHeaderEnd(code, offset);
      signature = end > offset ? oneLine(code.slice(offset, end)) : oneLine(line);
    } else if ((m = /^([A-Z][A-Z0-9_]*)\s*(?::[^=]*)?=/.exec(line))) {
      name = m[1];
      const value = line.replace(/#.*$/, "").trimEnd();
      signature = /[[({]$/.test(value) ? oneLine(value + "…" + closerOf(value.slice(-1))) : oneLine(value);
    }
    if (name && !details.has(name)) details.set(name, { line: n + 1, signature });
    offset += line.length + 1;
  }
  return details;
}

function closerOf(open: string): string {
  return open === "(" ? ")" : open === "[" ? "]" : "}";
}

/** Triple-quoted strings blanked to spaces (newlines kept), so offsets stay valid. */
function blankTripleQuoted(content: string): string {
  return content.replace(/("""[\s\S]*?"""|'''[\s\S]*?''')/g, (s) => s.replace(/[^\n]/g, " "));
}

/** Line + one-line signature for each exported name of a JS/TS or Python file. */
export function exportDetails(content: string, ext: string): Map<string, ExportDetail> {
  if (JS_EXTENSIONS.has(ext)) return jsExportDetails(content);
  if (PY_EXTENSIONS.has(ext)) return pyExportDetails(content);
  return new Map();
}

/**
 * The file's raw import statements, one line each with the line they start on:
 * `import … from '…'`, side-effect `import '…'`, `export … from '…'`, and
 * `require('…')` lines for JS/TS; `import …` / `from … import …` for Python.
 */
export function importLines(content: string, ext: string): ImportLine[] {
  const lineOf = lineFinder(content);
  const found: ImportLine[] = [];
  const seen = new Set<number>();
  const push = (pos: number, text: string) => {
    const line = lineOf(pos);
    if (seen.has(line)) return;
    seen.add(line);
    found.push({ line, text: oneLine(text) });
  };
  let m: RegExpExecArray | null;
  if (JS_EXTENSIONS.has(ext)) {
    const stmtRe = new RegExp(
      String.raw`^[ \t]*(?:import\s+(?:type\s+)?(?:(['"])[^'"\n]+\1|[^;'"()]*?\bfrom\s*(['"])[^'"\n]+\2)` +
        String.raw`|export\s+(?:type\s+)?(?:\*(?:\s+as\s+[\w$]+)?|\{[^}]*\})\s*from\s*(['"])[^'"\n]+\3)[ \t]*;?`,
      "gm",
    );
    while ((m = stmtRe.exec(content)) !== null) {
      push(m.index + (m[0].length - m[0].trimStart().length), m[0].trim());
    }
    const requireRe = /^[ \t]*(?:(?:const|let|var)\s+[^=\n]+=\s*)?(?:await\s+)?require\(\s*['"][^'"\n]+['"]\s*\)[^\n;]*;?/gm;
    while ((m = requireRe.exec(content)) !== null) {
      push(m.index + (m[0].length - m[0].trimStart().length), m[0].trim());
    }
  } else if (PY_EXTENSIONS.has(ext)) {
    const code = blankTripleQuoted(content);
    const re = /^[ \t]*(?:from\s+[\w.]+\s+import\s+(?:\([\s\S]*?\)|[^#\n]+)|import\s+[^#\n]+)/gm;
    while ((m = re.exec(code)) !== null) {
      push(m.index + (m[0].length - m[0].trimStart().length), m[0].trim());
    }
  } else {
    return [];
  }
  return found.sort((a, b) => a.line - b.line).slice(0, MAX_STORED_IMPORT_LINES);
}

/** Parse the stored files.import_lines JSON; null/garbage (old rows) → []. */
export function parseStoredImportLines(raw: string | null | undefined): ImportLine[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    if (!Array.isArray(v)) return [];
    return v.filter((x): x is [number, string] => Array.isArray(x) && typeof x[0] === "number" && typeof x[1] === "string")
      .map(([line, text]) => ({ line, text }));
  } catch {
    return [];
  }
}

/**
 * Compact JSON for files.import_lines: [[line, text], …]. A parsed file with
 * no imports stores "[]", so NULL always means "indexed before schema v25".
 */
export function serializeImportLines(lines: ImportLine[]): string {
  return JSON.stringify(lines.map((l) => [l.line, l.text]));
}

/**
 * True for the extensions the index stores signatures and import lines for
 * (JS/TS and Python here, PHP in php.ts).
 */
export function hasSignatureParser(ext: string): boolean {
  return JS_EXTENSIONS.has(ext) || PY_EXTENSIONS.has(ext) || ext === ".php";
}

const DECL_START = /^\s*(?:export|import|function|class|const|let|var|type|interface|enum|\/\/|\/\*|@)/;

/**
 * Source lines of the declaration that starts on `line` (1-based), at most
 * `maxLines`. JS/TS: until the brace/paren depth returns to zero after the
 * header, or a top-level `;`. Python: until the indentation drops back.
 */
export function declarationLines(content: string, line: number, ext: string, maxLines: number): { lines: string[]; truncated: boolean } {
  const all = content.split("\n");
  const startIdx = line - 1;
  if (startIdx < 0 || startIdx >= all.length) return { lines: [], truncated: false };
  const out: string[] = [];
  if (PY_EXTENSIONS.has(ext)) {
    const indent = (s: string) => s.length - s.trimStart().length;
    const base = indent(all[startIdx]);
    let headerOpen = 0;
    for (let i = startIdx; i < all.length; i++) {
      const s = all[i];
      if (i > startIdx && headerOpen <= 0 && s.trim() && indent(s) <= base) break;
      for (const ch of s.replace(/#.*$/, "")) {
        if ("([{".includes(ch)) headerOpen++;
        else if (")]}".includes(ch)) headerOpen--;
      }
      out.push(s);
      if (out.length > maxLines) break;
    }
  } else {
    let depth = 0;
    let opened = false;
    for (let i = startIdx; i < all.length; i++) {
      const s = all[i];
      out.push(s);
      // a string literal: `\\.` or one non-backslash, never both (`\\.|.` let a
      // run of backslashes split 2^n ways: exponential on an unterminated string)
      const code = s.replace(/\/\/.*$/, "").replace(/(['"`])(?:\\.|(?!\1)[^\\\n\r\u2028\u2029])*\1/g, "''");
      for (const ch of code) {
        if (ch === "{" || ch === "(" || ch === "[") { depth++; opened = true; }
        else if (ch === "}" || ch === ")" || ch === "]") depth--;
      }
      if (depth <= 0 && (opened || /;\s*$/.test(code))) break;
      const nextLine = all[i + 1];
      if (depth <= 0 && (nextLine === undefined || !nextLine.trim() || DECL_START.test(nextLine))) break;
      if (out.length > maxLines) break;
    }
  }
  const truncated = out.length > maxLines;
  const lines = out.slice(0, maxLines);
  // trailing blank lines are noise
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  return { lines, truncated };
}
