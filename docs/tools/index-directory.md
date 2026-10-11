# index_directory

Scan a directory, parse all files, extract metadata/exports and build a dependency graph.

## Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `path` | string | yes | Absolute path to the directory to index |
| `freshness_check` | boolean | no | If `true`, skip re-indexing when the index is less than 5 minutes old. Returns a compact one-line summary instead of running a full index. |

## Response

A full index run returns a compact markdown summary. Each top-level directory prints its file and line counts once, in its heading (languages follow when the description does not name them), then its description, its files and its sub-directories:

```
# Indexed 42 files, 87 exports, 31 dependencies

## Directories
### src/ — 12 files, 3,400 lines (typescript)
Source code. contains scrum.
- index.ts — MCP server entry point; registers all tools and starts the transport
- indexer.ts — Walks the filesystem, parses files, and writes to the SQLite DB
- scrum/ (8 files) — Scrum MCP tool implementations

## Root files
- package.json — Project manifest and dependency declarations
- tsconfig.json — TypeScript compiler configuration
```

When `freshness_check=true` and the index is less than 5 minutes old, re-indexing is skipped and a compact summary is returned instead:

```
Index fresh (2m ago): 42 files, 87 exports, 31 deps. Skipped re-index.
```

## Example

```
index_directory /home/user/my-project
```

```
index_directory /home/user/my-project freshness_check=true
```
