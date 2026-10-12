/**
 * CCA-16 (#148): PHP structure in the code index — declarations with
 * signatures, `use` imports, PSR-4 edges — so who_imports, exports_in,
 * find_symbol and get_file_context answer in a PHP repo.
 *
 * The fixture (test/fixtures/php-app) is synthetic Laravel-style code. The
 * server tests index a copy under `<tmp>/repo/laravel/`, so composer.json
 * sits in a subdirectory of the indexed root, as in a monorepo.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { initSchema } from "../src/server/schema.js";
import { indexDirectory, refreshFiles } from "../src/server/indexer.js";
import { parsePhp, stripPhp } from "../src/server/php.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE = path.join(REPO_ROOT, "test/fixtures/php-app");
const TSX_CLI = path.join(REPO_ROOT, "node_modules/tsx/dist/cli.mjs");
const SERVER_ENTRY = path.join(REPO_ROOT, "src/server/index.ts");

const text = (r: Awaited<ReturnType<Client["callTool"]>>): string => (r.content as { text: string }[]).map((c) => c.text).join("\n");

let base: string;
let repo: string;
let client: Client;
let db: Database.Database;
const call = async (name: string, args: Record<string, unknown>) => text(await client.callTool({ name, arguments: args }));

beforeAll(async () => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cca16-php-")));
  repo = path.join(base, "repo");
  fs.cpSync(FIXTURE, path.join(repo, "laravel"), { recursive: true });
  const dbPath = path.join(base, "context.db");
  db = new Database(dbPath);
  initSchema(db);
  const saved = process.env.CODE_CONTEXT_ALLOWED_ROOTS;
  process.env.CODE_CONTEXT_ALLOWED_ROOTS = base;
  try {
    indexDirectory(db, repo);
  } finally {
    if (saved === undefined) delete process.env.CODE_CONTEXT_ALLOWED_ROOTS;
    else process.env.CODE_CONTEXT_ALLOWED_ROOTS = saved;
  }
  const env = { ...(process.env as Record<string, string>), CODE_CONTEXT_TOOLSETS: "code", CODE_CONTEXT_ALLOWED_ROOTS: base, CODE_CONTEXT_ABSOLUTE_PATHS: "" };
  delete env.OVERDRIVE_FLAIR;
  delete env.CODE_CONTEXT_TIMESTAMPS;
  const transport = new StdioClientTransport({ command: process.execPath, args: [TSX_CLI, SERVER_ENTRY, dbPath], cwd: repo, env, stderr: "ignore" });
  client = new Client({ name: "cca16-test", version: "0.0.0" });
  await client.connect(transport);
}, 60_000);

afterAll(async () => {
  await client?.close();
  db?.close();
  if (base) fs.rmSync(base, { recursive: true, force: true });
});

// ─── Parser (unit) ───────────────────────────────────────────────────────────
describe("stripPhp: comments, strings, heredoc and inline HTML never reach the parser", () => {
  it("blanks them to spaces, keeps newlines, length and PHP 8 attributes", () => {
    const src = [
      "<h1>{{ \\App\\Decoy0::class }}</h1>",
      "<?php",
      "// new \\App\\Decoy1();",
      "# use App\\Decoy2;",
      "/** @see \\App\\Decoy3 */",
      "#[\\App\\Attr]",
      "$a = 'App\\Decoy4' . \"{$x['k']} \\App\\Decoy5\";",
      "$h = <<<EOT",
      "  new \\App\\Decoy6()",
      "  EOT;",
      "$n = <<<'NOW'",
      "\\App\\Decoy7::make()",
      "NOW;",
      "new \\App\\Real(); ?>",
      "<p>\\App\\Decoy8</p>",
    ].join("\n");
    const out = stripPhp(src);
    expect(out.length).toBe(src.length);
    expect(out.split("\n").length).toBe(src.split("\n").length);
    expect(out).not.toContain("Decoy");
    expect(out).toContain("#[\\App\\Attr]");
    expect(out).toContain("new \\App\\Real();");
  });

  it("a nested quote inside {$…} interpolation does not end the string", () => {
    const out = stripPhp(`<?php $s = "{$a["k"]} \\App\\Hidden"; new Visible();`);
    expect(out).not.toContain("Hidden");
    expect(out).toContain("new Visible();");
  });
});

