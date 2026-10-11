# exports_in

What does directory D export, and which exports are unused? Lists every export of the indexed files under a directory (the whole subtree) with its one-line signature and line number. With `unused: true` it keeps only the exports that no indexed file imports.

## Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `dir` | string | yes | Directory: repo-relative (`src/server`, `.`) or absolute. |
| `unused` | boolean | no | Only exports that nothing imports. Default `false`. |
| `absolute_paths` | boolean | no | Print absolute paths instead of project-relative ones. |

## Output

- **Heading**: `# Exports in <dir>: N in M files`, or `# Unused exports in <dir>: K of N — no indexed file imports them`.
- One `## <file>` section per file, then `- L<line> <signature>` per export (`name (kind)` when there is no signature).
- At most 150 exports, then `+N more`.

## When an export counts as used

The answer is conservative: an export that some file imports is never reported as unused.

| Import | Effect |
|--------|--------|
| `import { a }`, `import a`, `import type { a }`, `const { a } = await import(…)` | `a` is used |
| `export { a } from`, `export { a as b } from` | `a` is used only when some file imports the barrel's `a` (or `b`), followed through any number of barrels |
| `export * from` | each name is used only when some file imports it from the barrel |
| `import * as ns`, `export * as ns from`, `import(…)` / `require(…)` without destructuring | every export of the file is used |
| A name the file does not export (a renamed default import, a Python `import pkg.mod`) | every export of the file is used |
| Side-effect `import '…'` | no export is used |

Uses inside the exporting file itself do not count, and neither does a mention in a comment or a same-named identifier in another file. Exports used only from outside the index (tests in an un-indexed folder, a package consumer) show as unused.

## Example

```
exports_in src/server unused=true
```

```
# Unused exports in src/server: 74 of 126 — no indexed file imports them (complete from the import graph)
Used = imported by name, via a re-export that is itself imported, or by a whole-module import (import * as, export * as, import()/require() without names). Uses inside the file itself do not count.
## src/server/git.ts
- L19 const SHA_RE = /^[0-9a-f]
- L38 function resolveGitDir(root: string): string | null
…
```
