# query / execute

Escape-hatch tools for direct SQL access to the context database.

Both tools are guarded by an allowlist-based SQL validator (introduced in v1.2.1,
`src/server/sql-guard.ts`). A statement must positively match an allowed shape; the
validator also checks better-sqlite3's internal read/write flag before execution so
that no bypass vector — stacked statements, SQL comments, DDL, a writing PRAGMA, ATTACH,
or a CTE-prefixed write — can reach the database.

## query

Run a single read-only statement against the context database: `SELECT` (or a `WITH` CTE),
`PRAGMA table_info(<table>)` or `PRAGMA table_list`.

| Name  | Type   | Required | Description                                               |
| ----- | ------ | -------- | --------------------------------------------------------- |
| `sql` | string | yes      | One SELECT, `PRAGMA table_info(t)` or `PRAGMA table_list` |

The tool description carries the schema of the code-index tables (`files`, `exports`,
`dependencies`, without `files.content`) and the joins for "who imports X" and "exports of X",
so a reader does not need to dump `sqlite_master` first (#118).

**Constraints (enforced by the SQL guard):**

- Must start with `SELECT` or `WITH` (case-insensitive), or be exactly `PRAGMA table_info(<table>)` / `PRAGMA table_list`.
- Exactly one statement — no semicolons in the body (a single trailing semicolon is stripped).
- SQL comments (`--`, `/*`) are rejected.
- DDL, ATTACH and every other PRAGMA are rejected. The message names what is allowed.
- The statement is additionally verified as a reader by the database driver before execution, so a CTE-prefixed write is caught and refused.

**Output limits** (constants in `src/server/query-output.ts`):

| Limit  | Value             | When hit                                                                                       |
| ------ | ----------------- | ---------------------------------------------------------------------------------------------- |
| Rows   | 50                | Note `Truncated: N of M rows shown (50-row cap)`; M is counted up to 10,000 (`10000+` beyond). |
| Output | ~8 KB of row text | Same note with `8 KB output cap`; the first row always shows.                                  |
| Cell   | 1,000 chars       | Value ends in `…[+N chars]`; read the rest with `substr(col, start, len)`.                     |

The result is a JSON array, one row per line. Notes, if any, follow after a blank line.

**`files.content`** (the whole file text) is returned only when the SELECT list names
`content` (`SELECT content …`, `substr(f.content, 1, 500)`, `f.content AS c`). A `*`, `f.*`,
CTE or subquery that expands to it drops the column and adds a note; SQLite's column-origin
metadata finds it under any alias. A `content` in `WHERE` does not count.

**Table scope.** `query` reads every table, including `sqlite_master` and the scrum tables,
in every profile. A table filter needs a full SQL parser (subqueries, CTEs, `pragma_*`
functions); the output limits already bound a dump to about 8 KB.

```
query sql="SELECT path, line_count FROM files ORDER BY line_count DESC LIMIT 5"
query sql="PRAGMA table_info(dependencies)"
```

## execute

Run a single `INSERT`, `UPDATE`, or `DELETE` statement against the context database.

| Name     | Type   | Required | Description                                      |
| -------- | ------ | -------- | ------------------------------------------------ |
| `sql`    | string | yes      | A single INSERT, UPDATE, or DELETE SQL statement |
| `params` | array  | no       | Optional positional bind parameters              |

**Constraints (enforced by the SQL guard):**

- Must start with `INSERT`, `UPDATE`, or `DELETE` (case-insensitive).
- Exactly one statement — no semicolons in the body (a single trailing semicolon is stripped).
- SQL comments (`--`, `/*`) are rejected.
- DDL, PRAGMA, ATTACH, and SELECT/WITH are not permitted.
- The statement is additionally verified as a writer by the database driver before execution.

**Gate columns (#181):** `execute` refuses a write to a column that a gated tool owns. The error names the column and the tool to use.

| Table        | Refused through `execute`                                          | Use instead                                            |
| ------------ | ------------------------------------------------------------------ | ------------------------------------------------------ |
| `tickets`    | `status`                                                           | `update_ticket`                                        |
| `tickets`    | `qa_verified`, `verified_by`                                       | `update_ticket`                                        |
| `tickets`    | `github_issue`, `github_repo`, `github_node_id` (every `github_*`) | `update_ticket github_issue=<N>`, `sync_github`        |
| `tickets`    | `deleted_at`                                                       | `update_ticket status=NOT_DONE`, dashboard delete      |
| `sprints`    | `status`                                                           | `update_sprint`, `advance_sprint`                      |
| `sprints`    | `deleted_at`, `archived_at`                                        | dashboard sprint delete and archive                    |
| `milestones` | `archived_at`                                                      | `update_milestone archived=true`                       |
| `epics`      | `archived_at`                                                      | `update_epic archived=true`                            |
| `milestones` | every `github_*` column                                            | `update_milestone github_milestone=<N>`, `sync_github` |
| `projects`   | every `github_*` column                                            | `set_project`, `sync_github`                           |

- The check covers the `INSERT` column list, the `UPDATE` `SET` list (also `SET (a, b) = …`, `IS [NOT] DISTINCT FROM` and `UPDATE … FROM`) and `ON CONFLICT … DO UPDATE SET`. Quoted names, schema prefixes and aliases resolve to the real column.
- An `UPDATE` on these tables with a top-level comma or a `name =` after its `FROM` clause is refused; write the join as a subquery in `FROM (…)`.
- `DELETE` on `tickets` and `sprints` is refused: it would drop the row and let a re-insert skip the gates.
- `REPLACE`, `INSERT OR REPLACE` and `UPDATE OR REPLACE` on these tables are refused: the replace deletes the row and resets its gate columns.
- An `INSERT` into these tables without a column list is refused: it writes every column.
- Writes to the other columns and every `SELECT` stay free.

**Return value:** `Rows affected: N, last id: M`

```
execute sql="UPDATE files SET description = ? WHERE path = ?" params=["Main entry point", "/home/user/project/src/index.ts"]
```
