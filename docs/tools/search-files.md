# search_files

Search indexed files by path or summary (supports `%` wildcards).

## Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `query` | string | yes | Search term matched against path and summary |

## Wildcard behaviour

If the query string does not already contain a `%` character, the tool automatically wraps it as `%query%` before running the SQL `LIKE` match. This means a plain word like `schema` is equivalent to `%schema%` and will match any path or summary that contains that word anywhere. Supply your own `%` characters when you need more precise control (e.g. `dashboard%` to match only paths/summaries that _start_ with "dashboard").

Results are capped at **25 rows**, ordered by path.

## Output format

Each match is rendered as a two-line block:

```
<path> (<language>, <line_count> lines, <export_count> exports, <dep_count> deps)
  <summary>
```

With `CODE_CONTEXT_TIMESTAMPS=1` the second line starts with `Modified: <modified_at> | indexed <indexed_at> | `.

Multiple matches are separated by a blank line. When no files match, the tool returns: `No files matching "<query>".`

## Examples

```
search_files schema
search_files %dashboard%
search_files src/scrum
```
