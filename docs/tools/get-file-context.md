# get_file_context

What a file exports (one-line signatures with line numbers), its raw import lines, what it imports and what imports it — enough to call a function or trace a dependency without reading the file.

## Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `path` | string | yes | Repo-relative or absolute file path |
| `snippet` | boolean | no | Add each export's source lines below its signature: at most 20 lines per export and about 2 KB in total. Default `false`. |
| `include_changes` | boolean | no | Add recent change history with diffs. Default `false`. |
| `change_limit` | number | no | Max number of recent changes (default `3`). |
| `absolute_paths` | boolean | no | Print absolute paths instead of project-relative ones. |

## Output Sections

- **Header**: path, language, size, line count, timestamps, summary, and `description` (when it differs from the summary)
- **Exports**: `L<line> <signature>` per export (`function formatDate(date: Date): string`, `class Client(models.Base)`, `const area = (s: Shape): number =>`). Signatures are one line, without bodies, capped at 160 characters. Re-exports show `name (re-export)`. At most 40 are listed, then `+N more`.
- **Import lines**: the file's own `import … from '…'`, `export … from '…'`, `require(…)` (JS/TS) and `import …` / `from … import …` (Python) statements, one line each with its line number. At most 30, then `+N more`.
- **External packages**: third-party imports. A tsconfig/jsconfig path alias that resolves to a repo file (`@/lib/format`) is not listed here.
- **Imports from**: local file dependencies with symbols, through relative imports and tsconfig/jsconfig path aliases ([rules](./who-imports.md#path-aliases-tsconfig-jsconfig))
- **Imported by**: reverse dependencies (who uses this file)
- **Recent changes**: only with `include_changes: true`

Signatures, line numbers and import lines are stored at index time (schema v25: `exports.signature`, `exports.line`, `files.import_lines`). A row indexed by an older version is re-indexed on the first `get_file_context` call; when that is not possible it still renders as `name (kind)`.

The header line carries no `modified`/`indexed` timestamps unless `CODE_CONTEXT_TIMESTAMPS=1`. The file is re-checked against the disk before every answer either way; a `↻ fresh: re-indexed …` line says when it changed.

## Example

```
# src/utils/helpers.ts
typescript | 706 B | 33 lines
Utility helper functions
Helper functions. exports formatDate, capitalize, clamp, generateId. constants: DEFAULT_PAGE_SIZE.
## Exports (5)
- L6 function formatDate(date: Date): string
- L13 function capitalize(str: string): string
- L21 function clamp(value: number, min: number, max: number): number
- L28 function generateId(): string
- L32 const DEFAULT_PAGE_SIZE = 20
```
