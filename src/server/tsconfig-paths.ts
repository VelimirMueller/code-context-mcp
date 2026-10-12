/**
 * tsconfig / jsconfig path aliases for the import graph (CCA-18, #151).
 *
 * The indexer resolved only relative imports, so `import { x } from "@/lib/x"`
 * made no edge: on a real Vite React SPA ~950 alias imports gave 179 edges and
 * who_imports answered 0. This module finds the config that governs a file and
 * maps a bare specifier through its `paths` / `baseUrl`, as TypeScript does:
 *
 * - Nearest `tsconfig.json` (else `jsconfig.json`) walking up from the file's
 *   directory, never above the index root.
 * - `extends` (string or array): relative files, and package specs such as
 *   `@tsconfig/strictest/tsconfig.json` looked up in `node_modules` under the
 *   root (missing → ignored). Later entries and the child override; cycles and
 *   chains deeper than MAX_EXTENDS_DEPTH stop.
 * - Solution configs: when the nearest config does not cover the file itself
 *   with alias options, the first `references` entry whose `files`/`include`
 *   (minus `exclude`) covers the file and has `paths`/`baseUrl` is used (Vite's
 *   tsconfig.json → tsconfig.app.json). Last fallback: the nearest config.
 * - `paths`: exact keys first, then patterns with one `*`, longest prefix wins;
 *   targets are tried in order. Targets are relative to `baseUrl`, else to the
 *   directory of the config that set `paths` (TS 4.1+). `${configDir}` expands
 *   to the governing config's directory (TS 5.5).
 * - A specifier no `paths` target resolves falls back to `baseUrl/<spec>`;
 *   one that resolves nowhere stays an external package import.
 * - Each candidate goes through the same extension/index probing as a relative
 *   import, including `.js` specifiers that name `.ts` sources. Every resolved
 *   file must lie inside the index root.
 *
 * Vite `resolve.alias` is not read: the common setup mirrors tsconfig `paths`,
 * and a vite.config is code (path.resolve(__dirname, …)), not data.
 *
 * Config text is JSON with comments and trailing commas. It is parsed by a
 * linear-time scanner (no regex on the file), files above MAX_CONFIG_BYTES are
 * ignored, and include globs are matched segment-wise without regexes.
 */
import fs from "node:fs";
import path from "node:path";

export const MAX_CONFIG_BYTES = 1024 * 1024;
const MAX_EXTENDS_DEPTH = 16;
const MAX_GLOB_LENGTH = 4096;
const CONFIG_NAMES = ["tsconfig.json", "jsconfig.json"];

/** Extensions tried after a specifier, in TypeScript's order (then plain JS). */
export const RESOLVE_EXTENSIONS = [".ts", ".tsx", ".d.ts", ".js", ".jsx", ".mjs", ".cjs"];

