/**
 * Vite `resolve.alias` for the import graph (CCA-38, #182).
 *
 * A vite.config is code, so it is never run. A linear tokenizer reads the
 * static forms only and skips every entry it cannot evaluate:
 *
 * - Object form: `alias: { '@': <path>, '~utils': <path> }`
 * - Array form: `alias: [{ find: '@', replacement: <path> }]` (string `find`
 *   only; a RegExp `find` is skipped)
 * - <path>: `path.resolve(…)` / `resolve(…)`, `path.join(…)` / `join(…)`,
 *   `path.dirname(…)`, `fileURLToPath(new URL('./src', import.meta.url))`,
 *   `new URL(…).pathname`, a template like `${__dirname}/src`, a string that
 *   starts with `/` (relative to the config's directory, Vite's root), and a
 *   local `const x = <path>` used by name. Bases: `__dirname`,
 *   `import.meta.dirname`, `process.cwd()` — all the config's directory.
 *
 * Matching follows @rollup/plugin-alias: entries in order, a string `find`
 * matches the specifier itself or the specifier followed by `/`.
 */
import path from 'node:path';

export interface ViteAlias {
  find: string;
  /** Absolute path the `find` prefix is replaced with. */
  replacement: string;
  /** True for a `/src`-style string: relative to the config's directory (Vite's root). */
  rootRelative?: boolean;
}

type Tok =
  | { t: 'id'; v: string }
  | { t: 'str'; v: string }
  | { t: 'tpl'; parts: (string | { id: string })[] | null }
  | { t: 'p'; v: string }
  | { t: 'other' };

const MAX_TOKENS = 200_000;
const MAX_DEPTH = 4;

const isIdStart = (c: string): boolean =>
  (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_' || c === '$';
const isIdChar = (c: string): boolean => isIdStart(c) || (c >= '0' && c <= '9');
const isSpace = (c: string): boolean => c === ' ' || c === '\t' || c === '\n' || c === '\r';

/** Tokens of a JS/TS config file: identifiers, strings, simple templates, punctuation. */
export function tokenize(text: string): Tok[] {
  const out: Tok[] = [];
  const n = text.length;
  let i = 0;
  const regexMayStart = (): boolean => {
    const last = out[out.length - 1];
    return !last || (last.t === 'p' && !')]}'.includes(last.v));
  };
  while (i < n && out.length < MAX_TOKENS) {
    const c = text[i];
    if (isSpace(c)) {
      i++;
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < n && text[i] !== '\n') i++;
    } else if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end === -1 ? n : end + 2;
    } else if (c === '"' || c === "'") {
      let v = '';
      i++;
      while (i < n && text[i] !== c && text[i] !== '\n') {
        if (text[i] === '\\' && i + 1 < n) {
          v += text[i + 1];
          i += 2;
        } else v += text[i++];
      }
      i++;
      out.push({ t: 'str', v });
    } else if (c === '`') {
      const parts: (string | { id: string })[] = [];
      let ok = true;
      let lit = '';
      i++;
      while (i < n && text[i] !== '`') {
        if (text[i] === '\\' && i + 1 < n) {
          lit += text[i + 1];
          i += 2;
        } else if (text[i] === '$' && text[i + 1] === '{') {
          parts.push(lit);
          lit = '';
          let depth = 1;
          const start = (i += 2);
          while (i < n && depth > 0) {
            if (text[i] === '{') depth++;
            else if (text[i] === '}') depth--;
            i++;
          }
          const expr = text.slice(start, i - 1).trim();
          // Only `${name}` or `${a.b}` — anything else makes the template unknown.
          if (expr && [...expr].every((ch) => isIdChar(ch) || ch === '.')) parts.push({ id: expr });
          else ok = false;
        } else lit += text[i++];
      }
      i++;
      parts.push(lit);
      out.push({ t: 'tpl', parts: ok ? parts : null });
    } else if (c === '/' && regexMayStart()) {
      // Regex literal: skip to the closing slash outside a class, then flags.
      let inClass = false;
      i++;
      while (i < n && text[i] !== '\n') {
        const ch = text[i];
        if (ch === '/' && !inClass) break;
        if (ch === '[') inClass = true;
        else if (ch === ']') inClass = false;
        i += ch === '\\' ? 2 : 1;
      }
      i++;
      while (i < n && isIdChar(text[i])) i++;
      out.push({ t: 'other' });
    } else if (isIdStart(c)) {
      const start = i;
      while (i < n && isIdChar(text[i])) i++;
      out.push({ t: 'id', v: text.slice(start, i) });
    } else if (c >= '0' && c <= '9') {
      while (i < n && (isIdChar(text[i]) || text[i] === '.')) i++;
      out.push({ t: 'other' });
    } else {
      out.push({ t: 'p', v: c });
      i++;
    }
  }
  return out;
}

