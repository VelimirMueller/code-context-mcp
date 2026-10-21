# Import-graph accuracy against the TypeScript compiler (CCA-38, #182)

Date: 2026-10-19. Script: `scripts/research/import-graph-accuracy.mts`
(`pnpm run research:import-accuracy` runs it on this repo).

## Result

- After the fixes in this change, the indexed JS/TS import graph matches the
  compiler on three repos: **edge recall 100 %**, **edge precision 99.9–100 %**
  (bundler-only edges counted correct).
- Before the fixes, edge recall was **90.3 %** on this repo and **85.3 %** on
  the NestJS fixture. Two gaps caused every missed edge: `.mts`/`.cts` files
  were not parsed (75 edges), and workspace packages linked through
  `node_modules` were not resolved (818 edges).
- `exports_in` recall is 78.8–95.9 %. The rest are `export *` and
  `export * as` re-exports (listed under the source file, by design) and
  unnamed `export default` expressions.
- Vite `resolve.alias` is now read (static forms). On the three repos and on
  every Vite config on this machine it adds no edge, because tsconfig `paths`
  mirrors each alias.
- **Decision: TS/JS stays on the regex parser.** The compiler API costs about
  23 MB of install, about 135 MB more resident memory, and about 0.8 s more per
  index of the 2,046-file fixture, for a gap of under 0.1 % of edges.

## Method

1. **Index.** The real indexer (`indexDirectory`) indexes the repo into a
   throwaway SQLite file in a temp directory. The shared `context.db` is never
   touched; the repo is only read.
2. **Ground truth.** Every indexed JS/TS file (`.ts .tsx .mts .cts .js .jsx
.mjs .cjs`) is parsed with `ts.createSourceFile`. Every module reference is
   collected: `import`, `import type`, `export … from`, `import()`,
   `require()`, `import x = require()`, `import("x")` type nodes. Each is
   resolved with `ts.resolveModuleName` and the file's module format
   (`getModeForUsageLocation`) under its governing config:
   - the nearest `tsconfig.json`/`jsconfig.json`, or a project it references
     (depth-first), whose file list holds the file;
   - else bundler defaults, as the editor's inferred project does (files
     outside every `include`, such as `test/` here).
   - `allowJs` and `resolveJsonModule` are forced on.
3. **Scope.** An edge is source → target inside the repo, both indexed.
   Sources are JS/TS files; targets are JS/TS or `.json`. Asset edges (css,
   svg) are counted but not scored (1, 3 and 0 per repo).
4. **Scores.** Edge precision and recall over all edges. `who_imports`: the
   direct importers in the tool's answer for 50 sampled files that have an
   importer on either side (seed 182). `exports_in`: the export names the tool
   lists (the `exports` table) for 50 sampled files that contain `export`,
   against `TypeChecker.getExportsOfModule` (a named default export counts by
   its name).
5. **Categories.** Each false negative is checked against the regex parser
   (did it see the specifier?) and the resolver (did it find nothing, or
   another file?). Each false positive is checked against the compiler's
   references in that file.

Repos: this repo at the branch head (TS, nested Vite app in
`src/dashboard/app` with its own tsconfig and aliases), `portfolio-website`
(Next.js, `@/*` paths), and the NestJS bench fixture pinned by
`fixture.lock` (v12.1.1, 9feedffd, 2,046 source files: a monorepo with
`packages/*` linked into `node_modules/@nestjs/*`, project references and
per-directory tsconfigs).

## Numbers

Edges (precision / recall, true positives / false positives / false
negatives):

| Repo              | JS/TS files | Before                             | After                           | After, bundler-only counted correct |
| ----------------- | ----------: | ---------------------------------- | ------------------------------- | ----------------------------------- |
| this repo         |         358 | 99.9 % / 90.3 % (701 / 1 / 75)     | 99.9 % / 100 % (776 / 1 / 0)    | 99.9 % / 100 %                      |
| portfolio-website |         274 | 100 % / 100 % (504 / 0 / 0)        | 100 % / 100 % (504 / 0 / 0)     | 100 % / 100 %                       |
| NestJS fixture    |       2,046 | 99.1 % / 85.3 % (4,731 / 41 / 818) | 99.2 % / 100 % (5,549 / 47 / 0) | 99.98 % / 100 %                     |

Alias edges (non-relative specifier that resolves into the repo): this repo
252 / 252, portfolio-website 200 / 200, NestJS 918 of 1,736 before and
1,736 of 1,736 after.

Tool answers on the 50-file samples (precision / recall, exact answers):

| Repo              | who_imports before   | who_imports after   | exports_in before    | exports_in after     |
| ----------------- | -------------------- | ------------------- | -------------------- | -------------------- |
| this repo         | 99.4 % / 90.7 % (42) | 99.4 % / 100 % (49) | 95.2 % / 85.3 % (40) | 95.1 % / 95.7 % (43) |
| portfolio-website | 100 % / 100 % (50)   | 100 % / 100 % (50)  | 100 % / 88.4 % (36)  | 100 % / 95.9 % (45)  |
| NestJS fixture    | 98.9 % / 100 % (48)  | 98.9 % / 100 % (48) | 100 % / 78.8 % (44)  | 100 % / 78.8 % (44)  |