function insideOrSame(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * Candidate files for an import that points at `base` (an absolute path
 * without guaranteed extension), in probe order: the path itself, the
 * extensionless form of a `.js`-family specifier, `base` + each extension,
 * then `base/index.*`.
 */
export function fileCandidates(base: string): string[] {
  const stripped = base.replace(/\.(?:[mc]?js|jsx)$/, "");
  return [
    base,
    stripped,
    ...RESOLVE_EXTENSIONS.map((ext) => base + ext),
    ...RESOLVE_EXTENSIONS.map((ext) => stripped + ext),
    ...RESOLVE_EXTENSIONS.map((ext) => path.join(base, "index" + ext)),
  ];
}

/** First candidate of `base` that is a file inside `rootDir`, else null. */
export function probeFile(base: string, rootDir: string, isFile: (p: string) => boolean): string | null {
  for (const c of fileCandidates(base)) {
    // Containment check: never resolve to a file outside rootDir, even if a
    // ../ sequence or an alias target points at a real file elsewhere (#14).
    if (insideOrSame(c, rootDir) && isFile(c)) return c;
  }
  return null;
}

// ─── Lenient JSON (comments, trailing commas) ────────────────────────────────

/**
 * JSONC → JSON in one linear pass: drops `//` and `/* *\/` comments outside
 * strings and commas that only precede `}` or `]`. String contents (including
 * `"@/*"` and `"//"`) are copied untouched. Returns text for JSON.parse.
 */
export function stripJsonc(text: string): string {
  const out: string[] = [];
  let lastSig = -1; // index in `out` of the last significant (non-blank) char
  const n = text.length;
  let i = 0;
  while (i < n) {
    const c = text[i];
    if (c === '"') {
      const start = i++;
      while (i < n && text[i] !== '"') i += text[i] === "\\" ? 2 : 1;
      i++;
      out.push(text.slice(start, Math.min(i, n)));
      lastSig = out.length - 1;
      continue;
    }
    if (c === "/" && text[i + 1] === "/") {
      while (i < n && text[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end === -1 ? n : end + 2;
      out.push(" ");
      continue;
    }
    if ((c === "}" || c === "]") && lastSig >= 0 && out[lastSig] === ",") out[lastSig] = " ";
    out.push(c);
    if (c !== " " && c !== "\t" && c !== "\n" && c !== "\r") lastSig = out.length - 1;
    i++;
  }
  return out.join("");
}

/** Parse a tsconfig-style file; null when missing, too big or not an object. */
export function readJsonc(file: string): Record<string, unknown> | null {
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > MAX_CONFIG_BYTES) return null;
    let text = fs.readFileSync(file, "utf-8");
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    const v = JSON.parse(stripJsonc(text));
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

// ─── Glob matching for include / exclude ─────────────────────────────────────

/** One path segment against one pattern segment with `*` and `?` (two-pointer, O(n·m)). */
function segmentMatch(pat: string, seg: string): boolean {
  let p = 0;
  let s = 0;
  let star = -1;
  let mark = 0;
  while (s < seg.length) {
    if (p < pat.length && (pat[p] === "?" || pat[p] === seg[s])) {
      p++;
      s++;
    } else if (p < pat.length && pat[p] === "*") {
      star = p++;
      mark = s;
    } else if (star !== -1) {
      p = star + 1;
      s = ++mark;
    } else return false;
  }
  while (p < pat.length && pat[p] === "*") p++;
  return p === pat.length;
}

/**
 * True when absolute `file` matches the tsconfig include/exclude `pattern`
 * (absolute, already resolved against its config dir): `**` any directories,
 * `*` and `?` within one segment. A pattern also covers everything under it
 * (include "src" = src/**). Matching is segment-wise with memoisation — no
 * regex is built from config text, so a hostile pattern cannot backtrack.
 */
export function globMatch(pattern: string, file: string): boolean {
  if (pattern.length > MAX_GLOB_LENGTH) return false;
  const ps = pattern.split(/[\\/]+/).filter(Boolean);
  const fs_ = file.split(/[\\/]+/).filter(Boolean);
  const memo = new Map<number, boolean>();
  const go = (i: number, j: number): boolean => {
    if (i === ps.length) return true; // pattern exhausted: file is at or under it
    if (j === fs_.length) return ps.slice(i).every((x) => x === "**");
    const key = i * (fs_.length + 1) + j;
    const hit = memo.get(key);
    if (hit !== undefined) return hit;
    const r = ps[i] === "**" ? go(i + 1, j) || go(i, j + 1) : segmentMatch(ps[i], fs_[j]) && go(i + 1, j + 1);
    memo.set(key, r);
    return r;
  };
  return go(0, 0);
}

// ─── Config loading ──────────────────────────────────────────────────────────

interface Patterns {
  base: string;
  list: string[];
}

/** One config after its `extends` chain is applied. */
export interface ResolvedConfig {
  file: string;
  dir: string;
  baseUrl?: string;
  paths?: Record<string, string[]>;
  /** Directory `paths` targets are relative to: baseUrl, else the config that set paths. */
  pathsBase?: string;
  files?: Patterns;
  include?: Patterns;
  exclude?: Patterns;
  references: string[];
}

function expandConfigDir(s: string, dir: string): string {
  return s.includes("${configDir}") ? s.split("${configDir}").join(dir) : s;
}

function stringList(v: unknown): string[] | undefined {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : undefined;
}

function pathsMap(v: unknown): Record<string, string[]> | undefined {
  if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
  const out: Record<string, string[]> = {};
  for (const [k, targets] of Object.entries(v as Record<string, unknown>)) {
    const list = stringList(targets);
    if (list?.length) out[k] = list;
  }
  return out;
}

export class AliasResolver {
  private readonly configs = new Map<string, ResolvedConfig | null>();
  private readonly nearest = new Map<string, string | null>();
  private readonly governing = new Map<string, ResolvedConfig | null>();
  private readonly fileCache = new Map<string, boolean>();

  constructor(readonly rootDir: string) {}

  isFile = (p: string): boolean => {
    let hit = this.fileCache.get(p);
    if (hit === undefined) {
      try {
        hit = fs.statSync(p).isFile();
      } catch {
        hit = false;
      }
      this.fileCache.set(p, hit);
    }
    return hit;
  };

  /**
   * The file a bare (non-relative) specifier names, through the governing
   * config's `paths` and `baseUrl`; null = external package or unknown.
   */
  resolve(specifier: string, fromFile: string): string | null {
    if (!specifier || specifier.startsWith(".") || specifier.startsWith("/") || specifier.includes("\0")) return null;
    const cfg = this.configFor(fromFile);
    if (!cfg) return null;
    if (cfg.paths && cfg.pathsBase) {
      for (const target of matchPaths(cfg.paths, specifier)) {
        const hit = probeFile(path.resolve(cfg.pathsBase, expandConfigDir(target, cfg.dir)), this.rootDir, this.isFile);
        if (hit) return hit;
      }
    }
    if (cfg.baseUrl) return probeFile(path.resolve(cfg.baseUrl, specifier), this.rootDir, this.isFile);
    return null;
  }

  /** The config whose aliases apply to `file`, or null. */
  configFor(file: string): ResolvedConfig | null {
    const dir = path.dirname(file);
    const nearestFile = this.nearestConfig(dir);
    if (!nearestFile) return null;
    const key = `${nearestFile}\0${file}`;
    if (this.governing.has(key)) return this.governing.get(key)!;
    const cfg = this.load(nearestFile);
    let out: ResolvedConfig | null = null;
    if (cfg) {
      const hasOpts = (c: ResolvedConfig) => !!(c.paths || c.baseUrl);
      if (hasOpts(cfg) && this.covers(cfg, file)) out = cfg;
      else {
        for (const ref of cfg.references) {
          const rc = this.load(ref);
          if (rc && hasOpts(rc) && this.covers(rc, file)) {
            out = rc;
            break;
          }
        }
        if (!out && hasOpts(cfg)) out = cfg;
      }
    }
    this.governing.set(key, out); // per file: include globs can depend on the name
    return out;
  }

  /** Nearest tsconfig.json / jsconfig.json from `dir` up to the root. */
  private nearestConfig(dir: string): string | null {
    if (this.nearest.has(dir)) return this.nearest.get(dir)!;
    let found: string | null = null;
    if (insideOrSame(dir, this.rootDir)) {
      for (const name of CONFIG_NAMES) {
        const f = path.join(dir, name);
        if (this.isFile(f)) {
          found = f;
          break;
        }
      }
      if (!found && dir !== this.rootDir) {
        const parent = path.dirname(dir);
        if (parent !== dir) found = this.nearestConfig(parent);
      }
    }
    this.nearest.set(dir, found);
    return found;
  }

  /** True when `cfg`'s files / include (minus exclude) take `file`. */
  private covers(cfg: ResolvedConfig, file: string): boolean {
    const abs = (pats: Patterns, p: string) => path.resolve(pats.base, expandConfigDir(p, cfg.dir));
    const matches = (pats: Patterns | undefined): boolean => !!pats && pats.list.some((p) => globMatch(abs(pats, p), file));
    if (cfg.files && cfg.files.list.some((f) => abs(cfg.files!, f) === file)) return true;
    // No files and no include: TypeScript includes everything under the config.
    const include = cfg.include ?? (cfg.files ? undefined : { base: cfg.dir, list: ["**/*"] });
    return matches(include) && !matches(cfg.exclude);
  }

  /** Parse `file` with its extends chain applied (cached). */
  load(file: string, seen: Set<string> = new Set()): ResolvedConfig | null {
    if (this.configs.has(file)) return this.configs.get(file)!;
    if (seen.has(file) || seen.size >= MAX_EXTENDS_DEPTH || !insideOrSame(file, this.rootDir)) return null;
    seen.add(file);
    const raw = readJsonc(file);
    if (!raw) {
      this.configs.set(file, null);
      return null;
    }
    const dir = path.dirname(file);
    const cfg: ResolvedConfig = { file, dir, references: [] };
    const ext = raw.extends;
    for (const spec of typeof ext === "string" ? [ext] : (stringList(ext) ?? [])) {
      const parentFile = this.extendsTarget(spec, dir);
      const parent = parentFile ? this.load(parentFile, new Set(seen)) : null;
      if (!parent) continue;
      for (const k of ["baseUrl", "paths", "pathsBase", "files", "include", "exclude"] as const) {
        if (parent[k] !== undefined) (cfg as unknown as Record<string, unknown>)[k] = parent[k];
      }
    }
    const opts = raw.compilerOptions && typeof raw.compilerOptions === "object" ? (raw.compilerOptions as Record<string, unknown>) : {};
    // ${configDir} in baseUrl expands here; in paths targets and include /
    // exclude / files it expands to the governing config's dir at use time.
    if (typeof opts.baseUrl === "string") cfg.baseUrl = path.resolve(dir, expandConfigDir(opts.baseUrl, dir));
    const paths = pathsMap(opts.paths);
    if (paths) {
      cfg.paths = paths;
      cfg.pathsBase = dir;
    }
    // paths are relative to baseUrl when one is set anywhere in the chain.
    if (cfg.paths && cfg.baseUrl) cfg.pathsBase = cfg.baseUrl;
    const files = stringList(raw.files);
    const include = stringList(raw.include);
    const exclude = stringList(raw.exclude);
    if (files) cfg.files = { base: dir, list: files };
    if (include) cfg.include = { base: dir, list: include };
    if (exclude) cfg.exclude = { base: dir, list: exclude };
    if (Array.isArray(raw.references)) {
      for (const r of raw.references) {
        const p = r && typeof r === "object" ? (r as { path?: unknown }).path : undefined;
        if (typeof p !== "string") continue;
        const abs = path.resolve(dir, p);
        cfg.references.push(abs.endsWith(".json") ? abs : path.join(abs, "tsconfig.json"));
      }
    }
    this.configs.set(file, cfg);
    return cfg;
  }

  /** The file an `extends` value names, or null (missing package, outside the root). */
  private extendsTarget(spec: string, fromDir: string): string | null {
    const withJson = (p: string): string | null => {
      if (this.isFile(p)) return p;
      if (!p.endsWith(".json") && this.isFile(p + ".json")) return p + ".json";
      return null;
    };
    if (spec.startsWith(".") || path.isAbsolute(spec)) return withJson(path.resolve(fromDir, spec));
    // Package spec: node_modules/<spec>[.json] or node_modules/<pkg>/tsconfig.json,
    // looked up from the config's directory to the root.
    let dir = fromDir;
    for (;;) {
      const base = path.join(dir, "node_modules", spec);
      const hit = withJson(base) ?? withJson(path.join(base, "tsconfig.json"));
      if (hit) return hit;
      if (dir === this.rootDir || !insideOrSame(dir, this.rootDir)) return null;
      const parent = path.dirname(dir);
      if (parent === dir) return null;
      dir = parent;
    }
  }
}

/**
 * Substitution targets for `specifier` under `paths`, in TypeScript's order:
 * an exact key wins; else the `*` pattern with the longest prefix. Keys with
 * more than one `*` are invalid and ignored.
 */
export function matchPaths(paths: Record<string, string[]>, specifier: string): string[] {
  if (Object.prototype.hasOwnProperty.call(paths, specifier) && !specifier.includes("*")) return paths[specifier];
  let best: { prefix: string; star: string; key: string } | null = null;
  for (const key of Object.keys(paths)) {
    const star = key.indexOf("*");
    if (star === -1 || key.indexOf("*", star + 1) !== -1) continue;
    const prefix = key.slice(0, star);
    const suffix = key.slice(star + 1);
    if (specifier.length < prefix.length + suffix.length) continue;
    if (!specifier.startsWith(prefix) || !specifier.endsWith(suffix)) continue;
    if (!best || prefix.length > best.prefix.length) {
      best = { prefix, key, star: specifier.slice(prefix.length, specifier.length - suffix.length) };
    }
  }
  if (!best) return [];
  const captured = best.star;
  return paths[best.key].map((t) => t.replace("*", captured));
}
