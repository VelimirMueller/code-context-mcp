# who_imports

Which files import X? X is a file or an exported symbol. The answer is the complete list from the import graph, so it needs no grep to verify.

## Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `target` | string | yes | A file path (repo-relative, absolute, a unique suffix such as `core.ts`, or a bare module name such as `schema`) or an exported symbol name (`initSchema`). PHP symbols also by qualified name (`App\Models\User`, leading `\` optional). |
| `absolute_paths` | boolean | no | Print absolute paths instead of project-relative ones. |

A bare identifier is read as a symbol first. When no indexed file exports that name, it is read as a file name.

## Output

- **Heading**: the target, the number of files that import it directly, the number that reach it through a re-export, and "complete list from the import graph".
- **One line per importer**: path, the line numbers of its import statements (`L2,L7`), the symbols it takes in brackets, and a flag:
  - `(re-export)`: the file re-exports the target (`export { a } from`, `export * from`). It is a barrel.
  - `(whole module)`: symbol mode only. The file takes every export (`import * as ns`, `import()` without destructuring), so it may use the symbol.
- **Via re-export**: files that import the target one hop through a barrel listed above, with the barrel named. Files that also import the target directly are not repeated.
- At most 100 lines per list, then `+N more`.

Symbol mode lists the file that defines the symbol (not a barrel that only re-exports it), then only the files that take that symbol: by name, through a re-export, or as a whole module. A renamed re-export (`export { beta as betaRenamed }`) is followed under its new name.

## What the graph holds

Edges come from relative imports of indexed files and from tsconfig/jsconfig path aliases: `import … from`, `import type`, side-effect `import '…'`, `export … from`, dynamic `import('…')` and `require('…')` (JS/TS), `import` / `from … import` (Python), and for PHP: `use` (grouped, aliased, `use function`, `use const`), `extends`, `implements`, trait `use`, and class names in code (`new X`, `X::`, `X::class`, `instanceof`, `catch`, type hints, `\A\B` names). Not in the graph: package imports and files the index skips (git-ignored, binary or over the size limit). Databases indexed before this release lack the re-export, type-import and dynamic-import edges until the next full re-index.

### Path aliases (tsconfig / jsconfig)

A bare specifier such as `@/lib/format` or `components/Button` resolves the way TypeScript resolves it:

- **Config**: the nearest `tsconfig.json` (else `jsconfig.json`) from the importing file up to the index root. Its `extends` chain applies (relative files, and package configs such as `@tsconfig/…` from `node_modules`; a missing package is ignored).
- **Solution configs**: when that config does not hold `paths`/`baseUrl` for the file itself, the first `references` entry whose `files`/`include` (minus `exclude`) covers the file is used. A Vite app's `tsconfig.json` → `tsconfig.app.json` works with no setup.
- **`paths`**: exact keys first, then the `*` pattern with the longest prefix; targets are tried in order. They are relative to `baseUrl`, else to the config that sets `paths`. `${configDir}` is expanded.
- **`baseUrl`**: a bare import resolves when `<baseUrl>/<specifier>` exists, else it stays an external package.
- **Files**: the same probing as a relative import (`.ts`, `.tsx`, `.d.ts`, `.js`, `.jsx`, `.mjs`, `.cjs`, `/index.*`); a `.js` specifier finds its `.ts` source. A target outside the index root never resolves.

Not read: Vite `resolve.alias` (the usual setup mirrors tsconfig `paths`), webpack aliases, `package.json` `imports`. A changed tsconfig takes effect on the next full re-index of the repo.

### PHP

- A name resolves the way PHP resolves it: fully qualified as written, else through the file's `use` aliases, else in the file's namespace. A same-namespace class needs no `use`; it is an edge when that class is indexed.
- The file comes from the nearest `composer.json` `autoload.psr-4` / `autoload-dev.psr-4` map (paths relative to that `composer.json`, which may sit in a subdirectory such as `laravel/`; every `composer.json` up to the indexed root is tried), then from the indexed declarations (classmap and `files` autoloads, functions, constants).
- `vendor/` and Laravel `storage/` are not indexed. A name under no project PSR-4 prefix (`Illuminate\…`) goes to the file's external packages as its namespace root (`Illuminate`), not to the graph. Global names (`\Exception`) are neither.
- Comments, strings, heredoc/nowdoc and inline HTML (Blade views) create no edge. A controller named only in a string (`'App\Http\Controllers\X@show'`) is not an edge; `[X::class, 'show']` is.
- The line numbers are the `use` statements that reach the target; a file that reaches it without one (same namespace, `extends \A\B`) shows its first reference.

## Example

```
who_imports src/server/schema.ts
```

```
# src/server/schema.ts: imported by 4 files — complete list from the import graph
- src/dashboard/dashboard.ts L10 [initSchema]
- src/server/index.ts L10 [initSchema]
- src/server/reindex-cli.ts L14 [initSchema]
- src/server/setup.ts L6 [initSchema]
```

A barrel and the file behind it:

```
# src/utils/helpers.ts: imported by 1 file (+1 through re-exports) — complete list from the import graph
- src/utils/index.ts L2 [export formatDate, export capitalize, export clamp, export generateId, export DEFAULT_PAGE_SIZE] (re-export)
## Via re-export (1): import it through a barrel above
- src/index.ts L2 [formatDate, capitalize, DEFAULT_PAGE_SIZE] via src/utils/index.ts
```
