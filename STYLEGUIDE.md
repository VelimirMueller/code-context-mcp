# Styleguide — vlm-code-context-mcp

Conventions and patterns extracted from the living codebase. Follow these when contributing.

---

## 1. Language & Tooling

| Tool        | Version / Config                                              |
| ----------- | ------------------------------------------------------------- |
| TypeScript  | `strict: true`, `target: esnext`, `module: nodenext`          |
| Module      | ESM (`"type": "module"` in package.json)                      |
| Prettier    | single quotes, trailing commas, 100 char width, 2-space tab   |
| ESLint      | `@eslint/js` + `typescript-eslint` recommended                |
| Test runner | Vitest (backend `test/`), Vitest + Testing Library (frontend) |
| E2E         | Playwright                                                    |
| Git hooks   | Husky + lint-staged (`tsc --noEmit` + ESLint + Prettier)      |

---

## 2. File & Directory Structure

```
src/
  server/          # MCP server, indexer, schema (stdio transport)
  scrum/           # Scrum system — schema, tools, defaults
  bridge/          # Dashboard ↔ Claude bridge
  dashboard/       # Dashboard HTTP server
    app/           # React SPA (Vite)
      src/
        components/
          atoms/       # Smallest UI primitives (Badge, Button, Skeleton)
          molecules/   # Composed atoms (TicketCard, SearchBar, TabBar)
          organisms/   # Full sections (KanbanBoard, BurndownChart, SprintDetail)
        pages/         # Route-level views (Dashboard, Team, CodeExplorer)
        hooks/         # Custom React hooks (useSprints, useAgents)
        stores/        # Zustand stores (sprintStore, agentStore)
        lib/           # Shared utilities (api, motion, utils, phases)
        test/          # Frontend tests
  remotion/        # Video generation (Remotion)
test/              # Backend tests
  helpers/         # Test utilities (createTestDb)
  fixtures/        # Static test data
  e2e/             # End-to-end tests
```

---

## 3. Naming Conventions

| Thing            | Style              | Example                                          |
| ---------------- | ------------------ | ------------------------------------------------ |
| Files (backend)  | camelCase          | `indexer.ts`, `schema.ts`, `tools.ts`            |
| Files (React)    | PascalCase         | `Badge.tsx`, `KanbanBoard.tsx`                   |
| Files (hooks)    | camelCase          | `useSprints.ts`, `useAgents.ts`                  |
| Files (stores)   | camelCase          | `agentStore.ts`, `sprintStore.ts`                |
| Files (tests)    | kebab-case         | `smoke.test.ts`, `sprint-lifecycle.test.ts`      |
| Functions        | camelCase          | `registerScrumTools`, `checkSprintGates`         |
| React components | PascalCase         | `function Badge()`, `function TicketCard()`      |
| Interfaces       | PascalCase, no `I` | `interface BadgeProps`, `interface AgentDefault` |
| Type aliases     | PascalCase         | `type BadgeVariant = 'fn' \| 'type'`             |
| Constants        | UPPER_SNAKE_CASE   | `PHASE_TRANSITIONS`, `SKIP_DIRS`                 |
| Zustand stores   | `use[Name]Store`   | `useAgentStore`, `useSprintStore`                |
| Custom hooks     | `use[Name]`        | `useSprints`, `useSearch`                        |
| SQL tables       | snake_case         | `retro_findings`, `sprint_metrics`               |
| SQL columns      | snake_case         | `created_at`, `story_points`                     |
| SQL indexes      | `idx_` prefix      | `idx_tickets_sprint_id`                          |

---

## 4. TypeScript Patterns

### Imports

- Use `import type` for type-only imports. This is enforced consistently:
  ```ts
  import type Database from 'better-sqlite3';
  import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
  ```
- Use `.js` extensions in relative imports (required by `nodenext` resolution):
  ```ts
  import { initSchema } from './schema.js';
  ```
- Frontend uses the `@/` path alias (maps to `src/`):
  ```ts
  import { useSprints } from '@/hooks/useSprints';
  import type { Ticket } from '@/types';
  ```

### Exports

- **Named exports only.** No default exports anywhere in the codebase.
- Use `export function` declarations for exported functions (not arrow functions):
  ```ts
  export function initScrumSchema(db: Database.Database): void { ... }
  ```
- Barrel files (`index.ts`) re-export from each atomic layer:
  ```ts
  export { Badge } from './Badge';
  export { Button } from './Button';
  ```

### Type Annotations

- Explicit return types on exported functions.
- `as any` casts are acceptable for SQLite row results (conscious trade-off, ESLint warns).
- Prefix unused parameters with `_`:
  ```ts
  callback(_event: Event) { ... }
  ```

---

## 5. React Patterns

### Component Structure

Components follow **atomic design**: atoms → molecules → organisms → pages.

```tsx
// 1. Imports (React, libraries, local)
import { motion } from 'framer-motion';
import { cardHover } from '@/lib/motion';
import type { Ticket } from '@/types';

// 2. Types / interfaces (above the component)
interface TicketCardProps {
  ticket: Ticket;
  onClick?: () => void;
}

// 3. Constants (lookup maps, static data)
const priorityColor: Record<string, string> = {
  P0: 'var(--red)',
  P1: 'var(--orange)',
};

// 4. Named export function component
export function TicketCard({ ticket, onClick }: TicketCardProps) {
  return ( ... );
}
```

