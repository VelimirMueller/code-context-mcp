/**
 * MCP vs Vanilla Benchmark — 10 Simulated Development Tasks
 *
 * Measures the context-window cost an AI agent pays when using MCP tools
 * versus raw file reading (vanilla). Each task simulates a realistic
 * development workflow with clearly defined steps.
 *
 * What this measures:
 *   - Tokens consumed from MCP tool output vs raw file content
 *   - Number of tool/read calls needed per approach
 *   - Information density (useful tokens / total tokens)
 *
 * What this does NOT measure:
 *   - Actual Claude API token counts (uses regex estimation)
 *   - Wall-clock time of real AI sessions
 *   - Quality of AI-generated code
 *
 * Methodology:
 *   - Both approaches use the SAME indexed database and fixture
 *   - MCP approach: calls MCP tool functions (search_files, get_file_context, etc.)
 *   - Vanilla approach: reads raw file contents (simulating Read tool / cat)
 *   - Each task is self-contained — no cross-task state leakage
 *   - Token estimation uses whitespace+symbol splitting (conservative)
 *
 * Fixture: test/fixtures/sample-project (11 files, 5 TypeScript, 19 exports, 5 dep edges)
 *
 * Task categories (10 tasks):
 *   1. Single-file lookup         (1pt) — find and understand one file
 *   2. Symbol search              (1pt) — locate a specific export across codebase
 *   3. Dependency tracing         (2pt) — trace imports/dependents of a module
 *   4. Unfamiliar codebase recon  (2pt) — understand project structure cold
 *   5. Add utility function       (2pt) — add export, wire barrel file
 *   6. Bug hunt                   (3pt) — find a type mismatch across files
 *   7. Add API endpoint           (3pt) — new method + types + integration
 *   8. Cross-file refactor        (5pt) — extract pattern, update consumers
 *   9. New feature with tests     (5pt) — full feature across multiple files
 *  10. Full codebase audit        (8pt) — read everything, assess architecture
 */
import { describe, it, expect, beforeAll } from "vitest";
import path from "path";
import fs from "fs";
import Database from "better-sqlite3";
import { indexDirectory } from "../src/server/indexer.js";
import { createTestDb } from "./helpers/db.js";
import { resolveBenchmarkOutputPath } from "./helpers/benchmark-output.js";
import {
  FIXTURE_DIR,
  canonicalPath,
  simFileContext,
  simFindSymbol,
  simSearchFiles,
  simIndexDirectory,
  hasMachineDependentText,
  CANONICAL_ROOT,
} from "./helpers/benchmark-fixture.js";

// ═══════════════════════════════════════════════════════════════════════════════
// Token estimation — conservative whitespace+symbol splitter
// ═══════════════════════════════════════════════════════════════════════════════

function estimateTokens(text: string): number {
  if (!text || !text.trim()) return 0;
  return text
    .split(/\s+/)
    .flatMap((w) =>
      w.match(
        /\*{1,2}|#{1,3}|[()[\]{}<>|`=→:,;/\\]+|[^\s*#()[\]{}<>|`=→:,;/\\]+/g,
      ) ?? [w],
    )
    .filter((t) => t.length > 0).length;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Shared DB helpers
// ═══════════════════════════════════════════════════════════════════════════════

function queryFile(db: Database.Database, fp: string) {
  const file = db
    .prepare("SELECT * FROM files WHERE path = ?")
    .get(fp) as any;
  if (!file) return null;
  return {
    db,
    file,
    exports: db
      .prepare("SELECT name, kind FROM exports WHERE file_id = ?")
      .all(file.id) as any[],
    deps: db
      .prepare(
        "SELECT f.path, f.summary, d.symbols FROM dependencies d JOIN files f ON d.target_id = f.id WHERE d.source_id = ?",
      )
      .all(file.id) as any[],
    dependents: db
      .prepare(
        "SELECT f.path, f.summary, d.symbols FROM dependencies d JOIN files f ON d.source_id = f.id WHERE d.target_id = ?",
      )
      .all(file.id) as any[],
  };
}

function resolvePath(db: Database.Database, pattern: string): string {
  return (
    db.prepare("SELECT path FROM files WHERE path LIKE ?").get(`%${pattern}`) as any
  ).path;
}

// ═══════════════════════════════════════════════════════════════════════════════
// MCP tool output formatters (current production format)
// ═══════════════════════════════════════════════════════════════════════════════

function mcpFileContext(d: NonNullable<ReturnType<typeof queryFile>>): string {
  return simFileContext(d.db, d.file.path);
}

function mcpIndexDir(db: Database.Database, root: string): string {
  return simIndexDirectory(db, root);
}

function mcpFindSymbol(db: Database.Database, name: string): string {
  return simFindSymbol(db, name);
}

function mcpSearchFiles(db: Database.Database, q: string): string {
  return simSearchFiles(db, q);
}

// ═══════════════════════════════════════════════════════════════════════════════
// Vanilla helpers — simulate raw file reading (what an agent does without MCP)
// ═══════════════════════════════════════════════════════════════════════════════

function vanillaReadFile(filePath: string): string {
  return fs.readFileSync(filePath, "utf-8");
}

function vanillaListDir(dir: string): string {
  const entries: string[] = [];
  function walk(d: string, prefix: string) {
    const items = fs.readdirSync(d, { withFileTypes: true });
    for (const item of items) {
      if (item.name.startsWith(".") || item.name === "node_modules") continue;
      const full = path.join(d, item.name);
      if (item.isDirectory()) {
        entries.push(`${prefix}${item.name}/`);
        walk(full, prefix + "  ");
      } else {
        entries.push(`${prefix}${item.name}`);
      }
    }
  }
  walk(dir, "");
  return entries.join("\n");
}

/** Simulate grep — returns matching lines with context */
function vanillaGrep(
  dir: string,
  pattern: string,
  extensions: string[] = [".ts", ".js", ".json"],
): string {
  const results: string[] = [];
  function walk(d: string) {
    const items = fs.readdirSync(d, { withFileTypes: true });
    for (const item of items) {
      if (item.name.startsWith(".") || item.name === "node_modules") continue;
      const full = path.join(d, item.name);
      if (item.isDirectory()) {
        walk(full);
      } else if (extensions.some((ext) => item.name.endsWith(ext))) {
        const content = fs.readFileSync(full, "utf-8");
        const lines = content.split("\n");
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].includes(pattern)) {
            results.push(`${canonicalPath(full)}:${i + 1}: ${lines[i]}`);
          }
        }
      }
    }
  }
  walk(dir);
  return results.join("\n") || `No matches for "${pattern}"`;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Step tracking — used by both MCP and Vanilla approaches