## Error categories

Edge false negatives, before → after:

| Category                                             | this repo | portfolio |  NestJS |
| ---------------------------------------------------- | --------: | --------: | ------: |
| `.mts` / `.cts` not parsed                           |    75 → 0 |         0 |       0 |
| node_modules workspace package                       |         0 |         0 | 818 → 0 |
| path alias (tsconfig `paths`)                        |         0 |         0 |       0 |
| unresolved relative path, index file, extensionless  |         0 |         0 |       0 |
| parser missed re-export / type-only / dynamic import |         0 |         0 |       0 |

Edge false positives, after:

| Category                                             | this repo | portfolio | NestJS |
| ---------------------------------------------------- | --------: | --------: | -----: |
| import text inside a comment or string               |         1 |         0 |      1 |
| extensionless import that only bundler rules resolve |         0 |         0 |     46 |

- The 46 NestJS cases are spec files in `"type": "module"` packages under
  `Node16` resolution. `tsc` wants `../../constants.js` there; Vitest
  resolves `../../constants`. The edges are real, so the adjusted precision
  counts them correct.
- The comment/string cases: the fixture's commented-out import here, and a
  message string `import them from "@nestjs/platform-express"` in NestJS. The
  regex parser reads raw text.

`exports_in` misses, after (names on the sample):

| Category                                             | this repo | portfolio | NestJS |
| ---------------------------------------------------- | --------: | --------: | -----: |
| `export *` re-export                                 |         2 |         0 |     14 |
| `export * as ns` re-export                           |         4 |         0 |      0 |
| unnamed `export default <expression>`                |         2 |         5 |      3 |
| `export default async function`, `function*` (fixed) |         0 |     9 → 0 |      0 |

`exports_in` extras: 9 names on this repo's sample come from code inside
test-file strings (fixture source in template literals).

## Vite `resolve.alias`

- Before: the resolver read tsconfig/jsconfig `paths` and `baseUrl`, not Vite.
- Now: `src/server/vite-alias.ts` reads the nearest `vite.config.*` with a
  linear tokenizer (the file is never run). It takes the object form and the
  array form with a string `find`; values from `path.resolve`/`join`/`dirname`,
  `fileURLToPath(new URL(…, import.meta.url))`, `${__dirname}/…` templates,
  `/src` strings and local consts. A RegExp `find`, a relative string and any
  other call are skipped. Vite aliases apply after tsconfig `paths` and before
  `baseUrl`.
- Measured gap: **0 edges** on the three repos. This repo's Vite app has two
  aliases (`@`, `@bench`, 296 specifiers); its tsconfig mirrors both. A survey
  of the 19 `vite.config.*` files on this machine found 11 with an alias and 22
  alias entries; the tokenizer read all 22 and tsconfig `paths` mirrors all 22.
- The support matters for JS-only Vite apps (no tsconfig/jsconfig) and for
  aliases the tsconfig forgets. It is a small, tested change, so it ships.

## Decision: does TS/JS move to the compiler API?

**No.** Keep the regex parser and the resolver; keep the compiler as a
dev-time oracle.

|                                | Regex indexer (after)    | Compiler API (parse + resolve only)                      |
| ------------------------------ | ------------------------ | -------------------------------------------------------- |
| Install                        | 0 (no new dependency)    | `typescript` as a runtime dependency: 23 MB              |
| Time per index, NestJS fixture | 1.3–1.5 s (whole index)  | +0.8 s for 2,046 files, plus 0.23 s to load `typescript` |
| Peak RSS                       | 134 MB                   | about 310 MB (216 MB with `typescript` loaded and idle)  |
| Edge recall / precision        | 100 % / 99.9 % or better | 100 % / 100 % by definition                              |

- The measured gap after the fixes is 2 of 6,831 indexed edges (comment/string text)
  plus exports the index leaves out on purpose. The compiler would close that
  gap, but it would add 23 MB to the install and more than double peak memory
  for every user, including Python and PHP repos.
- The fixes cost the regex indexer about 0.23 s on the fixture (1.15 s → 1.38 s, median of six runs: the `node_modules` link lookups and the newly parsed files).
- The compiler stays useful for checking: the script runs in seconds, so a
  regression in the resolver shows up as a recall drop.

What would change this:

- A repo where edge recall stays under about 97 % after resolver fixes, for a
  reason a regex cannot see (package `exports` maps with conditions, computed
  specifiers, `declare module` redirects).
- A feature that needs types: callers of a symbol, references through
  re-exports, rename safety. That needs a `TypeChecker`, not a better parser.
- `typescript` already in the target repo's `node_modules`: loading that copy
  on demand would remove the install cost and could serve the cases above.

Next steps the numbers support (not in this change):

- Blank comments and strings before the JS/TS regexes run (removes the
  comment/string false positives and the 9 test-string exports). JSX text
  makes a naive blanker unsafe, so it needs its own tests.
- Name unnamed default exports `default` in the `exports` table.
- Read package.json `exports` for workspace packages (today: `types`,
  `typings`, `module`, `main`, `index.*`).
