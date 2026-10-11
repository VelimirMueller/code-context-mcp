import { describe, it, expect, afterEach } from "vitest";
import {
  hiddenTools, toolFilter, CODE_TOOLS, instrumentTools, decorate, flairHeader, flairFooter, looksLikeJson, OPTIONAL_TOOLSETS,
} from "../src/server/tool-wrap.js";

type Handler = (...a: unknown[]) => unknown;

/** Minimal stand-in for McpServer.tool: records registrations. */
function fakeServer() {
  const registered = new Map<string, Handler>();
  const server = {
    tool(...args: unknown[]) {
      registered.set(args[0] as string, args[args.length - 1] as Handler);
      return { name: args[0] };
    },
  };
  return { server, registered };
}

afterEach(() => {
  process.env.OVERDRIVE_FLAIR = "0";
});

describe("toolsets", () => {
  it("hides the optional toolsets by default", () => {
    const hidden = hiddenTools(undefined);
    for (const t of [...OPTIONAL_TOOLSETS.fun, ...OPTIONAL_TOOLSETS.stream]) expect(hidden.has(t)).toBe(true);
    expect(hidden.has("record_mood")).toBe(true);
    expect(hidden.has("search_files")).toBe(false);
    expect(hidden.has("request_user_input")).toBe(false);
  });

  it("CODE_CONTEXT_TOOLSETS enables sets by name, or all", () => {
    expect(hiddenTools("fun").has("record_mood")).toBe(false);
    expect(hiddenTools("fun").has("send_claude_output")).toBe(true);
    expect(hiddenTools(" +stream , fun ").size).toBe(0);
    expect(hiddenTools("all").size).toBe(0);
    expect(hiddenTools("default").has("generate_vision_animation")).toBe(true);
  });

  it("never registers a hidden tool", () => {
    const { server, registered } = fakeServer();
    instrumentTools(server, hiddenTools(undefined));
    (server as any).tool("record_mood", "d", {}, () => ({ content: [] }));
    (server as any).tool("search_files", "d", {}, () => ({ content: [] }));
    expect([...registered.keys()]).toEqual(["search_files"]);
  });
});

describe("flair", () => {
  it("header and footer follow FLAIR.md and fit 72 chars", () => {
    expect(flairHeader("search_files")).toBe("● code-context ▸ search_files ░▒▓");
    expect(flairFooter(79, false)).toMatch(/^\S.* 79 ms$/);
    expect(flairFooter(79, true)).toMatch(/^(\(╯°□°\)╯︵ ┻━┻|ಠ_ಠ) 79 ms$/);
    expect(flairHeader("x".repeat(100)).length).toBeLessThanOrEqual(72);
  });

  it("decorates text responses with one header and one footer", () => {
    process.env.OVERDRIVE_FLAIR = "1";
    const out = decorate({ content: [{ type: "text", text: "body" }] }, "search_files", 12) as any;
    const lines = out.content[0].text.split("\n");
    expect(lines[0]).toBe("● code-context ▸ search_files ░▒▓");
    expect(lines[1]).toBe("body");
    expect(lines[2]).toMatch(/ 12 ms$/);
    expect(lines).toHaveLength(3);
  });

  it("leaves JSON responses alone", () => {
    process.env.OVERDRIVE_FLAIR = "1";
    const r = { content: [{ type: "text", text: JSON.stringify({ a: 1 }, null, 2) }] };
    expect(decorate(r, "health", 3)).toBe(r);
    expect(looksLikeJson("[1,2]")).toBe(true);
    expect(looksLikeJson("[STALE] not json")).toBe(false);
  });

  it("errors keep the text plain and first, footer uses a fail kaomoji", () => {
    process.env.OVERDRIVE_FLAIR = "1";
    const out = decorate({ content: [{ type: "text", text: "Error: boom" }], isError: true }, "query", 4) as any;
    expect(out.content[0].text.startsWith("Error: boom\n")).toBe(true);
    expect(out.content[0].text).not.toContain("░▒▓");
    expect(out.content[0].text).toMatch(/(┻━┻|ಠ_ಠ) 4 ms$/);
  });

  it("OVERDRIVE_FLAIR=0 turns it off (the test default: no art in non-flair tests)", () => {
    process.env.OVERDRIVE_FLAIR = "0";
    const r = { content: [{ type: "text", text: "body" }] };
    expect(decorate(r, "x", 1)).toBe(r);
  });

  it("the instrumented handler times, decorates and keeps sync/async behaviour", async () => {
    process.env.OVERDRIVE_FLAIR = "1";
    const { server, registered } = fakeServer();
    instrumentTools(server, new Set());
    (server as any).tool("a", "d", {}, async () => ({ content: [{ type: "text", text: "async" }] }));
    (server as any).tool("b", "d", {}, () => ({ content: [{ type: "text", text: "sync" }] }));
    const a = (await registered.get("a")!({})) as any;
    expect(a.content[0].text).toMatch(/^● code-context ▸ a ░▒▓\nasync\n.+ \d+ ms$/);
    const b = registered.get("b")!({}) as any;
    expect(typeof b.then).toBe("undefined");
    expect(b.content[0].text).toContain("▸ b ░▒▓");
  });

  it("instrumentTools is idempotent", () => {
    process.env.OVERDRIVE_FLAIR = "1";
    const { server, registered } = fakeServer();
    instrumentTools(server, new Set());
    instrumentTools(server, new Set());
    (server as any).tool("a", "d", {}, () => ({ content: [{ type: "text", text: "x" }] }));
    const out = registered.get("a")!({}) as any;
    expect(out.content[0].text.match(/░▒▓/g)).toHaveLength(1);
  });
});

describe("toolFilter — the code profile (2026-10-11)", () => {
  it("code keeps exactly the code tools", () => {
    const f = toolFilter("code");
    for (const t of CODE_TOOLS) expect(f.has(t)).toBe(false);
    for (const t of ["create_ticket", "plan_sprint", "record_mood", "send_claude_output"]) expect(f.has(t)).toBe(true);
  });
  it("all wins over code; no env keeps today's default", () => {
    expect(toolFilter("code,all").has("create_ticket")).toBe(false);
    expect(toolFilter(undefined).has("create_ticket")).toBe(false);
    expect(toolFilter(undefined).has("record_mood")).toBe(true);
  });
  it("instrumentTools registers only code tools under the code profile", () => {
    const registered: string[] = [];
    const server = { tool: (name: string) => { registered.push(name); return {}; } };
    instrumentTools(server, toolFilter("code"));
    for (const n of ["find_symbol", "create_ticket", "get_file_context", "log_decision"]) {
      (server.tool as (...a: unknown[]) => unknown)(n, "d", {}, async () => ({}));
    }
    expect(registered).toEqual(["find_symbol", "get_file_context"]);
  });
});
