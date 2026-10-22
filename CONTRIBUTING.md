# Contributing to vlm-code-context-mcp

Thank you for your interest in contributing! This guide covers everything you need to get started, from setting up your environment to submitting a pull request.

## Table of Contents

- [Prerequisites](#prerequisites)
- [Getting Started](#getting-started)
- [Project Architecture](#project-architecture)
- [Development Workflow](#development-workflow)
- [Code Style](#code-style)
- [Testing](#testing)
- [Making Changes](#making-changes)
- [Pull Request Process](#pull-request-process)
- [CI Pipeline](#ci-pipeline)
- [Key Conventions](#key-conventions)
- [License](#license)

---

## Prerequisites

- **Node.js** 22 or newer (CI tests 22, 24 and the current LTS)
- **pnpm** 12 (`packageManager` pins `pnpm@12.10.1`; `corepack enable` picks it up)
- **Git**

No API keys or cloud accounts are required. Everything runs locally with SQLite.

## Getting Started

```bash
# Clone the repository
git clone https://github.com/VelimirMueller/mcp-server.git
cd mcp-server

# Install dependencies (lockfile: pnpm-lock.yaml)
pnpm install

# Build the project
pnpm run build

# Run the test suite
pnpm test
```

After building, you can start the MCP server and dashboard:

```bash
# Start the MCP server
pnpm start

# Start the dashboard (production mode, serves on :3333)
pnpm run dashboard

# Start the dashboard in dev mode (Vite HMR on :5173)
pnpm run dashboard:dev
```

## Project Architecture

The codebase is organized into four subsystems that share a single SQLite database (`context.db`):

```
src/
  server/          MCP server core
    index.ts         Entry point — registers all MCP tools, connects subsystems
    schema.ts        Database schema (files, exports, dependencies tables)
    indexer.ts       TypeScript/JS parser — extracts exports, imports, metadata
    setup.ts         CLI setup command (npx code-context-mcp setup .)

  scrum/           Scrum system (largest subsystem)
    tools.ts         71+ MCP tool handlers (sprint, ticket, agent, retro, etc.)
    schema.ts        20+ database tables (agents, sprints, tickets, blockers, etc.)
    defaults.ts      Factory defaults — seeds agents, skills on first startup

  dashboard/       React dashboard
    dashboard.ts     Node.js HTTP server — serves APIs + static files on :3333
    app/             Vite + React 19 + Tailwind CSS + Zustand + Framer Motion
      src/
        components/    Atomic Design hierarchy (see below)
        hooks/         Custom React hooks (useSearch, useSprints, useAgents, etc.)
        stores/        Zustand stores (file, sprint, agent, planning, UI, bridge)
        types/         Shared TypeScript interfaces
        test/          Frontend test files

  bridge/          Claude Code integration
    hook.ts          PreToolUse hook — bridges dashboard actions into Claude sessions

test/              Backend tests (Vitest)
  e2e/               Playwright end-to-end tests
  fixtures/          Sample project for indexer tests
  helpers/           Test utilities (e.g., in-memory DB factory)

docs/              VitePress documentation site
scripts/           Build/post-install scripts
```

### Component Architecture (Atomic Design)

The dashboard follows Atomic Design principles:

| Layer         | Location                | Examples                                                     |
| ------------- | ----------------------- | ------------------------------------------------------------ |
| **Atoms**     | `components/atoms/`     | Button, Badge, Skeleton, Toast, AnimatedNumber               |
| **Molecules** | `components/molecules/` | AgentCard, SprintCard, TicketCard, SearchBar, TabBar         |
| **Organisms** | `components/organisms/` | KanbanBoard, BurndownChart, FileTree, SprintDetail, TeamGrid |
| **Templates** | via `index.ts`          | ExplorerLayout, SprintLayout, PlanningLayout                 |
| **Pages**     | `App.tsx` routes        | CodeExplorer, Sprint, ProjectManagement                      |

### State Management

Five Zustand stores manage dashboard state:

| Store           | Responsibility                                                    |
| --------------- | ----------------------------------------------------------------- |
| `fileStore`     | Files, directories, selected file detail, dependency graph, stats |
| `sprintStore`   | Sprints, tickets, retro findings                                  |
| `agentStore`    | Agent health and mood tracking                                    |
| `planningStore` | Milestones, vision, Gantt data, backlog (read + write)            |
| `uiStore`       | Page navigation, tabs, sidebar, search, folder expand state       |

### Database

All state lives in SQLite (`context.db`). The database is the single source of truth — `defaults.ts` only seeds empty tables on first startup and is never read at runtime. There are two schema layers:

- **`src/server/schema.ts`** — Code context tables (files, exports, dependencies)
- **`src/scrum/schema.ts`** — Scrum tables (agents, sprints, tickets, blockers, discoveries, retro_findings, etc.)

### Key Dependencies

| Package                     | Purpose                                       |
| --------------------------- | --------------------------------------------- |
| `@modelcontextprotocol/sdk` | MCP protocol implementation                   |
| `better-sqlite3`            | SQLite database driver                        |
| `zod`                       | Runtime schema validation for MCP tool inputs |
| `chokidar`                  | File watching for live-reload                 |
| `react` / `react-dom`       | Dashboard UI                                  |
| `zustand`                   | State management                              |
| `framer-motion`             | Animations and transitions                    |
| `tailwindcss`               | Utility-first CSS                             |
| `vite`                      | Frontend build tool and dev server            |

## Development Workflow

### Build Commands

| Command                    | Description                                                        |
| -------------------------- | ------------------------------------------------------------------ |
| `pnpm run build`           | Full build: `tsc` (server) + `vite build` (dashboard)              |
| `pnpm run dashboard`       | Run dashboard server on `:3333` (uses `tsx` for live TS execution) |
| `pnpm run dashboard:dev`   | Vite dev server on `:5173` with HMR                                |
| `pnpm run dashboard:build` | Build only the dashboard frontend                                  |
| `pnpm start`               | Run the compiled MCP server (`dist/server/index.js`)               |

### Typical Development Loop

**For MCP server / scrum changes:**

```bash
# 1. Make changes in src/server/ or src/scrum/
# 2. Run tests
pnpm test
# 3. Build to verify compilation
pnpm run build
```

**For dashboard changes:**

```bash
# 1. Start the dev server (in one terminal)
pnpm run dashboard:dev
# 2. Make changes in src/dashboard/frontend/src/
# 3. Vite HMR reloads automatically
# 4. Run frontend tests
pnpm run test:frontend
```

**For full-stack changes:**

```bash
# Run all tests (backend + frontend)
pnpm run test:all
```

## Code Style

### Formatting (Prettier)

The project uses Prettier with these settings:

- Single quotes
- Trailing commas (all)
- Print width: 100 characters
- Semicolons: yes
- Tab width: 2 spaces

```bash
# Check formatting
pnpm run format

# Auto-fix formatting
pnpm run format:fix
```

### Linting (ESLint)

ESLint is configured with `typescript-eslint` recommended rules plus project-specific adjustments:

- Unused variables must be prefixed with `_` (e.g., `_unusedParam`)
- `no-explicit-any` is a warning, not an error
- `no-console` is off — `console.log` is allowed
- `prefer-const` is enforced as a warning

```bash
# Run linter
pnpm run lint

# Auto-fix lint issues
pnpm run lint:fix
```

### TypeScript

- **Target**: ESNext
- **Module system**: NodeNext (ESM)
- **Strict mode**: Enabled
- **Output**: `dist/`
- The dashboard app (`src/dashboard/frontend/`) and Remotion (`src/remotion/`) are excluded from the main `tsconfig.json` — they have their own build configs.

### Pre-commit Hooks

Husky runs lint-staged (`lint-staged.config.mjs`) on the staged files of every commit. It never runs a full build:

1. `tsc --noEmit` — type check, once per commit, when a staged file is under `src/` (`-p src/dashboard/frontend` for dashboard app files)
2. `eslint --no-warn-ignored` — lint staged JS/TS files
3. `prettier --write --ignore-unknown` — format staged files

If a commit fails the hook, fix the issues before re-committing.

## Testing

### Test Structure

| Type                | Location                      | Runner                   | Command                     |
| ------------------- | ----------------------------- | ------------------------ | --------------------------- |
| Unit / Integration  | `test/*.test.ts`              | Vitest                   | `pnpm test`                 |
| Frontend components | `src/dashboard/frontend/src/test/` | Vitest + Testing Library | `pnpm run test:frontend`    |
| End-to-end          | `test/e2e/*.spec.ts`          | Playwright               | `pnpm exec playwright test` |

### Writing Backend Tests

Backend tests use Vitest with an in-memory SQLite database for isolation:

```typescript
import { createTestDb } from './helpers/db.js';

describe('my feature', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb(); // Fresh in-memory DB with full schema
  });

  afterEach(() => {
    db.close();
  });

  it('should do something', () => {
    // Use db directly — no file I/O, no cleanup needed
  });
});
```

Each test gets a completely isolated database instance via `createTestDb()`, which applies the full schema to an in-memory SQLite database.

### Writing Frontend Tests

Frontend tests use Vitest with React Testing Library and jsdom:

```typescript
import { render, screen } from '@testing-library/react';
import { MyComponent } from '../components/atoms/MyComponent';

describe('MyComponent', () => {
  it('renders correctly', () => {
    render(<MyComponent label="Hello" />);
    expect(screen.getByText('Hello')).toBeInTheDocument();
  });
});
```

### Running E2E Tests

End-to-end tests require a built project and use Playwright:

```bash
pnpm run build
pnpm exec playwright install  # First time only
pnpm exec playwright test
```

The Playwright config automatically starts the dashboard server on `:3333`.

### Test Coverage

```bash
pnpm run test:coverage
```

Coverage is reported via V8 in both `text` and `lcov` formats, covering all files in `src/`.

## Making Changes

### Adding a New MCP Tool

1. **Define the Zod schema** for tool inputs in the appropriate file under `src/scrum/` or `src/server/`.
2. **Register the tool handler** in `src/scrum/tools.ts` (for scrum tools) or `src/server/index.ts` (for code-context tools).
3. **Add tests** in `test/` — use `createTestDb()` to exercise the tool's DB logic.
4. **Update docs** if the tool is user-facing — add to `docs/api-reference.md`.

### Adding a Dashboard Component

1. **Determine the Atomic Design layer** — is it an atom, molecule, or organism?
2. **Create the component** in the appropriate `components/` subdirectory.
3. **Export it** from the layer's `index.ts` barrel file.
4. **Add tests** in `src/dashboard/frontend/src/test/`.
5. **Use existing Zustand stores** for state — avoid component-local state for shared data.

### Adding a Dashboard API Endpoint

API endpoints are defined in `src/dashboard/dashboard.ts`. Follow the existing pattern:

1. Add a route handler in the request handler chain.
2. Return JSON responses with appropriate status codes.
3. Add SSE events if the endpoint modifies data that the dashboard should live-reload.

### Modifying Database Schema

1. **Code-context tables**: Edit `src/server/schema.ts`.
2. **Scrum tables**: Edit `src/scrum/schema.ts` and add a migration in `runMigrations()`.
3. **Factory defaults**: If adding new seeded data, update `src/scrum/defaults.ts`.
4. **Update test helpers** if the schema changes affect `test/helpers/db.ts`.

> **Important**: CI validates that `defaults.ts` contains exactly 7 agents and 5 skills. If you add or remove agents/skills, update the CI validation step in `.github/workflows/ci.yml`.

## Pull Request Process

1. **Fork** the repository and create a feature branch from `main`.
2. **Make your changes** following the conventions above.
3. **Run the full check suite** before pushing:

   ```bash
   pnpm exec tsc --noEmit   # Type check
   pnpm run lint            # Lint
   pnpm run format          # Format check
   pnpm run test:all        # All tests (backend + frontend)
   pnpm run build           # Build verification
   ```

4. **Push** your branch and open a pull request against `main`.
5. **CI will run** automatically — tests on Node 22, 24 and the current LTS, plus agent/skill count validation.
6. **Address review feedback** if any.

### PR Guidelines

- Keep PRs focused — one feature or fix per PR.
- Write a clear title and description explaining what and why.
- Include tests for new functionality.
- Don't break existing tests.

## CI Pipeline

### On Push / PR to `main`

The CI workflow (`.github/workflows/ci.yml`) runs:

1. **Type check**: `pnpm exec tsc --noEmit`
2. **Tests**: `pnpm test` on Node 22, 24 and the current LTS
3. **Build**: `pnpm run build`
4. **Validate counts**: Ensures `defaults.ts` has exactly 7 agents and 5 skills

### Publishing

There is no publish workflow. A maintainer publishes by hand from a clean `main`:

```bash
pnpm install --frozen-lockfile
pnpm pack --dry-run   # check the file list
pnpm publish
```

`pnpm publish` runs `prepublishOnly` (`pnpm run build`) and publishes `vlm-code-context-mcp` to the npm registry.

## Key Conventions

| Convention            | Detail                                                                     |
| --------------------- | -------------------------------------------------------------------------- |
| Module system         | ESM (`"type": "module"` in package.json) — use `.js` extensions in imports |
| Database              | SQLite via `better-sqlite3` — all state in `context.db`                    |
| Schema validation     | Zod for all MCP tool inputs                                                |
| Frontend architecture | Atomic Design (atoms → molecules → organisms → templates → pages)          |
| State management      | Zustand stores — no Redux, no Context API for shared state                 |
| Styling               | Tailwind CSS v4 — utility classes, no CSS modules                          |
| Animations            | Framer Motion — for transitions and micro-interactions                     |
| Test isolation        | In-memory SQLite databases via `createTestDb()`                            |
| Unused variables      | Prefix with `_` (e.g., `_unusedParam`)                                     |
| Barrel exports        | Each component layer has an `index.ts` re-exporting all public components  |

## License

This project is licensed under the [MIT License](LICENSE). By contributing, you agree that your contributions will be licensed under the same license.

---

Questions? Open an issue at [github.com/VelimirMueller/mcp-server/issues](https://github.com/VelimirMueller/mcp-server/issues).
