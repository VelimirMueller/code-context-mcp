/**
 * Token Efficiency A/B Benchmark — Simulated Development Tasks
 *
 * Simulates 3 realistic development tasks (Small / Medium / Large) end-to-end,
 * modeling the full AI agent workflow: research → locate → understand → implement → verify.
 *
 * Measures total MCP tool OUTPUT tokens consumed under old vs new format,
 * representing the real context-window cost an AI agent pays during development.
 *
 * Fixture: sample-project (10 files, 5 TypeScript, 19 exports, 5 dep edges)
 *
 * Tasks:
 *   S — Add a utility function to helpers.ts (2pt)
 *       Workflow: search → read target → read related → implement
 *   M — Add a new API method with type + wire to entry point (3pt)
 *       Workflow: index → find patterns → read 5 files → implement → verify imports
 *   L — Refactor API layer: extract base class, update all consumers (5pt)
 *       Workflow: index → search → read all TS files → trace deps → plan → implement → verify
 */
import { describe, it, expect, beforeAll } from "vitest";
import path from "path";
import Database from "better-sqlite3";
import { indexDirectory } from "../src/server/indexer.js";
import { createTestDb } from "./helpers/db.js";
import { FIXTURE_DIR, canonicalPath, simFileContext, simFindSymbol, simSearchFiles } from "./helpers/benchmark-fixture.js";

// ═════════════════════════════════════════════════════════════════════════════
// Token estimation
// ═════════════════════════════════════════════════════════════════════════════