// ═══════════════════════════════════════════════════════════════════════════════

interface Step {
  phase: "research" | "locate" | "understand" | "verify";
  tool: string;
  args: string;
  reason: string;
  output: string;
  tokens: number;
}

function step(
  phase: Step["phase"],
  tool: string,
  args: string,
  reason: string,
  output: string,
): Step {
  return { phase, tool, args, reason, output, tokens: estimateTokens(output) };
}

interface TaskResult {
  id: string;
  label: string;
  category: string;
  description: string;
  points: number;
  steps: Step[];
  totalTokens: number;
  toolCalls: number;
  uniqueFiles: number;
}

function buildResult(
  id: string,
  label: string,
  category: string,
  description: string,
  points: number,
  steps: Step[],
): TaskResult {
  const fileSet = new Set<string>();
  for (const s of steps) {
    if (
      s.tool === "get_file_context" ||
      s.tool === "Read" ||
      s.tool === "read_file"
    )
      fileSet.add(s.args);
  }
  return {
    id,
    label,
    category,
    description,
    points,
    steps,
    totalTokens: steps.reduce((sum, s) => sum + s.tokens, 0),
    toolCalls: steps.length,
    uniqueFiles: fileSet.size,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Task definitions — each returns { mcp: TaskResult, vanilla: TaskResult }
// ═══════════════════════════════════════════════════════════════════════════════

function task01_singleFileLookup(db: Database.Database) {
  const apiPath = resolvePath(db, "services/api.ts");
  const rawPath = path.join(FIXTURE_DIR, "src/services/api.ts");

  const mcp = buildResult(
    "T01",
    "Single-file lookup",
    "retrieval",
    "Find and understand the API service file",
    1,
    [
      step(
        "locate",
        "search_files",
        "api",
        "Find files related to API",
        mcpSearchFiles(db, "api"),
      ),
      step(
        "understand",
        "get_file_context",
        "api.ts",
        "Understand API service structure",
        mcpFileContext(queryFile(db, apiPath)!),
      ),
    ],
  );

  const vanilla = buildResult(
    "T01",
    "Single-file lookup",
    "retrieval",
    "Find and understand the API service file",
    1,
    [
      step(
        "locate",
        "Grep",
        "api",
        "Search for API-related files",
        vanillaGrep(FIXTURE_DIR, "api", [".ts"]),
      ),
      step(
        "understand",
        "Read",
        "api.ts",
        "Read full API file to understand it",
        vanillaReadFile(rawPath),
      ),
    ],
  );

  return { mcp, vanilla };
}

function task02_symbolSearch(db: Database.Database) {
  const mcp = buildResult(
    "T02",
    "Symbol search",
    "retrieval",
    "Locate the ApiClient class and understand its interface",
    1,
    [
      step(
        "locate",
        "find_symbol",
        "ApiClient",
        "Find where ApiClient is defined",
        mcpFindSymbol(db, "ApiClient"),
      ),
    ],
  );

  const vanilla = buildResult(
    "T02",
    "Symbol search",
    "retrieval",
    "Locate the ApiClient class and understand its interface",
    1,
    [
      step(
        "locate",
        "Grep",
        "ApiClient",
        "Grep for ApiClient across codebase",
        vanillaGrep(FIXTURE_DIR, "ApiClient"),
      ),
      step(
        "understand",
        "Read",
        "api.ts",
        "Read the file containing ApiClient",
        vanillaReadFile(path.join(FIXTURE_DIR, "src/services/api.ts")),
      ),
    ],
  );

  return { mcp, vanilla };
}

function task03_dependencyTracing(db: Database.Database) {
  const typesPath = resolvePath(db, "types.ts");

  // MCP advantage: get_file_context returns the full dependency graph
  // (who imports this file, what symbols they use) in a single call
  const mcp = buildResult(
    "T03",
    "Dependency tracing",
    "analysis",
    "Trace all files that import from types.ts and what symbols they use",
    2,
    [
      step(
        "understand",
        "get_file_context",
        "types.ts",
        "Get types.ts with its full dependency graph (imports + dependents)",
        mcpFileContext(queryFile(db, typesPath)!),
      ),
    ],
  );

  const vanilla = buildResult(
    "T03",
    "Dependency tracing",
    "analysis",
    "Trace all files that import from types.ts and what symbols they use",
    2,
    [
      step(
        "locate",
        "Grep",
        "from.*types",
        'Grep for imports from types across all files',
        vanillaGrep(FIXTURE_DIR, "types"),
      ),
      step(
        "understand",
        "Read",
        "types.ts",
        "Read types.ts to see all exports",
        vanillaReadFile(path.join(FIXTURE_DIR, "src/types.ts")),
      ),
      step(
        "understand",
        "Read",
        "api.ts",
        "Read api.ts to see which types it imports",
        vanillaReadFile(path.join(FIXTURE_DIR, "src/services/api.ts")),
      ),
      step(
        "understand",
        "Read",
        "index.ts",
        "Read index.ts to see which types it imports",
        vanillaReadFile(path.join(FIXTURE_DIR, "src/index.ts")),
      ),
    ],
  );

  return { mcp, vanilla };
}

function task04_codebaseRecon(db: Database.Database) {
  const mcp = buildResult(
    "T04",
    "Codebase reconnaissance",
    "exploration",
    "Understand project structure, tech stack, and architecture from cold start",
    2,
    [
      step(
        "research",
        "index_directory",
        FIXTURE_DIR,
        "Get full project overview with file summaries and structure",
        mcpIndexDir(db, FIXTURE_DIR),
      ),
    ],
  );

  const vanilla = buildResult(
    "T04",
    "Codebase reconnaissance",
    "exploration",
    "Understand project structure, tech stack, and architecture from cold start",
    2,
    [
      step(
        "research",
        "Bash(ls)",
        FIXTURE_DIR,
        "List project directory tree",
        vanillaListDir(FIXTURE_DIR),
      ),
      step(
        "research",
        "Read",
        "package.json",
        "Read package.json for dependencies and scripts",
        vanillaReadFile(path.join(FIXTURE_DIR, "package.json")),
      ),
      step(
        "research",
        "Read",
        "tsconfig.json",
        "Read tsconfig for build configuration",
        vanillaReadFile(path.join(FIXTURE_DIR, "tsconfig.json")),
      ),
      step(
        "research",
        "Read",
        "README.md",
        "Read README for project overview",
        vanillaReadFile(path.join(FIXTURE_DIR, "README.md")),
      ),
      step(
        "research",
        "Read",
        "index.ts",
        "Read entry point to understand app structure",
        vanillaReadFile(path.join(FIXTURE_DIR, "src/index.ts")),
      ),
    ],
  );

  return { mcp, vanilla };
}

function task05_addUtilityFunction(db: Database.Database) {
  const helpersPath = resolvePath(db, "helpers.ts");
  const barrelPath = resolvePath(db, "utils/index.ts");

  const mcp = buildResult(
    "T05",
    "Add utility function",
    "implementation",
    "Add a slugify() helper, export from barrel, understand existing patterns",
    2,
    [
      step(
        "locate",
        "search_files",
        "helper",
        "Find where helper functions live",
        mcpSearchFiles(db, "helper"),
      ),
      step(
        "understand",
        "get_file_context",
        "helpers.ts",
        "Understand existing helper patterns and exports",
        mcpFileContext(queryFile(db, helpersPath)!),
      ),
      step(
        "understand",
        "get_file_context",
        "utils/index.ts",
        "Check barrel file to know what to re-export",
        mcpFileContext(queryFile(db, barrelPath)!),
      ),
      // [implement]
      step(
        "verify",
        "get_file_context",
        "helpers.ts",
        "Verify new export appears",
        mcpFileContext(queryFile(db, helpersPath)!),
      ),
    ],
  );

  const vanilla = buildResult(
    "T05",
    "Add utility function",
    "implementation",
    "Add a slugify() helper, export from barrel, understand existing patterns",
    2,
    [
      step(
        "locate",
        "Grep",
        "export function",
        "Find files with function exports",
        vanillaGrep(FIXTURE_DIR, "export function"),
      ),
      step(
        "understand",
        "Read",
        "helpers.ts",
        "Read helpers to see existing patterns",
        vanillaReadFile(path.join(FIXTURE_DIR, "src/utils/helpers.ts")),
      ),
      step(
        "understand",
        "Read",
        "utils/index.ts",
        "Read barrel file",
        vanillaReadFile(path.join(FIXTURE_DIR, "src/utils/index.ts")),
      ),
      // [implement]
      step(
        "verify",
        "Read",
        "helpers.ts",
        "Re-read to verify changes",
        vanillaReadFile(path.join(FIXTURE_DIR, "src/utils/helpers.ts")),
      ),
      step(
        "verify",
        "Read",
        "utils/index.ts",
        "Re-read barrel to verify re-export",
        vanillaReadFile(path.join(FIXTURE_DIR, "src/utils/index.ts")),
      ),
    ],
  );

  return { mcp, vanilla };
}

function task06_bugHunt(db: Database.Database) {
  const typesPath = resolvePath(db, "types.ts");
  const apiPath = resolvePath(db, "services/api.ts");
  const indexPath = resolvePath(db, "src/index.ts");

  const mcp = buildResult(
    "T06",
    "Bug hunt — type mismatch",
    "debugging",
    "Find where User type is used inconsistently across API and entry point",
    3,
    [
      step(
        "research",
        "find_symbol",
        "User",
        "Find all files that export or reference User type",
        mcpFindSymbol(db, "User"),
      ),
      step(
        "understand",
        "get_file_context",
        "types.ts",
        "Check User type definition and its dependents",
        mcpFileContext(queryFile(db, typesPath)!),
      ),
      step(
        "understand",
        "get_file_context",
        "api.ts",
        "Check how API uses User type",
        mcpFileContext(queryFile(db, apiPath)!),
      ),
      step(
        "understand",
        "get_file_context",
        "index.ts",
        "Check how entry point uses User type",
        mcpFileContext(queryFile(db, indexPath)!),
      ),
    ],
  );

  const vanilla = buildResult(
    "T06",
    "Bug hunt — type mismatch",
    "debugging",
    "Find where User type is used inconsistently across API and entry point",
    3,
    [
      step(
        "research",
        "Grep",
        "User",
        "Grep for User across all TypeScript files",
        vanillaGrep(FIXTURE_DIR, "User", [".ts"]),
      ),
      step(
        "understand",
        "Read",
        "types.ts",
        "Read type definition",
        vanillaReadFile(path.join(FIXTURE_DIR, "src/types.ts")),
      ),
      step(
        "understand",
        "Read",
        "api.ts",
        "Read API to check User usage",
        vanillaReadFile(path.join(FIXTURE_DIR, "src/services/api.ts")),
      ),
      step(
        "understand",
        "Read",
        "index.ts",
        "Read entry point to check User usage",
        vanillaReadFile(path.join(FIXTURE_DIR, "src/index.ts")),
      ),
      step(
        "understand",
        "Read",
        "helpers.ts",
        "Check utils for any User-related helpers",
        vanillaReadFile(path.join(FIXTURE_DIR, "src/utils/helpers.ts")),
      ),
    ],
  );

  return { mcp, vanilla };
}

function task07_addApiEndpoint(db: Database.Database) {
  const apiPath = resolvePath(db, "services/api.ts");
  const typesPath = resolvePath(db, "types.ts");
  const indexPath = resolvePath(db, "src/index.ts");

  const mcp = buildResult(
    "T07",
    "Add API endpoint",
    "implementation",
    "Add createUser() to ApiClient with CreateUserRequest type, wire into app",
    3,
    [
      step(
        "research",
        "index_directory",
        FIXTURE_DIR,
        "Get project overview to understand full architecture",
        mcpIndexDir(db, FIXTURE_DIR),
      ),
      step(
        "locate",
        "find_symbol",
        "ApiClient",
        "Find API client class",
        mcpFindSymbol(db, "ApiClient"),
      ),
      step(
        "understand",
        "get_file_context",
        "api.ts",
        "Understand existing API methods and patterns",
        mcpFileContext(queryFile(db, apiPath)!),
      ),
      step(
        "understand",
        "get_file_context",
        "types.ts",
        "Check existing types for request/response interfaces",
        mcpFileContext(queryFile(db, typesPath)!),
      ),
      step(
        "understand",
        "get_file_context",
        "index.ts",
        "See how API client is consumed in app",
        mcpFileContext(queryFile(db, indexPath)!),
      ),
      // [implement]
      step(
        "verify",
        "get_file_context",
        "api.ts",
        "Verify new method was added correctly",
        mcpFileContext(queryFile(db, apiPath)!),
      ),
    ],
  );

  const vanilla = buildResult(
    "T07",
    "Add API endpoint",
    "implementation",
    "Add createUser() to ApiClient with CreateUserRequest type, wire into app",
    3,
    [
      step(
        "research",
        "Bash(ls)",
        FIXTURE_DIR,
        "List project structure",
        vanillaListDir(FIXTURE_DIR),
      ),
      step(
        "locate",
        "Grep",
        "class.*Client",
        "Find API client class definition",
        vanillaGrep(FIXTURE_DIR, "class"),
      ),
      step(
        "understand",
        "Read",
        "api.ts",
        "Read full API file",
        vanillaReadFile(path.join(FIXTURE_DIR, "src/services/api.ts")),
      ),
      step(
        "understand",
        "Read",
        "types.ts",
        "Read types for interfaces",
        vanillaReadFile(path.join(FIXTURE_DIR, "src/types.ts")),
      ),
      step(
        "understand",
        "Read",
        "index.ts",
        "Read entry point for integration",
        vanillaReadFile(path.join(FIXTURE_DIR, "src/index.ts")),
      ),
      step(
        "understand",
        "Read",
        "helpers.ts",
        "Check for validation helpers",
        vanillaReadFile(path.join(FIXTURE_DIR, "src/utils/helpers.ts")),
      ),
      step(
        "understand",
        "Read",
        "utils/index.ts",
        "Check barrel for utility exports",
        vanillaReadFile(path.join(FIXTURE_DIR, "src/utils/index.ts")),
      ),
      // [implement]
      step(
        "verify",
        "Read",
        "api.ts",
        "Re-read API to verify changes",
        vanillaReadFile(path.join(FIXTURE_DIR, "src/services/api.ts")),
      ),
      step(
        "verify",
        "Read",
        "types.ts",
        "Re-read types to verify new interface",
        vanillaReadFile(path.join(FIXTURE_DIR, "src/types.ts")),
      ),
    ],
  );

  return { mcp, vanilla };
}

function task08_crossFileRefactor(db: Database.Database) {
  const allTs = db
    .prepare(
      "SELECT path FROM files WHERE language = 'typescript' ORDER BY path",
    )
    .all() as { path: string }[];
  const apiPath = resolvePath(db, "services/api.ts");
  const typesPath = resolvePath(db, "types.ts");
  const indexPath = resolvePath(db, "src/index.ts");

  const mcpSteps: Step[] = [];

  // Research phase — structured overview
  mcpSteps.push(
    step(
      "research",
      "index_directory",
      FIXTURE_DIR,
      "Full project overview for cross-cutting refactor",
      mcpIndexDir(db, FIXTURE_DIR),
    ),
  );
  mcpSteps.push(
    step(
      "research",
      "find_symbol",
      "ApiClient",
      "Locate main class to refactor",
      mcpFindSymbol(db, "ApiClient"),
    ),
  );
  mcpSteps.push(
    step(
      "research",
      "find_symbol",
      "ApiResponse",
      "Find response type to generalize",
      mcpFindSymbol(db, "ApiResponse"),
    ),
  );

  // Understand phase — read all TS files via MCP
  for (const f of allTs) {
    mcpSteps.push(
      step(
        "understand",
        "get_file_context",
        path.basename(f.path),
        `Understand ${path.basename(f.path)} role in dependency graph`,
        mcpFileContext(queryFile(db, f.path)!),
      ),
    );
  }

  // Verify phase
  mcpSteps.push(
    step(
      "verify",
      "get_file_context",
      "api.ts",
      "Verify refactored API class",
      mcpFileContext(queryFile(db, apiPath)!),
    ),
  );
  mcpSteps.push(
    step(
      "verify",
      "get_file_context",
      "types.ts",
      "Verify type hierarchy",
      mcpFileContext(queryFile(db, typesPath)!),
    ),
  );
  mcpSteps.push(
    step(
      "verify",
      "get_file_context",
      "index.ts",
      "Verify entry point still works",
      mcpFileContext(queryFile(db, indexPath)!),
    ),
  );

  const mcp = buildResult(
    "T08",
    "Cross-file refactor",
    "refactoring",
    "Extract BaseApiClient, add interceptor pattern, update all consumers",
    5,
    mcpSteps,
  );

  // Vanilla — must read all files raw, multiple times
  const vanillaSteps: Step[] = [];

  vanillaSteps.push(
    step(
      "research",
      "Bash(ls)",
      FIXTURE_DIR,
      "List project tree",
      vanillaListDir(FIXTURE_DIR),
    ),
  );
  vanillaSteps.push(
    step(
      "research",
      "Grep",
      "class",
      "Find all class definitions",
      vanillaGrep(FIXTURE_DIR, "class"),
    ),
  );
  vanillaSteps.push(
    step(
      "research",
      "Grep",
      "import",
      "Map all import relationships",
      vanillaGrep(FIXTURE_DIR, "import"),
    ),
  );

  // Understand — read all TS files raw
  const tsFiles = [
    "src/index.ts",
    "src/types.ts",
    "src/services/api.ts",
    "src/utils/helpers.ts",
    "src/utils/index.ts",
  ];
  for (const f of tsFiles) {
    vanillaSteps.push(
      step(
        "understand",
        "Read",
        f,
        `Read ${path.basename(f)} to understand structure`,
        vanillaReadFile(path.join(FIXTURE_DIR, f)),
      ),
    );
  }

  // Re-read key files for planning
  vanillaSteps.push(
    step(
      "understand",
      "Read",
      "api.ts (re-read)",
      "Re-read API for refactor planning",
      vanillaReadFile(path.join(FIXTURE_DIR, "src/services/api.ts")),
    ),
  );

  // Verify
  for (const f of tsFiles.slice(0, 3)) {
    vanillaSteps.push(
      step(
        "verify",
        "Read",
        `${path.basename(f)} (verify)`,
        `Verify changes in ${path.basename(f)}`,
        vanillaReadFile(path.join(FIXTURE_DIR, f)),
      ),
    );
  }

  const vanilla = buildResult(
    "T08",
    "Cross-file refactor",
    "refactoring",
    "Extract BaseApiClient, add interceptor pattern, update all consumers",
    5,
    vanillaSteps,
  );

  return { mcp, vanilla };
}

function task09_newFeatureWithTests(db: Database.Database) {
  const apiPath = resolvePath(db, "services/api.ts");
  const typesPath = resolvePath(db, "types.ts");
  const indexPath = resolvePath(db, "src/index.ts");
  const helpersPath = resolvePath(db, "helpers.ts");
  const barrelPath = resolvePath(db, "utils/index.ts");

  const mcp = buildResult(
    "T09",
    "New feature with tests",
    "implementation",
    "Add user search with pagination, validation helper, types, wiring, and test plan",
    5,
    [
      step(
        "research",
        "index_directory",
        FIXTURE_DIR,
        "Full project overview",
        mcpIndexDir(db, FIXTURE_DIR),
      ),
      step(
        "research",
        "search_files",
        "pagina",
        "Find existing pagination patterns",
        mcpSearchFiles(db, "pagina"),
      ),
      step(
        "understand",
        "get_file_context",
        "types.ts",
        "Check PaginatedResult and existing types",
        mcpFileContext(queryFile(db, typesPath)!),
      ),
      step(
        "understand",
        "get_file_context",
        "api.ts",
        "Understand API patterns for new method",
        mcpFileContext(queryFile(db, apiPath)!),
      ),
      step(
        "understand",
        "get_file_context",
        "helpers.ts",
        "Check for validation helpers to reuse",
        mcpFileContext(queryFile(db, helpersPath)!),
      ),
      step(
        "understand",
        "get_file_context",
        "index.ts",
        "Understand app wiring for new feature",
        mcpFileContext(queryFile(db, indexPath)!),
      ),
      // [implement across 4 files + test file]
      step(
        "verify",
        "get_file_context",
        "api.ts",
        "Verify new searchUsers method",
        mcpFileContext(queryFile(db, apiPath)!),
      ),
      step(
        "verify",
        "get_file_context",
        "types.ts",
        "Verify SearchParams type added",
        mcpFileContext(queryFile(db, typesPath)!),
      ),
    ],
  );

  const vanilla = buildResult(
    "T09",
    "New feature with tests",
    "implementation",
    "Add user search with pagination, validation helper, types, wiring, and test plan",
    5,
    [
      step(
        "research",
        "Bash(ls)",
        FIXTURE_DIR,
        "List project structure",
        vanillaListDir(FIXTURE_DIR),
      ),
      step(
        "research",
        "Read",
        "package.json",
        "Check dependencies and test framework",
        vanillaReadFile(path.join(FIXTURE_DIR, "package.json")),
      ),
      step(
        "research",
        "Grep",
        "Paginated",
        "Find pagination patterns",
        vanillaGrep(FIXTURE_DIR, "Paginated"),
      ),
      step(
        "understand",
        "Read",
        "types.ts",
        "Read all types",
        vanillaReadFile(path.join(FIXTURE_DIR, "src/types.ts")),
      ),
      step(
        "understand",
        "Read",
        "api.ts",
        "Read API service",
        vanillaReadFile(path.join(FIXTURE_DIR, "src/services/api.ts")),
      ),
      step(
        "understand",
        "Read",
        "helpers.ts",
        "Read helpers for reusable utils",
        vanillaReadFile(path.join(FIXTURE_DIR, "src/utils/helpers.ts")),
      ),
      step(
        "understand",
        "Read",
        "utils/index.ts",
        "Read barrel file",
        vanillaReadFile(path.join(FIXTURE_DIR, "src/utils/index.ts")),
      ),
      step(
        "understand",
        "Read",
        "index.ts",
        "Read entry point for wiring",
        vanillaReadFile(path.join(FIXTURE_DIR, "src/index.ts")),
      ),
      // [implement]
      step(
        "verify",
        "Read",
        "api.ts (verify)",
        "Re-read API to verify",
        vanillaReadFile(path.join(FIXTURE_DIR, "src/services/api.ts")),
      ),
      step(
        "verify",
        "Read",
        "types.ts (verify)",
        "Re-read types to verify",
        vanillaReadFile(path.join(FIXTURE_DIR, "src/types.ts")),
      ),
      step(
        "verify",
        "Read",
        "index.ts (verify)",
        "Re-read entry to verify wiring",
        vanillaReadFile(path.join(FIXTURE_DIR, "src/index.ts")),
      ),
    ],
  );

  return { mcp, vanilla };
}

function task10_fullCodebaseAudit(db: Database.Database) {
  const allFiles = db
    .prepare("SELECT path FROM files ORDER BY path")
    .all() as { path: string }[];

  const mcpSteps: Step[] = [];

  // One index call gives structured overview
  mcpSteps.push(
    step(
      "research",
      "index_directory",
      FIXTURE_DIR,
      "Get complete project structure with summaries",
      mcpIndexDir(db, FIXTURE_DIR),
    ),
  );

  // Then targeted context for each file
  for (const f of allFiles) {
    const data = queryFile(db, f.path);
    if (data) {
      mcpSteps.push(
        step(
          "understand",
          "get_file_context",
          path.basename(f.path),
          `Audit ${path.basename(f.path)} — exports, deps, quality`,
          mcpFileContext(data),
        ),
      );
    }
  }

  const mcp = buildResult(
    "T10",
    "Full codebase audit",
    "analysis",
    "Read and assess every file — architecture, quality, dependencies, dead code",
    8,
    mcpSteps,
  );

  // Vanilla — must read every single file raw
  const vanillaSteps: Step[] = [];

  vanillaSteps.push(
    step(
      "research",
      "Bash(ls)",
      FIXTURE_DIR,
      "List full project tree",
      vanillaListDir(FIXTURE_DIR),
    ),
  );

  // Read every file
  const allRawFiles = [
    "package.json",
    "tsconfig.json",
    "README.md",
    "config.json",
    "styles.css",
    "src/index.ts",
    "src/types.ts",
    "src/services/api.ts",
    "src/utils/helpers.ts",
    "src/utils/index.ts",
  ];

  for (const f of allRawFiles) {
    vanillaSteps.push(
      step(
        "understand",
        "Read",
        f,
        `Read ${f} for audit`,
        vanillaReadFile(path.join(FIXTURE_DIR, f)),
      ),
    );
  }

  // Vanilla also needs grep passes to understand relationships
  vanillaSteps.push(
    step(
      "research",
      "Grep",
      "import",
      "Map all import relationships",
      vanillaGrep(FIXTURE_DIR, "import"),
    ),
  );
  vanillaSteps.push(
    step(
      "research",
      "Grep",
      "export",
      "Map all exports",
      vanillaGrep(FIXTURE_DIR, "export"),
    ),
  );

  const vanilla = buildResult(
    "T10",
    "Full codebase audit",
    "analysis",
    "Read and assess every file — architecture, quality, dependencies, dead code",
    8,
    vanillaSteps,
  );

  return { mcp, vanilla };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Report generation
// ═══════════════════════════════════════════════════════════════════════════════

interface BenchmarkReport {
  meta: {
    fixture: string;
    fileCount: number;
    tsFileCount: number;
    exportCount: number;
    depCount: number;
    generatedAt: string;
    methodology: string;
    tokenEstimation: string;
  };
  tasks: Array<{
    id: string;
    label: string;
    category: string;
    points: number;
    mcp: { tokens: number; calls: number; files: number };
    vanilla: { tokens: number; calls: number; files: number };
    tokenSavingsPct: number;
    callSavingsPct: number;
  }>;
  summary: {
    totalMcpTokens: number;
    totalVanillaTokens: number;
    totalSavingsPct: number;
    totalMcpCalls: number;
    totalVanillaCalls: number;
    callSavingsPct: number;
    totalPoints: number;
    taskCount: number;
    categories: Record<string, { mcpTokens: number; vanillaTokens: number; savingsPct: number }>;
  };
}

function generateReport(
  db: Database.Database,
  tasks: Array<{ mcp: TaskResult; vanilla: TaskResult }>,
): BenchmarkReport {
  const fc = (db.prepare("SELECT COUNT(*) as c FROM files").get() as any).c;
  const tsc = (
    db
      .prepare(
        "SELECT COUNT(*) as c FROM files WHERE language = 'typescript'",
      )
      .get() as any
  ).c;
  const ec = (db.prepare("SELECT COUNT(*) as c FROM exports").get() as any).c;
  const dc = (
    db.prepare("SELECT COUNT(*) as c FROM dependencies").get() as any
  ).c;

  const taskResults = tasks.map(({ mcp, vanilla }) => {
    const tokenSaving =
      vanilla.totalTokens > 0
        ? ((vanilla.totalTokens - mcp.totalTokens) / vanilla.totalTokens) * 100
        : 0;
    const callSaving =
      vanilla.toolCalls > 0
        ? ((vanilla.toolCalls - mcp.toolCalls) / vanilla.toolCalls) * 100
        : 0;
    return {
      id: mcp.id,
      label: mcp.label,
      category: mcp.category,
      points: mcp.points,
      mcp: {
        tokens: mcp.totalTokens,
        calls: mcp.toolCalls,
        files: mcp.uniqueFiles,
      },
      vanilla: {
        tokens: vanilla.totalTokens,
        calls: vanilla.toolCalls,
        files: vanilla.uniqueFiles,
      },
      tokenSavingsPct: Math.round(tokenSaving * 10) / 10,
      callSavingsPct: Math.round(callSaving * 10) / 10,
    };
  });

  const totalMcp = taskResults.reduce((s, t) => s + t.mcp.tokens, 0);
  const totalVanilla = taskResults.reduce((s, t) => s + t.vanilla.tokens, 0);
  const totalMcpCalls = taskResults.reduce((s, t) => s + t.mcp.calls, 0);
  const totalVanillaCalls = taskResults.reduce(
    (s, t) => s + t.vanilla.calls,
    0,
  );
  const totalPoints = taskResults.reduce((s, t) => s + t.points, 0);

  // Category breakdown
  const categories: Record<string, { mcpTokens: number; vanillaTokens: number; savingsPct: number }> = {};
  for (const t of taskResults) {
    if (!categories[t.category])
      categories[t.category] = { mcpTokens: 0, vanillaTokens: 0, savingsPct: 0 };
    categories[t.category].mcpTokens += t.mcp.tokens;
    categories[t.category].vanillaTokens += t.vanilla.tokens;
  }
  for (const cat of Object.values(categories)) {
    cat.savingsPct =
      cat.vanillaTokens > 0
        ? Math.round(
            ((cat.vanillaTokens - cat.mcpTokens) / cat.vanillaTokens) * 1000,
          ) / 10
        : 0;
  }

  return {
    meta: {
      fixture: "test/fixtures/sample-project",
      fileCount: fc,
      tsFileCount: tsc,
      exportCount: ec,
      depCount: dc,
      generatedAt: new Date().toISOString(),
      methodology:
        "Simulated agent workflows — MCP tool calls vs raw file reads. Self-contained tasks, no cross-task state. Deterministic (no AI API calls).",
      tokenEstimation:
        "Conservative whitespace+symbol splitting. NOT Claude tokenizer counts. Real API usage may differ.",
    },
    tasks: taskResults,
    summary: {
      totalMcpTokens: totalMcp,
      totalVanillaTokens: totalVanilla,
      totalSavingsPct:
        totalVanilla > 0
          ? Math.round(
              ((totalVanilla - totalMcp) / totalVanilla) * 1000,
            ) / 10
          : 0,
      totalMcpCalls: totalMcpCalls,
      totalVanillaCalls: totalVanillaCalls,
      callSavingsPct:
        totalVanillaCalls > 0
          ? Math.round(
              ((totalVanillaCalls - totalMcpCalls) / totalVanillaCalls) * 1000,
            ) / 10
          : 0,
      totalPoints,
      taskCount: taskResults.length,
      categories,
    },
  };
}

function printReport(report: BenchmarkReport): string {
  const lines: string[] = [];
  const W = 96;
  const hr = "═".repeat(W);
  const thin = "─".repeat(W);

  lines.push("");
  lines.push(`╔${hr}╗`);
  lines.push(
    `║  MCP vs VANILLA BENCHMARK — 10 Simulated Development Tasks${" ".repeat(W - 60)}║`,
  );
  lines.push(`╠${hr}╣`);
  lines.push(
    `║  Fixture: ${report.meta.fixture} (${report.meta.fileCount} files, ${report.meta.tsFileCount} TS, ${report.meta.exportCount} exports, ${report.meta.depCount} deps)${" ".repeat(Math.max(0, W - 80))}║`,
  );
  lines.push(
    `║  Method:  ${report.meta.methodology.substring(0, W - 12)}${" ".repeat(Math.max(0, W - 10 - report.meta.methodology.substring(0, W - 12).length))}║`,
  );
  lines.push(
    `║  Tokens:  ${report.meta.tokenEstimation.substring(0, W - 12)}${" ".repeat(Math.max(0, W - 10 - report.meta.tokenEstimation.substring(0, W - 12).length))}║`,
  );
  lines.push(`╠${hr}╣`);

  // Table header
  lines.push(
    `║  ${"Task".padEnd(32)} ${"Pts".padStart(3)} │ ${"MCP tok".padStart(8)} ${"calls".padStart(5)} │ ${"Van tok".padStart(8)} ${"calls".padStart(5)} │ ${"Saved".padStart(6)} ${"Δcalls".padStart(6)}  ║`,
  );
  lines.push(`║  ${thin.substring(0, W - 4)}  ║`);

  for (const t of report.tasks) {
    const saved =
      t.tokenSavingsPct > 0
        ? `${t.tokenSavingsPct.toFixed(0)}%`
        : `+${Math.abs(t.tokenSavingsPct).toFixed(0)}%`;
    const dcalls =
      t.callSavingsPct > 0
        ? `${t.callSavingsPct.toFixed(0)}%`
        : `+${Math.abs(t.callSavingsPct).toFixed(0)}%`;
    lines.push(
      `║  ${t.label.padEnd(32)} ${String(t.points).padStart(3)} │ ${String(t.mcp.tokens).padStart(8)} ${String(t.mcp.calls).padStart(5)} │ ${String(t.vanilla.tokens).padStart(8)} ${String(t.vanilla.calls).padStart(5)} │ ${saved.padStart(6)} ${dcalls.padStart(6)}  ║`,
    );
  }

  lines.push(`╠${hr}╣`);

  // Summary
  const s = report.summary;
  lines.push(
    `║  TOTALS (${s.taskCount} tasks, ${s.totalPoints}pts)${" ".repeat(W - 30)}║`,
  );
  lines.push(
    `║  MCP:     ${s.totalMcpTokens.toLocaleString()} tokens, ${s.totalMcpCalls} calls${" ".repeat(Math.max(0, W - 50))}║`,
  );
  lines.push(
    `║  Vanilla: ${s.totalVanillaTokens.toLocaleString()} tokens, ${s.totalVanillaCalls} calls${" ".repeat(Math.max(0, W - 50))}║`,
  );
  lines.push(
    `║  Savings: ${s.totalSavingsPct}% fewer tokens, ${s.callSavingsPct}% fewer calls${" ".repeat(Math.max(0, W - 55))}║`,
  );

  lines.push(`╠${hr}╣`);
  lines.push(
    `║  BY CATEGORY${" ".repeat(W - 14)}║`,
  );
  for (const [cat, data] of Object.entries(s.categories)) {
    lines.push(
      `║  ${cat.padEnd(16)} MCP: ${data.mcpTokens.toLocaleString().padStart(7)} │ Vanilla: ${data.vanillaTokens.toLocaleString().padStart(7)} │ ${data.savingsPct}% saved${" ".repeat(Math.max(0, W - 75))}║`,
    );
  }

  lines.push(`╚${hr}╝`);
  lines.push("");

  return lines.join("\n");
}

// ═══════════════════════════════════════════════════════════════════════════════
// Test suite
// ═══════════════════════════════════════════════════════════════════════════════

describe("MCP vs Vanilla benchmark — 10 tasks", () => {
  let db: Database.Database;
  let allTasks: Array<{ mcp: TaskResult; vanilla: TaskResult }>;
  let report: BenchmarkReport;

  beforeAll(() => {
    db = createTestDb();
    indexDirectory(db, FIXTURE_DIR);

    allTasks = [
      task01_singleFileLookup(db),
      task02_symbolSearch(db),
      task03_dependencyTracing(db),
      task04_codebaseRecon(db),
      task05_addUtilityFunction(db),
      task06_bugHunt(db),
      task07_addApiEndpoint(db),
      task08_crossFileRefactor(db),
      task09_newFeatureWithTests(db),
      task10_fullCodebaseAudit(db),
    ];

    report = generateReport(db, allTasks);
  });

  // ── Report ────────────────────────────────────────────────────────────────

  it("prints full benchmark report", () => {
    console.log(printReport(report));
    expect(report.tasks).toHaveLength(10);
  });

  it("writes benchmark-results.json (tmpdir by default; tracked repo path only with BENCHMARK_WRITE_RESULTS=1)", () => {
    const outPath = resolveBenchmarkOutputPath(
      path.resolve(__dirname, "../benchmark-results.json"),
    );
    fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
    expect(fs.existsSync(outPath)).toBe(true);
    const written = JSON.parse(fs.readFileSync(outPath, "utf-8"));
    expect(written).toEqual(JSON.parse(JSON.stringify(report)));
  });

  // ── Per-task: MCP should use fewer or equal tokens ────────────────────────

  it.each([
    ["T01", "Single-file lookup"],
    ["T03", "Dependency tracing"],
    ["T04", "Codebase reconnaissance"],
    ["T05", "Add utility function"],
    ["T06", "Bug hunt"],
    ["T07", "Add API endpoint"],
    ["T08", "Cross-file refactor"],
    ["T09", "New feature with tests"],
    ["T10", "Full codebase audit"],
  ])("%s — %s: MCP uses fewer tokens than vanilla", (id) => {
    const task = allTasks.find((t) => t.mcp.id === id)!;
    expect(task.mcp.totalTokens).toBeLessThan(task.vanilla.totalTokens);
  });

  // ── Symbol search may not save tokens (MCP returns less but vanilla grep is cheap) ──

  it("T02 — Symbol search: MCP uses fewer or equal calls", () => {
    const t = allTasks[1];
    expect(t.mcp.toolCalls).toBeLessThanOrEqual(t.vanilla.toolCalls);
  });

  // ── Aggregate assertions ──────────────────────────────────────────────────

  it("aggregate token savings > 0% across all tasks", () => {
    expect(report.summary.totalSavingsPct).toBeGreaterThan(0);
  });

  it("aggregate call savings > 0% across all tasks", () => {
    expect(report.summary.callSavingsPct).toBeGreaterThan(0);
  });

  it("every task category shows positive or neutral savings", () => {
    for (const [, data] of Object.entries(report.summary.categories)) {
      expect(data.savingsPct).toBeGreaterThanOrEqual(0);
    }
  });

  // ── Scaling: larger tasks should benefit more from MCP ────────────────────

  it("larger tasks (5pt+) save more tokens per task than small tasks (1-2pt)", () => {
    const smallTasks = allTasks.filter((t) => t.mcp.points <= 2);
    const largeTasks = allTasks.filter((t) => t.mcp.points >= 5);
    const smallAvg =
      smallTasks.reduce((s, t) => s + (t.vanilla.totalTokens - t.mcp.totalTokens), 0) /
      smallTasks.length;
    const largeAvg =
      largeTasks.reduce((s, t) => s + (t.vanilla.totalTokens - t.mcp.totalTokens), 0) /
      largeTasks.length;
    expect(largeAvg).toBeGreaterThan(smallAvg);
  });

  // ── Methodology validation ────────────────────────────────────────────────

  it("all tasks are self-contained (no shared mutable state)", () => {
    // Each task function creates its own steps from fresh DB queries
    // This test verifies task IDs are unique
    const ids = new Set(allTasks.map((t) => t.mcp.id));
    expect(ids.size).toBe(allTasks.length);
  });

  it("report includes honest methodology disclaimer", () => {
    expect(report.meta.methodology).toContain("Simulated");
    expect(report.meta.tokenEstimation).toContain("NOT Claude tokenizer");
  });

  // ── Path independence ─────────────────────────────────────────────────────

  it("simulated outputs never carry the real fixture dir; MCP outputs print project-relative paths", () => {
    const outputs = allTasks.flatMap((t) =>
      [...t.mcp.steps, ...t.vanilla.steps].map((s) => s.output),
    );
    expect(outputs.length).toBeGreaterThan(0);
    for (const out of outputs) {
      expect(hasMachineDependentText(out)).toBe(false);
      expect(out).not.toContain(FIXTURE_DIR);
    }
    // The path-bearing MCP tools print project-relative paths, as the real tools
    // do since #116 — never stripped (that would understate their token cost).
    const mcpPathOutputs = allTasks.flatMap((t) =>
      t.mcp.steps
        .filter(
          (s) =>
            s.tool === "get_file_context" ||
            s.tool === "search_files" ||
            s.tool === "find_symbol",
        )
        .map((s) => s.output),
    );
    expect(mcpPathOutputs.length).toBeGreaterThan(0);
    for (const out of mcpPathOutputs) {
      // Empty-result messages ("No files matching …") carry no path by design.
      if (/^No (files|exports) matching/.test(out)) continue;
      expect(out).not.toContain(CANONICAL_ROOT);
      expect(out).not.toMatch(/(^|[\s(])\/[\w.-]+\//); // no absolute path anywhere
    }
  });
});