const isP = (t: Tok | undefined, v: string): boolean => !!t && t.t === 'p' && t.v === v;
const isId = (t: Tok | undefined, v?: string): boolean =>
  !!t && t.t === 'id' && (v === undefined || t.v === v);

/** Index just past the expression that starts at `i` (stops at `,` or a closer at depth 0). */
function exprEnd(toks: Tok[], i: number): number {
  let depth = 0;
  for (; i < toks.length; i++) {
    const t = toks[i];
    if (t.t !== 'p') continue;
    if ('([{'.includes(t.v)) depth++;
    else if (')]}'.includes(t.v)) {
      if (depth === 0) return i;
      depth--;
    } else if ((t.v === ',' || t.v === ';') && depth === 0) return i;
  }
  return i;
}

/** Top-level comma-separated argument ranges inside `(`…`)` that opens at `open`. */
function args(toks: Tok[], open: number): { ranges: [number, number][]; end: number } | null {
  if (!isP(toks[open], '(')) return null;
  const ranges: [number, number][] = [];
  let i = open + 1;
  while (i < toks.length && !isP(toks[i], ')')) {
    const e = exprEnd(toks, i);
    ranges.push([i, e]);
    i = isP(toks[e], ',') ? e + 1 : e;
  }
  return { ranges, end: i + 1 };
}

type Val = { kind: 'path'; v: string } | { kind: 'url'; v: string } | { kind: 'str'; v: string };

class Evaluator {
  private readonly consts = new Map<string, [number, number]>();

  constructor(
    private readonly toks: Tok[],
    private readonly file: string,
  ) {
    for (let i = 0; i + 2 < toks.length; i++) {
      if (
        (isId(toks[i], 'const') || isId(toks[i], 'let')) &&
        isId(toks[i + 1]) &&
        isP(toks[i + 2], '=')
      ) {
        const name = (toks[i + 1] as { v: string }).v;
        if (!this.consts.has(name)) this.consts.set(name, [i + 3, exprEnd(toks, i + 3)]);
      }
    }
  }

  private get dir(): string {
    return path.dirname(this.file);
  }

  /** Value of toks[a..b), or null when it is not one of the static forms. */
  value(a: number, b: number, depth = 0): Val | null {
    if (depth > MAX_DEPTH || a >= b) return null;
    const t = this.toks;
    const one = b - a === 1 ? t[a] : null;
    if (one?.t === 'str') return { kind: 'str', v: one.v };
    if (one?.t === 'tpl') {
      if (!one.parts) return null;
      let s = '';
      let startsWithPath = false;
      for (const [k, p] of one.parts.entries()) {
        if (typeof p === 'string') s += p;
        else {
          const v = this.name(p.id, depth);
          if (!v || v.kind === 'url') return null;
          // `${__dirname}/src`: a path when the template opens with one.
          if (k === 1 && s === '' && v.kind === 'path') startsWithPath = true;
          s += v.v;
        }
      }
      return startsWithPath ? { kind: 'path', v: path.normalize(s) } : { kind: 'str', v: s };
    }
    // a.b.c chains: __dirname, import.meta.dirname, import.meta.url, x
    const chain: string[] = [];
    let i = a;
    while (i < b && isId(t[i])) {
      chain.push((t[i] as { v: string }).v);
      if (isP(t[i + 1], '.')) i += 2;
      else {
        i++;
        break;
      }
    }
    const dotted = chain.join('.');
    if (i === b && chain.length) return this.name(dotted, depth);
    // new URL(x, import.meta.url)[.pathname]
    if (isId(t[a], 'new') && isId(t[a + 1], 'URL')) {
      const ar = args(t, a + 2);
      if (!ar || ar.ranges.length !== 2) return null;
      const rel = this.value(...ar.ranges[0], depth + 1);
      const base = this.value(...ar.ranges[1], depth + 1);
      if (!rel || rel.kind !== 'str' || !base || base.kind !== 'url') return null;
      const url: Val = { kind: 'url', v: path.resolve(path.dirname(base.v), rel.v) };
      if (ar.end === b) return url;
      if (ar.end + 2 === b && isP(t[ar.end], '.') && isId(t[ar.end + 1], 'pathname'))
        return { kind: 'path', v: url.v };
      return null;
    }
    // call: fn(args) with fn one of the known helpers
    if (chain.length && isP(t[i], '(')) {
      const ar = args(t, i);
      if (!ar || ar.end !== b) return null;
      const fn = chain[chain.length - 1];
      const vals = ar.ranges.map((r) => this.value(r[0], r[1], depth + 1));
      if (vals.some((v) => !v)) return null;
      const strs = (vals as Val[]).map((v) => v.v);
      if (dotted === 'process.cwd' && vals.length === 0) return { kind: 'path', v: this.dir };
      if (fn === 'fileURLToPath' && vals.length === 1 && vals[0]!.kind === 'url')
        return { kind: 'path', v: vals[0]!.v };
      if (vals.some((v) => v!.kind === 'url')) return null;
      if (fn === 'resolve') return { kind: 'path', v: path.resolve(this.dir, ...strs) };
      if (fn === 'join' && strs.length) {
        const joined = path.join(...strs);
        return { kind: path.isAbsolute(joined) ? 'path' : 'str', v: joined };
      }
      if (fn === 'dirname' && strs.length === 1) return { kind: 'path', v: path.dirname(strs[0]) };
      return null;
    }
    return null;
  }

