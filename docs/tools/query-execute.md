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

**Return value:** `Rows affected: N, last id: M`

```
execute sql="UPDATE files SET description = ? WHERE path = ?" params=["Main entry point", "/home/user/project/src/index.ts"]
```
