/**
 * CCA-02 (#117): the `code` profile lists four tools and its tools/list stays
 * small. Every listed character is sent on every model call, so the size is
 * pinned with an upper bound: grow it on purpose, never by accident.
 *
 * Measured 2026-10-11 with OVERDRIVE_FLAIR=0: 11 tools / 5,888 chars before,
 * 4 tools / 1,881 chars after (chars/4 ≈ 1.5k → 0.5k tokens).
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CODE_TOOLS, CODE_ADMIN_TOOLS } from "../src/server/tool-wrap.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TSX_CLI = path.join(REPO_ROOT, "node_modules/tsx/dist/cli.mjs");
const SERVER_ENTRY = path.join(REPO_ROOT, "src/server/index.ts");

/** Upper bound for JSON.stringify(tools) of `tools/list` under CODE_CONTEXT_TOOLSETS=code. */
const MAX_CODE_TOOLSET_CHARS = 1_900;

async function listTools(toolsets: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cca02-"));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [TSX_CLI, SERVER_ENTRY, path.join(dir, "context.db")],
    cwd: dir,
    env: { ...(process.env as Record<string, string>), CODE_CONTEXT_TOOLSETS: toolsets, OVERDRIVE_FLAIR: "0" },
    stderr: "ignore",
  });
  const client = new Client({ name: "cca02-test", version: "0.0.0" });
  await client.connect(transport);
  try {
    return (await client.listTools()).tools;
  } finally {
    await client.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe("code toolset over MCP stdio", () => {
  it("lists exactly the four reading tools, within the size budget", async () => {
    const tools = await listTools("code");
    expect(tools.map((t) => t.name).sort()).toEqual([...CODE_TOOLS].sort());
    expect(JSON.stringify(tools).length).toBeLessThanOrEqual(MAX_CODE_TOOLSET_CHARS);
    for (const t of tools) expect(t.description ?? "").not.toMatch(/checked against the disk/);
  }, 30_000);

  it("code,code-admin adds the maintenance tools back", async () => {
    const names = (await listTools("code,code-admin")).map((t) => t.name).sort();
    expect(names).toEqual([...CODE_TOOLS, ...CODE_ADMIN_TOOLS].sort());
  }, 30_000);
});