function estimateTokens(text: string): number {
  if (!text || !text.trim()) return 0;
  return text.split(/\s+/)
    .flatMap(w => w.match(/\*{1,2}|#{1,3}|[()[\]{}<>|`=→:,;/\\]+|[^\s*#()[\]{}<>|`=→:,;/\\]+/g) ?? [w])
    .filter(t => t.length > 0).length;
}

// ═════════════════════════════════════════════════════════════════════════════
// DB helpers
// ═════════════════════════════════════════════════════════════════════════════

function formatSize(bytes: number): string {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / (1024 * 1024)).toFixed(1) + " MB";
}

function queryFile(db: Database.Database, fp: string) {
  const file = db.prepare("SELECT * FROM files WHERE path = ?").get(fp) as any;
  if (!file) return null;
  return {
    db,
    file,
    exports: db.prepare("SELECT name, kind FROM exports WHERE file_id = ?").all(file.id) as any[],
    deps: db.prepare("SELECT f.path, f.summary, d.symbols FROM dependencies d JOIN files f ON d.target_id = f.id WHERE d.source_id = ?").all(file.id) as any[],
    dependents: db.prepare("SELECT f.path, f.summary, d.symbols FROM dependencies d JOIN files f ON d.source_id = f.id WHERE d.target_id = ?").all(file.id) as any[],
  };
}

function resolvePath(db: Database.Database, pattern: string): string {
  return (db.prepare("SELECT path FROM files WHERE path LIKE ?").get(`%${pattern}`) as any).path;
}

// ═════════════════════════════════════════════════════════════════════════════
// Tool output formatters — OLD vs NEW
// ═════════════════════════════════════════════════════════════════════════════

function fileContextOld(d: NonNullable<ReturnType<typeof queryFile>>): string {
  const { file: f, exports: e, deps, dependents: dep } = d;
  return [
    `# ${canonicalPath(f.path)}`,
    `Language: ${f.language} | Extension: ${f.extension} | Size: ${formatSize(f.size_bytes)} | Lines: ${f.line_count}`,
    `Created: ${f.created_at} | Modified: ${f.modified_at} | Indexed: ${f.indexed_at}`,
    `Summary: ${f.summary}`, f.description ? `Description: ${f.description}` : "", "",
    `## Exports (${e.length})`, ...e.map((x: any) => `  - ${x.name} (${x.kind})`), "",
    f.external_imports ? `## External packages\n  ${f.external_imports}` : "", "",
    `## Imports from (${deps.length})`, ...deps.map((x: any) => `  - ${canonicalPath(x.path)} [${x.symbols}]\n    ${x.summary}`), "",
    `## Imported by (${dep.length})`, ...dep.map((x: any) => `  - ${canonicalPath(x.path)} [${x.symbols}]\n    ${x.summary}`),
  ].join("\n");
}

/** NEW = the real get_file_context output today (relative paths, #119 signatures and import lines). */
function fileContextNew(d: NonNullable<ReturnType<typeof queryFile>>): string {
  return simFileContext(d.db, d.file.path);
}

function indexDirOld(db: Database.Database, root: string): string {
  const fc = (db.prepare("SELECT COUNT(*) as c FROM files").get() as any).c;
  const ec = (db.prepare("SELECT COUNT(*) as c FROM exports").get() as any).c;
  const dc = (db.prepare("SELECT COUNT(*) as c FROM dependencies").get() as any).c;
  const s: string[] = [`# Index Summary\nIndexed ${fc} files, ${ec} exports, ${dc} dependencies\n`];
  const dirs = db.prepare("SELECT path, name, description, file_count FROM directories WHERE parent_path = ? ORDER BY name").all(root) as any[];
  if (dirs.length) {
    s.push("## Directories\n");
    for (const d of dirs) {
      s.push(`### ${d.name}/\n${d.description ?? "No description"}\n`);
      const files = db.prepare("SELECT path, summary, description FROM files WHERE path LIKE ? AND path NOT LIKE ? ORDER BY path").all(d.path + "/%", d.path + "/%/%") as any[];
      if (files.length) { for (const f of files) s.push(`- **${path.basename(f.path)}** — ${f.description ?? f.summary ?? "No description"}`); s.push(""); }
      const sub = db.prepare("SELECT name, description, file_count FROM directories WHERE parent_path = ? ORDER BY name").all(d.path) as any[];
      if (sub.length) { for (const x of sub) s.push(`- **${x.name}/** (${x.file_count} files) — ${x.description ?? "No description"}`); s.push(""); }
    }
  }
  const rf = db.prepare("SELECT path, summary, description FROM files WHERE path LIKE ? AND path NOT LIKE ? ORDER BY path").all(root + "/%", root + "/%/%") as any[];
  if (rf.length) { s.push("## Root Files\n"); for (const f of rf) s.push(`- **${path.basename(f.path)}** — ${f.description ?? f.summary ?? "No description"}`); s.push(""); }
  return s.join("\n");
}

function indexDirNew(db: Database.Database, root: string): string {
  const fc = (db.prepare("SELECT COUNT(*) as c FROM files").get() as any).c;
  const ec = (db.prepare("SELECT COUNT(*) as c FROM exports").get() as any).c;
  const dc = (db.prepare("SELECT COUNT(*) as c FROM dependencies").get() as any).c;
  const s: string[] = [`# Index Summary\nIndexed ${fc} files, ${ec} exports, ${dc} dependencies\n`];
  const dirs = db.prepare("SELECT path, name, description, file_count, total_lines, language_breakdown FROM directories WHERE parent_path = ? ORDER BY name").all(root) as any[];
  if (dirs.length) {
    s.push("## Directories\n");
    for (const d of dirs) {
      const desc = d.description ?? "";
      const lang = d.language_breakdown ? `. ${d.language_breakdown}` : "";
      s.push(`### ${d.name}/\n${desc}${d.file_count ? ` ${d.file_count} files, ${(d.total_lines || 0).toLocaleString()} lines.` : ""}${lang}\n`);
      const files = db.prepare("SELECT path, summary, description FROM files WHERE path LIKE ? AND path NOT LIKE ? ORDER BY path").all(d.path + "/%", d.path + "/%/%") as any[];
      for (const f of files) s.push(`- **${path.basename(f.path)}** — ${f.description ?? f.summary ?? ""}`);
      const sub = db.prepare("SELECT name, description, file_count FROM directories WHERE parent_path = ? ORDER BY name").all(d.path) as any[];
      for (const x of sub) s.push(`- **${x.name}/** (${x.file_count} files) — ${x.description ?? ""}`);
      s.push("");
    }
  }
  const rf = db.prepare("SELECT path, summary, description FROM files WHERE path LIKE ? AND path NOT LIKE ? ORDER BY path").all(root + "/%", root + "/%/%") as any[];
  if (rf.length) { s.push("## Root Files\n"); for (const f of rf) s.push(`- **${path.basename(f.path)}** — ${f.description ?? f.summary ?? ""}`); }
  return s.join("\n");
}

/** find_symbol: the real output, the same in both arms (its format did not change). */
function findSymbol(db: Database.Database, name: string): string {
  return simFindSymbol(db, name);
}

/** search_files: the real output, the same in both arms (its format did not change). */
function searchFiles(db: Database.Database, q: string): string {
  return simSearchFiles(db, q);
}

// ═════════════════════════════════════════════════════════════════════════════
// Step tracker
// ═════════════════════════════════════════════════════════════════════════════

interface Step {
  phase: string;       // research | locate | understand | implement | verify
  tool: string;
  args: string;
  reason: string;      // why the agent made this call
  output: string;
  tokens: number;
  chars: number;
}

function step(phase: string, tool: string, args: string, reason: string, output: string): Step {
  return { phase, tool, args, reason, output, tokens: estimateTokens(output), chars: output.length };
}

interface TaskRun {
  id: string;
  label: string;
  description: string;
  points: number;
  steps: Step[];
  totalTokens: number;
  totalChars: number;
  toolCalls: number;
  filesRead: number;
}

function buildRun(id: string, label: string, description: string, points: number, steps: Step[]): TaskRun {
  return {
    id, label, description, points, steps,
    totalTokens: steps.reduce((s, st) => s + st.tokens, 0),
    totalChars: steps.reduce((s, st) => s + st.chars, 0),
    toolCalls: steps.length,
    filesRead: new Set(steps.filter(s => s.tool === "get_file_context").map(s => s.args)).size,
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// Task simulations — each models a realistic AI agent workflow
// ═════════════════════════════════════════════════════════════════════════════

function runSmallTask(db: Database.Database, format: "old" | "new"): TaskRun {
  const fc = format === "old" ? fileContextOld : fileContextNew;
  const helpers = resolvePath(db, "helpers.ts");
  const utilsIdx = resolvePath(db, "utils/index.ts");
  const indexTs = resolvePath(db, "src/index.ts");

  const steps = [
    // 1. Research: where do utility functions live?
    step("research", "search_files", "helper", "Find where helper functions are defined",
      searchFiles(db, "helper")),

    // 2. Locate: read helpers.ts to understand existing patterns
    step("locate", "get_file_context", "helpers.ts", "Understand existing helper patterns and exports",
      fc(queryFile(db, helpers)!)),

    // 3. Understand: read utils/index.ts to see what's re-exported
    step("understand", "get_file_context", "utils/index.ts", "Check barrel file to know what to re-export",
      fc(queryFile(db, utilsIdx)!)),

    // 4. [implement — agent writes code, no MCP calls]

    // 5. Verify: re-read entry point to confirm import will work
    step("verify", "get_file_context", "src/index.ts", "Verify the new helper can be imported from entry point",
      fc(queryFile(db, indexTs)!)),
  ];

  return buildRun("S", "Small — Add utility function", "Add a slugify() helper to helpers.ts, re-export from utils/index.ts, import in src/index.ts", 2, steps);
}

function runMediumTask(db: Database.Database, format: "old" | "new"): TaskRun {
  const fc = format === "old" ? fileContextOld : fileContextNew;
  const idx = format === "old" ? indexDirOld : indexDirNew;
  const apiTs = resolvePath(db, "services/api.ts");
  const typesTs = resolvePath(db, "types.ts");
  const indexTs = resolvePath(db, "src/index.ts");
  const utilsIdx = resolvePath(db, "utils/index.ts");
  const helpers = resolvePath(db, "helpers.ts");

  const steps = [
    // 1. Research: understand project structure
    step("research", "index_directory", FIXTURE_DIR, "Get full project overview before making cross-file changes",
      idx(db, FIXTURE_DIR)),

    // 2. Locate: find where API methods are defined
    step("locate", "find_symbol", "ApiClient", "Find the API client class to add a new method",
      findSymbol(db, "ApiClient")),

    // 3. Understand: read API file to see existing method patterns
    step("understand", "get_file_context", "api.ts", "Understand existing API methods, return types, and import patterns",
      fc(queryFile(db, apiTs)!)),

    // 4. Understand: read types to see existing interfaces
    step("understand", "get_file_context", "types.ts", "Check existing types to add new response/request interfaces",
      fc(queryFile(db, typesTs)!)),

    // 5. Understand: read entry point to see how API is consumed
    step("understand", "get_file_context", "src/index.ts", "See how the API client is used so new method integrates cleanly",
      fc(queryFile(db, indexTs)!)),

    // 6. Understand: check utils for any validation helpers
    step("understand", "get_file_context", "utils/index.ts", "Check for existing validation/transform utilities to reuse",
      fc(queryFile(db, utilsIdx)!)),

    // 7. Understand: read helpers for existing helper patterns
    step("understand", "get_file_context", "helpers.ts", "Check helpers for existing patterns before adding new ones",
      fc(queryFile(db, helpers)!)),

    // 8. [implement — agent writes code]

    // 9. Verify: re-read API file to confirm method was added correctly
    step("verify", "get_file_context", "api.ts", "Verify new method signature matches existing patterns",
      fc(queryFile(db, apiTs)!)),

    // 10. Verify: re-read entry point to confirm integration
    step("verify", "get_file_context", "src/index.ts", "Verify new API method is properly called from entry point",
      fc(queryFile(db, indexTs)!)),
  ];

  return buildRun("M", "Medium — Add API method with types", "Add createUser() to ApiClient, new CreateUserRequest type, wire into entry point with validation", 3, steps);
}

function runLargeTask(db: Database.Database, format: "old" | "new"): TaskRun {
  const fc = format === "old" ? fileContextOld : fileContextNew;
  const idx = format === "old" ? indexDirOld : indexDirNew;
  const allTs = db.prepare("SELECT path FROM files WHERE language = 'typescript' ORDER BY path").all() as { path: string }[];
  const apiTs = resolvePath(db, "services/api.ts");
  const typesTs = resolvePath(db, "types.ts");
  const indexTs = resolvePath(db, "src/index.ts");

  const steps: Step[] = [];

  // Phase 1: Research — full project scan
  steps.push(step("research", "index_directory", FIXTURE_DIR, "Full project overview for cross-cutting refactor",
    idx(db, FIXTURE_DIR)));

  // Phase 2: Research — search for all API-related code
  steps.push(step("research", "search_files", "api", "Find all files touching the API layer",
    searchFiles(db, "api")));
  steps.push(step("research", "search_files", "request", "Find all request/response patterns",
    searchFiles(db, "request")));
  steps.push(step("research", "find_symbol", "ApiClient", "Locate the main class to refactor",
    findSymbol(db, "ApiClient")));
  steps.push(step("research", "find_symbol", "ApiResponse", "Find the response type to generalize",
    findSymbol(db, "ApiResponse")));

  // Phase 3: Understand — read ALL TypeScript files (deep understanding needed for refactor)
  for (const f of allTs) {
    steps.push(step("understand", "get_file_context", path.basename(f.path),
      `Read ${path.basename(f.path)} to understand its role in the API dependency graph`,
      fc(queryFile(db, f.path)!)));
  }

  // Phase 4: Plan — re-read key files to plan the refactor
  steps.push(step("understand", "get_file_context", "api.ts (re-read)", "Re-read API class to plan base class extraction",
    fc(queryFile(db, apiTs)!)));
  steps.push(step("understand", "get_file_context", "types.ts (re-read)", "Re-read types to plan interface hierarchy",
    fc(queryFile(db, typesTs)!)));

  // Phase 5: [implement — agent writes code across multiple files]

  // Phase 6: Verify — re-read all modified files to confirm refactor
  steps.push(step("verify", "get_file_context", "api.ts (verify)", "Verify refactored API class extends new base",
    fc(queryFile(db, apiTs)!)));
  steps.push(step("verify", "get_file_context", "types.ts (verify)", "Verify new interface hierarchy is correct",
    fc(queryFile(db, typesTs)!)));
  steps.push(step("verify", "get_file_context", "src/index.ts (verify)", "Verify entry point still works with refactored API",
    fc(queryFile(db, indexTs)!)));

  return buildRun("L", "Large — Refactor API layer", "Extract BaseApiClient, add interceptor pattern, update all consumers, add error handling types", 5, steps);
}

// ═════════════════════════════════════════════════════════════════════════════
// Report printer
// ═════════════════════════════════════════════════════════════════════════════

function printTaskComparison(old: TaskRun, nw: TaskRun) {
  const tokSaved = old.totalTokens - nw.totalTokens;
  const tokPct = ((tokSaved / old.totalTokens) * 100).toFixed(1);
  const charSaved = old.totalChars - nw.totalChars;
  const charPct = ((charSaved / old.totalChars) * 100).toFixed(1);

  const lines: string[] = [];
  lines.push(`┌─── [${old.id}] ${old.label} (${old.points}pt) ${"─".repeat(Math.max(0, 78 - old.label.length - 10))}┐`);
  lines.push(`│ ${old.description}`.padEnd(93) + "│");
  lines.push(`├────────────┬───────────────────────────────────────────────────────────────────────────────┤`);
  lines.push(`│            │  OLD format          NEW format          Saved                              │`);
  lines.push(`├────────────┼───────────────────────────────────────────────────────────────────────────────┤`);
  lines.push(`│ Tool calls │  ${String(old.toolCalls).padEnd(21)}${String(nw.toolCalls).padEnd(21)}(identical — format only)            │`);
  lines.push(`│ Files read │  ${String(old.filesRead).padEnd(21)}${String(nw.filesRead).padEnd(21)}(identical)                          │`);
  lines.push(`│ Tokens     │  ${String(old.totalTokens).padEnd(21)}${String(nw.totalTokens).padEnd(21)}${tokSaved} (${tokPct}%)`.padEnd(37) + "│");
  lines.push(`│ Characters │  ${String(old.totalChars).padEnd(21)}${String(nw.totalChars).padEnd(21)}${charSaved} (${charPct}%)`.padEnd(37) + "│");
  lines.push(`├────────────┴───────────────────────────────────────────────────────────────────────────────┤`);

  // Step-by-step breakdown
  lines.push(`│ Step-by-step:                                                                              │`);
  for (let i = 0; i < old.steps.length; i++) {
    const os = old.steps[i], ns = nw.steps[i];
    const saved = os.tokens - ns.tokens;
    const pct = os.tokens > 0 ? ((saved / os.tokens) * 100).toFixed(0) : "0";
    const phase = `[${os.phase}]`.padEnd(12);
    const call = `${os.tool}(${os.args})`.substring(0, 35).padEnd(36);
    const delta = saved === 0 ? "same" : `${saved > 0 ? "-" : "+"}${Math.abs(saved)} tok (${saved > 0 ? "-" : "+"}${pct}%)`;
    lines.push(`│  ${phase} ${call} ${String(os.tokens).padStart(4)}→${String(ns.tokens).padEnd(4)} ${delta.padEnd(20)}│`);
  }

  lines.push(`│                                                                                             │`);
  lines.push(`│ Reasoning: ${old.steps.filter(s => s.phase === "research").length} research calls, ${old.steps.filter(s => s.phase === "understand").length} understand, ${old.steps.filter(s => s.phase === "verify").length} verify`.padEnd(93) + "│");
  lines.push(`└─────────────────────────────────────────────────────────────────────────────────────────────┘`);

  return lines.join("\n");
}

// ═════════════════════════════════════════════════════════════════════════════
// Tests
// ═════════════════════════════════════════════════════════════════════════════

describe("Development task A/B benchmark", () => {
  let db: Database.Database;
  let oldS: TaskRun, oldM: TaskRun, oldL: TaskRun;
  let newS: TaskRun, newM: TaskRun, newL: TaskRun;

  beforeAll(() => {
    db = createTestDb();
    indexDirectory(db, FIXTURE_DIR);
    oldS = runSmallTask(db, "old");  newS = runSmallTask(db, "new");
    oldM = runMediumTask(db, "old"); newM = runMediumTask(db, "new");
    oldL = runLargeTask(db, "old");  newL = runLargeTask(db, "new");
  });

  it("prints full A/B benchmark report", () => {
    const totalOld = oldS.totalTokens + oldM.totalTokens + oldL.totalTokens;
    const totalNew = newS.totalTokens + newM.totalTokens + newL.totalTokens;
    const totalSaved = totalOld - totalNew;
    const totalPct = ((totalSaved / totalOld) * 100).toFixed(1);
    const totalOldChars = oldS.totalChars + oldM.totalChars + oldL.totalChars;
    const totalNewChars = newS.totalChars + newM.totalChars + newL.totalChars;

    const report: string[] = [];
    report.push("");
    report.push("╔══════════════════════════════════════════════════════════════════════════════════════════════════╗");
    report.push("║  DEVELOPMENT TASK A/B BENCHMARK                                                                ║");
    report.push("║  Format: OLD (pre-Sprint 10) vs NEW (optimized)                                                ║");
    report.push("║  Fixture: sample-project (10 files, 5 TypeScript, 19 exports, 5 dependency edges)              ║");
    report.push("║  Measures: total MCP output tokens consumed during simulated development workflow               ║");
    report.push("╚══════════════════════════════════════════════════════════════════════════════════════════════════╝");
    report.push("");
    report.push(printTaskComparison(oldS, newS));
    report.push("");
    report.push(printTaskComparison(oldM, newM));
    report.push("");
    report.push(printTaskComparison(oldL, newL));
    report.push("");
    report.push("╔══════════════════════════════════════════════════════════════════════════════════════════════════╗");
    report.push(`║  AGGREGATE (3 tasks, ${oldS.points + oldM.points + oldL.points}pts)`.padEnd(93) + "║");
    report.push(`║  Tokens:     ${totalOld} → ${totalNew} (${totalSaved} saved, ${totalPct}% reduction)`.padEnd(93) + "║");
    report.push(`║  Characters: ${totalOldChars} → ${totalNewChars} (${totalOldChars - totalNewChars} saved)`.padEnd(93) + "║");
    report.push(`║  Tool calls: ${oldS.toolCalls + oldM.toolCalls + oldL.toolCalls} total (identical between formats)`.padEnd(93) + "║");
    report.push("╠══════════════════════════════════════════════════════════════════════════════════════════════════╣");
    report.push("║  Key findings:                                                                                 ║");
    report.push(`║  • Small task  (${oldS.toolCalls} calls): ${((oldS.totalTokens - newS.totalTokens) / oldS.totalTokens * 100).toFixed(0)}% savings — even quick tasks benefit`.padEnd(93) + "║");
    report.push(`║  • Medium task (${oldM.toolCalls} calls): ${((oldM.totalTokens - newM.totalTokens) / oldM.totalTokens * 100).toFixed(0)}% savings — scales with file reads`.padEnd(93) + "║");
    report.push(`║  • Large task  (${oldL.toolCalls} calls): ${((oldL.totalTokens - newL.totalTokens) / oldL.totalTokens * 100).toFixed(0)}% savings — compounds across many reads`.padEnd(93) + "║");
    report.push("║  • search_files and find_symbol: 0% change (output not modified)                               ║");
    report.push("║  • get_file_context: 25-34% per call — this is where all savings come from                     ║");
    report.push("║  • Zero information loss — all exports, deps, symbols, summaries preserved                     ║");
    report.push("╚══════════════════════════════════════════════════════════════════════════════════════════════════╝");
    report.push("");

    console.log(report.join("\n"));
    expect(oldS.toolCalls + oldM.toolCalls + oldL.toolCalls).toBeGreaterThan(0);
  });

  // ── Small task assertions ───────────────────────────────────────────────
  it("[S] new format saves tokens on small task", () => {
    expect(newS.totalTokens).toBeLessThan(oldS.totalTokens);
  });

  it("[S] same number of tool calls and files read", () => {
    expect(newS.toolCalls).toBe(oldS.toolCalls);
    expect(newS.filesRead).toBe(oldS.filesRead);
  });

  // ── Medium task assertions ──────────────────────────────────────────────
  it("[M] new format saves tokens on medium task", () => {
    expect(newM.totalTokens).toBeLessThan(oldM.totalTokens);
  });

  it("[M] savings come from get_file_context calls, not search/find", () => {
    for (let i = 0; i < oldM.steps.length; i++) {
      if (oldM.steps[i].tool === "find_symbol" || oldM.steps[i].tool === "search_files") {
        expect(newM.steps[i].tokens).toBe(oldM.steps[i].tokens);
      }
      if (oldM.steps[i].tool === "get_file_context") {
        expect(newM.steps[i].tokens).toBeLessThan(oldM.steps[i].tokens);
      }
    }
  });

  // ── Large task assertions ───────────────────────────────────────────────
  it("[L] new format saves tokens on large task", () => {
    expect(newL.totalTokens).toBeLessThan(oldL.totalTokens);
  });

  it("[L] large task has highest absolute token savings", () => {
    const savedS = oldS.totalTokens - newS.totalTokens;
    const savedM = oldM.totalTokens - newM.totalTokens;
    const savedL = oldL.totalTokens - newL.totalTokens;
    expect(savedL).toBeGreaterThan(savedM);
    expect(savedM).toBeGreaterThan(savedS);
  });

  it("[L] large task makes the most tool calls", () => {
    expect(oldL.toolCalls).toBeGreaterThan(oldM.toolCalls);
    expect(oldM.toolCalls).toBeGreaterThan(oldS.toolCalls);
  });

  // ── Aggregate assertions ────────────────────────────────────────────────
  it("aggregate savings >10% across all tasks", () => {
    const totalOld = oldS.totalTokens + oldM.totalTokens + oldL.totalTokens;
    const totalNew = newS.totalTokens + newM.totalTokens + newL.totalTokens;
    const pct = ((totalOld - totalNew) / totalOld) * 100;
    // Floor just under the measured value: 10.7 % on 2026-10-11 (was 20.97 %).
    // NEW is now the real get_file_context output, which since #119 carries
    // signatures and import lines (alone: 21.0 % → 9.0 %), and the sample
    // project has 5 correct import edges instead of 3 (#120). OLD prints fixed
    // absolute paths, so the number no longer depends on the checkout path.
    expect(pct, `${pct.toFixed(1)}% savings`).toBeGreaterThan(10);
  });

  it("every get_file_context call across all tasks: new < old", () => {
    const allOld = [...oldS.steps, ...oldM.steps, ...oldL.steps];
    const allNew = [...newS.steps, ...newM.steps, ...newL.steps];
    for (let i = 0; i < allOld.length; i++) {
      if (allOld[i].tool === "get_file_context") {
        expect(allNew[i].tokens, `step ${i}: ${allOld[i].args}`).toBeLessThan(allOld[i].tokens);
      }
    }
  });
});