### Styling

- **Inline styles** with `React.CSSProperties` — not CSS modules.
- CSS custom properties (`var(--surface)`, `var(--border)`, `var(--text2)`) for theming.
- Tailwind CSS v4 is available and used selectively alongside inline styles.

### Animation

- Framer Motion for all animations.
- Shared variants live in `lib/motion.ts` (`pageVariants`, `cardHover`, `listItemVariants`).
- Respect `prefers-reduced-motion` via the `reducedMotion` variant.

### State Management

- **Zustand** stores in `stores/` — one file per domain:
  ```ts
  export const useAgentStore = create<AgentStore>((set) => ({ ... }));
  ```
- Thin custom hooks in `hooks/` wrap store access + side effects:
  ```ts
  export function useSprints() {
    const store = useSprintStore();
    useEffect(() => {
      store.fetchSprints();
    }, []);
    return store;
  }
  ```

### API Layer

- Centralized in `lib/api.ts` with `get`, `post`, `put`, `patch`, `del` helpers.
- Built-in request deduplication for GET requests.
- 10s timeout with single retry on network failure.

---

## 6. Backend / MCP Patterns

### Section Comments

Use box-drawing dividers to separate logical sections:

```ts
// ─── Tool: index_directory ───────────────────────────────────────────────────
```

### MCP Tool Registration

Each tool follows the same shape:

```ts
server.tool(
  'tool_name', // snake_case name
  'Human-readable description.', // description
  { param: z.string().describe('...') }, // Zod schema
  async ({ param }) => {
    // handler
    try {
      // ... DB operations ...
      return { content: [{ type: 'text', text: result }] };
    } catch (err: any) {
      return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
    }
  },
);
```

### Database Access

- **better-sqlite3** with WAL mode and foreign keys enabled:
  ```ts
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  ```
- Prepared statements with typed casts:
  ```ts
  const row = db.prepare('SELECT * FROM agents WHERE role = ?').get(role) as Agent | undefined;
  ```
- Transactions for multi-step mutations:
  ```ts
  const migrate = db.transaction(() => { ... });
  migrate();
  ```

### Notifications

Fire-and-forget HTTP POSTs to the dashboard (never await, never throw):

```ts
fetch(`http://localhost:${port}/api/notify`, { method: 'POST' }).catch(() => {});
```

---

## 7. SQL Conventions

### Schema

- `created_at TEXT NOT NULL DEFAULT (datetime('now'))` on every table.
- `updated_at TEXT NOT NULL DEFAULT (datetime('now'))` where rows are mutable.
- Soft deletes via `deleted_at TEXT DEFAULT NULL` — always filter with `WHERE deleted_at IS NULL`.
- `CHECK` constraints for enum columns:
  ```sql
  status TEXT NOT NULL DEFAULT 'TODO'
    CHECK (status IN ('TODO', 'IN_PROGRESS', 'DONE', 'BLOCKED'))
  ```

### Migrations

- Tracked in `schema_versions` table (version number + name).
- Migration objects: `{ version: N, name: 'descriptive_name', sql: '...' }`.
- Run inside a single transaction — partial failure rolls back cleanly.
- Safe column additions use `pragma("table_info(...)") + ALTER TABLE ADD COLUMN` pattern.
- No-op migrations use `SELECT 1` when the change was already applied elsewhere.

### Indexes

- Prefix: `idx_tablename_column`.
- Always `CREATE INDEX IF NOT EXISTS`.
- Composite indexes for common query patterns (e.g., `idx_tickets_sprint_deleted`).

---

## 8. Testing Patterns

### Backend Tests (`test/`)

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { initScrumSchema, runMigrations } from '../src/scrum/schema.js';

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  initScrumSchema(db);
  runMigrations(db);
});
```

- Fresh in-memory DB per test via `beforeEach`.
- Use `createTestDb()` from `test/helpers/db.ts` for indexer tests.
- Local helper functions for creating test entities (`createSprint`, `createTicket`, etc.).
- Test files named `*.test.ts` in `test/` directory.

### Frontend Tests (`src/dashboard/app/src/test/`)

- `@testing-library/react` + `@testing-library/user-event`.
- `jsdom` environment via Vitest config.
- Separate `vitest.config.ts` in the app directory.

---

## 9. ESLint Rules of Note

| Rule                                    | Setting | Rationale                            |
| --------------------------------------- | ------- | ------------------------------------ |
| `@typescript-eslint/no-unused-vars`     | `warn`  | Prefix unused with `_`               |
| `@typescript-eslint/no-explicit-any`    | `warn`  | Allowed for SQLite row casts         |
| `@typescript-eslint/no-require-imports` | `off`   | CJS scripts exist (`_restore.cjs`)   |
| `prefer-const`                          | `warn`  | Use `const` unless reassigned        |
| `no-console`                            | `off`   | `console.error` used for MCP logging |

---

## 10. Git & CI

- **Husky** pre-commit hook runs lint-staged.
- **lint-staged** (`lint-staged.config.mjs`) on staged files: `tsc --noEmit` when a staged file is under `src/`, ESLint on JS/TS, Prettier on everything. No full build.
- Commit messages: lowercase imperative (`update`, `add`, `fix`), prefixed with scope when relevant.
- No force-pushes to main.