  private name(dotted: string, depth: number): Val | null {
    if (dotted === '__dirname' || dotted === 'import.meta.dirname')
      return { kind: 'path', v: this.dir };
    if (dotted === 'import.meta.url') return { kind: 'url', v: this.file };
    if (dotted === '__filename' || dotted === 'import.meta.filename')
      return { kind: 'path', v: this.file };
    const c = this.consts.get(dotted);
    return c ? this.value(c[0], c[1], depth + 1) : null;
  }

  /**
   * An alias replacement: a computed absolute path, or a `/`-rooted string
   * (Vite reads `/src` relative to its root). A relative string is used as-is
   * by Vite, not as a file path, so it is skipped.
   */
  replacement(a: number, b: number): { path: string; rootRelative: boolean } | null {
    const v = this.value(a, b);
    if (!v) return null;
    if (v.kind === 'path') return { path: v.v, rootRelative: false };
    if (v.kind === 'str' && v.v.startsWith('/')) return { path: v.v, rootRelative: true };
    return null;
  }
}

/** Static `resolve.alias` entries of one vite config's text. */
export function parseViteAliases(text: string, configFile: string): ViteAlias[] {
  const toks = tokenize(text);
  const ev = new Evaluator(toks, configFile);
  const out: ViteAlias[] = [];
  const keyOf = (t: Tok | undefined): string | null =>
    t && (t.t === 'id' || t.t === 'str') ? t.v : null;
  for (let i = 0; i + 2 < toks.length; i++) {
    if (keyOf(toks[i]) !== 'alias' || !isP(toks[i + 1], ':')) continue;
    const open = i + 2;
    if (isP(toks[open], '{')) {
      let j = open + 1;
      while (j < toks.length && !isP(toks[j], '}')) {
        const key = keyOf(toks[j]);
        if (key !== null && isP(toks[j + 1], ':')) {
          const e = exprEnd(toks, j + 2);
          const r = ev.replacement(j + 2, e);
          if (r) out.push({ find: key, replacement: r.path, rootRelative: r.rootRelative });
          j = e;
        } else j = exprEnd(toks, j);
        if (isP(toks[j], ',')) j++;
      }
    } else if (isP(toks[open], '[')) {
      let j = open + 1;
      while (j < toks.length && !isP(toks[j], ']')) {
        if (isP(toks[j], '{')) {
          let find: string | null = null;
          let rep: { path: string; rootRelative: boolean } | null = null;
          let k = j + 1;
          while (k < toks.length && !isP(toks[k], '}')) {
            const key = keyOf(toks[k]);
            const e = exprEnd(toks, k + 2);
            if (key === 'find' && isP(toks[k + 1], ':') && e === k + 3 && toks[k + 2].t === 'str')
              find = (toks[k + 2] as { v: string }).v;
            else if (key === 'replacement' && isP(toks[k + 1], ':')) rep = ev.replacement(k + 2, e);
            k = isP(toks[k + 1], ':') ? e : exprEnd(toks, k);
            if (isP(toks[k], ',')) k++;
          }
          if (find !== null && rep)
            out.push({ find, replacement: rep.path, rootRelative: rep.rootRelative });
          j = k + 1;
        } else j = exprEnd(toks, j);
        if (isP(toks[j], ',')) j++;
      }
    }
  }
  return out;
}

/** The path `specifier` maps to under `aliases` (first match wins), or null. */
export function applyViteAlias(
  aliases: ViteAlias[],
  specifier: string,
  configDir: string,
): string | null {
  for (const a of aliases) {
    if (!a.find) continue;
    if (specifier !== a.find && !specifier.startsWith(a.find.endsWith('/') ? a.find : `${a.find}/`))
      continue;
    const base = a.rootRelative ? path.join(configDir, a.replacement) : a.replacement;
    return base + specifier.slice(a.find.length);
  }
  return null;
}