describe("parsePhp: declarations, use statements and references", () => {
  const src = [
    "<?php",
    "",
    "namespace App\\Services;",
    "",
    "use App\\Models\\{Order, User as Customer, function helper};",
    "use App\\Contracts\\HasEvents, App\\Contracts\\HasLabel as Label;",
    "use function App\\Support\\format_money;",
    "use const App\\Support\\DEFAULT_CURRENCY;",
    "use App\\Models;",
    "",
    "const VERSION = '1.0';",
    "",
    "function helper(string $x): int",
    "{",
    "    return \\strlen($x);",
    "}",
    "",
    "#[\\Attribute]",
    "abstract readonly class Base implements HasEvents, Label {}",
    "interface Contract extends \\Countable {}",
    "trait Loggable { public function log(): void {} }",
    "enum Status: string { case Active = 'a'; }",
    "final class OrderService extends Base implements Contract",
    "{",
    "    use Loggable, \\App\\Concerns\\HasUuid { Loggable::log as protected; }",
    "    private const MAX = 3;",
    "    public function run(Customer $c, ?Sibling $s): Models\\Invoice",
    "    {",
    "        $f = function () use ($c) { return new class extends Anonymous {}; };",
    "        try { Order::query(); } catch (NotFound | \\RuntimeException $e) {}",
    "        return format_money(1, DEFAULT_CURRENCY) . $c->Missing() . Status::Active->value;",
    "    }",
    "}",
  ].join("\n");
  const parsed = parsePhp(src);

  it("exports type-level declarations, top-level functions and constants with signatures and lines", () => {
    expect(parsed.namespace).toBe("App\\Services");
    expect(parsed.exports.map((e) => [e.kind, e.fqn, e.line, e.signature])).toEqual([
      ["const", "App\\Services\\VERSION", 11, "const VERSION = '1.0'"],
      ["function", "App\\Services\\helper", 13, "function helper(string $x): int"],
      ["class", "App\\Services\\Base", 19, "abstract readonly class Base implements HasEvents, Label"],
      ["interface", "App\\Services\\Contract", 20, "interface Contract extends \\Countable"],
      ["trait", "App\\Services\\Loggable", 21, "trait Loggable"],
      ["enum", "App\\Services\\Status", 22, "enum Status: string"],
      ["class", "App\\Services\\OrderService", 23, "final class OrderService extends Base implements Contract"],
    ]);
    expect(parsed.exports.map((e) => e.name)).toEqual(["VERSION", "helper", "Base", "Contract", "Loggable", "Status", "OrderService"]);
  });

  it("import lines are the top-level use statements; trait use and closure use are not", () => {
    expect(parsed.useLines).toEqual([
      { line: 5, text: "use App\\Models\\{Order, User as Customer, function helper};" },
      { line: 6, text: "use App\\Contracts\\HasEvents, App\\Contracts\\HasLabel as Label;" },
      { line: 7, text: "use function App\\Support\\format_money;" },
      { line: 8, text: "use const App\\Support\\DEFAULT_CURRENCY;" },
      { line: 9, text: "use App\\Models;" },
    ]);
  });

  it("references resolve through aliases, the namespace and fully qualified names", () => {
    const refs = parsed.refs.map((r) => `${r.kind} ${r.fqn}${r.fromUse ? " use" : ""}${r.tentative ? " ?" : ""}`);
    expect(refs).toEqual([
      "class App\\Models\\Order use",
      "class App\\Models\\User use",
      "function App\\Models\\helper use",
      "class App\\Contracts\\HasEvents use",
      "class App\\Contracts\\HasLabel use",
      "function App\\Support\\format_money use",
      "const App\\Support\\DEFAULT_CURRENCY use",
      "class App\\Models use",
      "class Attribute",
      "class Countable",
      "class App\\Services\\Base ?",
      "class App\\Services\\Contract ?",
      "class App\\Services\\Loggable ?",
      "class App\\Concerns\\HasUuid",
      "class App\\Services\\Sibling ?",
      "class App\\Models\\Invoice",
      "class App\\Services\\Anonymous ?",
      "class App\\Services\\NotFound ?",
      "class RuntimeException",
      "class App\\Services\\Status ?",
    ]);
  });
});

