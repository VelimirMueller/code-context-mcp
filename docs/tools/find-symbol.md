# find_symbol

Find which file(s) export a given function, component, type, or constant.

## Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `name` | string | yes | Symbol name to search for (supports `%` wildcards). PHP symbols also by namespace-qualified name: `App\Models\User`, `\App\Models\User` or `App\Models\%`. |

## Examples

Exact match:
```
find_symbol initSchema
```

Wildcard:
```
find_symbol %Schema%
```

PHP, qualified name (results print the qualified name for PHP symbols):
```
find_symbol App\Models\%
```