// ─── Fixture: index + tools ──────────────────────────────────────────────────
describe("index of test/fixtures/php-app (composer.json in laravel/)", () => {
  const rel = (p: string) => path.relative(repo, p);

  it("indexes PHP files, never vendor/ or Laravel storage/", () => {
    const files = (db.prepare(`SELECT path FROM files WHERE extension = '.php' ORDER BY path`).all() as { path: string }[]).map((r) => rel(r.path));
    expect(files).toHaveLength(23);
    expect(files.some((f) => f.includes("/vendor/") || f.includes("/storage/"))).toBe(false);
    const names = (db.prepare(`SELECT name FROM exports`).all() as { name: string }[]).map((r) => r.name);
    expect(names).not.toContain("Collection");
    expect(names).not.toContain("CompiledViewDecoy");
  });

  it("records vendor namespaces as external packages, not edges", () => {
    const ext = (f: string) => (db.prepare(`SELECT external_imports FROM files WHERE path = ?`).get(path.join(repo, f)) as { external_imports: string | null }).external_imports;
    expect(ext("laravel/app/Services/OrderService.php")).toBe("Illuminate");
    expect(ext("laravel/tests/TestCase.php")).toBe("PHPUnit");
    expect(ext("laravel/app/Contracts/HasEvents.php")).toBeNull();
  });

  it("a Blade view is inline HTML: no exports, no imports, no edges", () => {
    const row = db.prepare(`SELECT id, import_lines FROM files WHERE path = ?`).get(path.join(repo, "laravel/resources/views/orders/show.blade.php")) as { id: number; import_lines: string };
    expect(row.import_lines).toBe("[]");
    expect(db.prepare(`SELECT COUNT(*) AS n FROM dependencies WHERE source_id = ?`).get(row.id)).toEqual({ n: 0 });
  });

  it("who_imports by short name: the use statements, with their lines", async () => {
    expect(await call("who_imports", { target: "OrderService" })).toBe(
      [
        "# OrderService (laravel/app/Services/OrderService.php): imported by 2 files — complete list from the import graph",
        "- laravel/app/Http/Controllers/OrderController.php L6 [OrderService]",
        "- laravel/tests/Feature/OrderServiceTest.php L6 [OrderService]",
      ].join("\n"),
    );
  }, 30_000);

  it("who_imports by qualified name, across packages (nested composer.json)", async () => {
    expect(await call("who_imports", { target: "App\\Contracts\\PaymentGateway" })).toBe(
      [
        "# App\\Contracts\\PaymentGateway (laravel/app/Contracts/PaymentGateway.php): imported by 2 files — complete list from the import graph",
        "- laravel/app/Services/OrderService.php L6 [PaymentGateway]",
        "- laravel/packages/billing/src/Gateways/FakeGateway.php L5 [PaymentGateway]",
      ].join("\n"),
    );
    expect(await call("who_imports", { target: "\\App\\Nope\\Missing" })).toBe('No indexed PHP file declares "App\\Nope\\Missing".');
  }, 30_000);

  it("who_imports by path: same-namespace extends and a fully qualified implements count", async () => {
    expect(await call("who_imports", { target: "laravel/app/Contracts/HasEvents.php" })).toBe(
      [
        "# laravel/app/Contracts/HasEvents.php: imported by 3 files — complete list from the import graph",
        "- laravel/app/Contracts/PaymentGateway.php L8 [HasEvents]",
        "- laravel/app/Models/Order.php L9 [HasEvents]",
        "- laravel/app/Services/OrderService.php L5 [HasEvents]",
      ].join("\n"),
    );
  }, 30_000);

  it("functions and constants: use function / use const and a global helper", async () => {
    expect(await call("who_imports", { target: "format_money" })).toBe(
      [
        "# format_money (laravel/app/Support/functions.php): imported by 2 files — complete list from the import graph",
        "- laravel/app/Services/OrderService.php L10,L11 [format_money, DEFAULT_CURRENCY]",
        "- laravel/app/helpers.php L6 [format_money]",
      ].join("\n"),
    );
    expect(await call("who_imports", { target: "money" })).toContain("- laravel/app/Http/Controllers/OrderController.php L14 [money]");
  }, 30_000);

  it("trait use, same-namespace ::class and route [Controller::class, 'm'] are edges", async () => {
    expect(await call("who_imports", { target: "HasUuid" })).toContain("imported by 2 files");
    expect(await call("who_imports", { target: "Auditable" })).toContain("- laravel/app/Models/Order.php L11 [Auditable]");
    expect(await call("who_imports", { target: "laravel/app/Models/Order.php" })).toContain("- laravel/app/Models/User.php L15 [Order]");
    expect(await call("who_imports", { target: "OrderController" })).toContain("- laravel/routes/web.php L3 [OrderController]");
  }, 30_000);

  it("decoys in comments, strings, heredoc, nowdoc and Blade create no edge", async () => {
    expect(await call("who_imports", { target: "Decoy" })).toBe(
      ["# Decoy (laravel/app/Decoys/Decoy.php): imported by 0 files — complete list from the import graph", "No indexed file imports it."].join("\n"),
    );
    // the route file names OrderService only inside a string
    expect(await call("who_imports", { target: "OrderService" })).not.toContain("routes/web.php");
  }, 30_000);

  it("exports_in unused: only the decoy class is imported by nobody", async () => {
    const out = await call("exports_in", { dir: "laravel/app", unused: true });
    expect(out.split("\n")[0]).toBe("# Unused exports in laravel/app: 1 of 16 — no indexed file imports them (complete from the import graph)");
    expect(out).toContain("## laravel/app/Decoys/Decoy.php\n- L9 class Decoy");
  }, 30_000);

  it("exports_in: signatures and lines", async () => {
    expect(await call("exports_in", { dir: "laravel/app/Services" })).toBe(
      [
        "# Exports in laravel/app/Services: 2 in 2 files",
        "## laravel/app/Services/BaseService.php",
        "- L5 abstract class BaseService",
        "## laravel/app/Services/OrderService.php",
        "- L18 final class OrderService extends BaseService implements HasEvents",
      ].join("\n"),
    );
    const billing = await call("exports_in", { dir: "laravel/packages/billing/src" });
    expect(billing).toContain("- L5 final readonly class Invoice");
    expect(await call("exports_in", { dir: "laravel/app/Enums" })).toContain("- L7 enum OrderStatus: string implements HasLabel");
    expect(await call("exports_in", { dir: "laravel/app/Support" })).toContain(
      "- L5 const DEFAULT_CURRENCY = 'EUR'\n- L7 function format_money(int $cents, string $currency = DEFAULT_CURRENCY): string",
    );
  }, 30_000);

  it("find_symbol: short name, qualified name (leading backslash optional) and a namespace wildcard", async () => {
    expect(await call("find_symbol", { name: "OrderService" })).toBe("App\\Services\\OrderService (class) — laravel/app/Services/OrderService.php\n  Exports: OrderService");
    expect(await call("find_symbol", { name: "\\App\\Models\\User" })).toBe("App\\Models\\User (class) — laravel/app/Models/User.php\n  Exports: User");
    expect(await call("find_symbol", { name: "App\\Models\\User" })).toBe("App\\Models\\User (class) — laravel/app/Models/User.php\n  Exports: User");
    const models = await call("find_symbol", { name: "App\\Models\\%" });
    expect(models.split("\n").filter((l) => l.startsWith("App\\"))).toEqual([
      "App\\Models\\Auditable (trait) — laravel/app/Models/Auditable.php",
      "App\\Models\\Order (class) — laravel/app/Models/Order.php",
      "App\\Models\\User (class) — laravel/app/Models/User.php",
    ]);
    expect(await call("find_symbol", { name: "Collection" })).toBe('No exports matching "Collection" found.');
  }, 30_000);

  it("get_file_context: signature, use lines, externals, edges both ways", async () => {
    expect(await call("get_file_context", { path: "laravel/app/Services/OrderService.php" })).toBe(
      [
        "# laravel/app/Services/OrderService.php",
        "php | 1.2 KB | 50 lines",
        "Exports: OrderService",
        "defines OrderService. uses Illuminate.",
        "## Exports (1)",
        "- L18 final class OrderService extends BaseService implements HasEvents",
        "## Import lines (7)",
        "L5 use App\\Contracts\\HasEvents;",
        "L6 use App\\Contracts\\PaymentGateway;",
        "L7 use App\\Models\\{Order, User as Customer};",
        "L8 use Acme\\Billing\\Invoice;",
        "L9 use Illuminate\\Support\\Facades\\Log;",
        "L10 use function App\\Support\\format_money;",
        "L11 use const App\\Support\\DEFAULT_CURRENCY;",
        "## External packages",
        "Illuminate",
        "## Imports from (8)",
        "- laravel/app/Contracts/HasEvents.php [HasEvents]",
        "- laravel/app/Contracts/PaymentGateway.php [PaymentGateway]",
        "- laravel/app/Models/Order.php [Order]",
        "- laravel/app/Models/User.php [User]",
        "- laravel/packages/billing/src/Invoice.php [Invoice]",
        "- laravel/app/Support/functions.php [format_money, DEFAULT_CURRENCY]",
        "- laravel/app/Services/BaseService.php [BaseService]",
        "- laravel/packages/billing/src/InvoiceNumber.php [InvoiceNumber]",
        "## Imported by (2)",
        "- laravel/app/Http/Controllers/OrderController.php [OrderService]",
        "- laravel/tests/Feature/OrderServiceTest.php [OrderService]",
      ].join("\n"),
    );
  }, 30_000);

  it("a single-file refresh rebuilds the same PHP edges", () => {
    const file = path.join(repo, "laravel/app/Services/OrderService.php");
    const edges = () => db.prepare(`SELECT t.path, d.symbols FROM dependencies d JOIN files s ON s.id = d.source_id JOIN files t ON t.id = d.target_id WHERE s.path = ? ORDER BY t.path`).all(file);
    const before = edges();
    expect(before).toHaveLength(8);
    expect(refreshFiles(db, [file], repo)).toEqual({ reindexed: 1, dropped: 0 });
    expect(edges()).toEqual(before);
  });
});
