import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createTestDb } from './helpers/db.js';
import { initScrumSchema, runMigrations } from '../src/scrum/schema.js';
import { registerScrumTools } from '../src/scrum/tools.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { z } from 'zod';
import {
  log,
  sessionLogPath,
  sanitizeMessage,
  localTimestamp,
  logToolExceptions,
  logThrottled,
  resetThrottle,
} from '../src/sessionlog.js';

type Handler = (
  args: Record<string, unknown>,
) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>;

class FakeServer {
  tools = new Map<string, Handler>();
  tool(name: string, _desc: string, _schema: unknown, handler: Handler): void {
    this.tools.set(name, handler);
  }
}

const ENV_KEYS = [
  'OVERDRIVE_SESSION_LOG',
  'OVERDRIVE_SESSION_LOG_DIR',
  'CLAUDE_CODE_SESSION_ID',
] as const;
let saved: Record<string, string | undefined>;
let dir: string;

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  // The parent dir exists; the log dir itself must be created by the helper.
  dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cc-slog-')), 'sessions');
  delete process.env.OVERDRIVE_SESSION_LOG;
  process.env.OVERDRIVE_SESSION_LOG_DIR = dir;
  process.env.CLAUDE_CODE_SESSION_ID = 'test-session';
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  fs.rmSync(path.dirname(dir), { recursive: true, force: true });
});

const readLines = (): string[] => {
  const file = path.join(dir, 'test-session.log');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf-8').split('\n').filter(Boolean);
};

describe('sessionlog format', () => {
  it('writes one TAB-separated line in the contract format', () => {
    log('INFO', 'hello world');
    const lines = readLines();
    expect(lines).toHaveLength(1);
    const fields = lines[0].split('\t');
    expect(fields).toHaveLength(5);
    expect(fields[0]).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}$/);
    expect(fields[1]).toBe('INFO');
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf-8'));
    expect(fields[2]).toBe(`code-context@${pkg.version}`);
    expect(fields[3]).toBe(`pid=${process.pid}`);
    expect(fields[4]).toBe('hello world');
  });

  it('local timestamp carries the real local offset', () => {
    const d = new Date(Date.UTC(2026, 9, 9, 8, 12, 3, 45));
    const ts = localTimestamp(d);
    expect(new Date(ts).getTime()).toBe(d.getTime());
    expect(ts).toMatch(/\.045[+-]\d{2}:\d{2}$/);
  });

  it('flattens newlines and tabs, caps at 500 characters', () => {
    expect(sanitizeMessage('a\nb\r\nc\td')).toBe('a⏎b⏎c d');
    expect(sanitizeMessage('x'.repeat(900))).toHaveLength(500);
    log('WARN', `line1\nline2\t${'y'.repeat(800)}`);
    const msg = readLines()[0].split('\t')[4];
    expect(msg.startsWith('line1⏎line2 ')).toBe(true);
    expect(msg.length).toBe(500);
  });

  it('maps an unknown level to WARN', () => {
    log('DEBUG', 'm');
    expect(readLines()[0].split('\t')[1]).toBe('WARN');
  });

  it('creates the dir 0700 and the file 0600', () => {
    log('INFO', 'perm');
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    expect(fs.statSync(path.join(dir, 'test-session.log')).mode & 0o777).toBe(0o600);
  });

  it('sanitises the session id into one path component', () => {
    process.env.CLAUDE_CODE_SESSION_ID = '../evil/id x';
    expect(sessionLogPath()).toBe(path.join(dir, '.._evil_id_x.log'));
  });

  it('falls back to _nosession-YYYY-MM-DD without a session id', () => {
    delete process.env.CLAUDE_CODE_SESSION_ID;
    expect(path.basename(sessionLogPath())).toMatch(/^_nosession-\d{4}-\d{2}-\d{2}\.log$/);
  });

  it('OVERDRIVE_SESSION_LOG=0 disables logging (read at call time)', () => {
    process.env.OVERDRIVE_SESSION_LOG = '0';
    log('INFO', 'off');
    expect(fs.existsSync(dir)).toBe(false);
    delete process.env.OVERDRIVE_SESSION_LOG;
    log('INFO', 'on');
    expect(readLines()).toHaveLength(1);
  });

  it('swallows errors (unwritable log dir)', () => {
    const blocker = path.join(path.dirname(dir), 'not-a-dir');
    fs.writeFileSync(blocker, '');
    process.env.OVERDRIVE_SESSION_LOG_DIR = path.join(blocker, 'sub');
    expect(() => log('CRITICAL', 'boom')).not.toThrow();
  });
});

describe('sessionlog refuses anything but a regular file', () => {
  const logFile = (): string => path.join(dir, 'test-session.log');

  it('does not follow a symlink planted at the log path', () => {
    fs.mkdirSync(dir, { recursive: true });
    const target = path.join(path.dirname(dir), 'victim.txt');
    fs.writeFileSync(target, 'untouched\n');
    fs.symlinkSync(target, logFile());
    expect(() => log('CRITICAL', 'must not land in the target')).not.toThrow();
    expect(fs.readFileSync(target, 'utf-8')).toBe('untouched\n');
    expect(fs.lstatSync(logFile()).isSymbolicLink()).toBe(true);
  });

  it('does not create the target of a dangling symlink', () => {
    fs.mkdirSync(dir, { recursive: true });
    const target = path.join(path.dirname(dir), 'would-be-created.txt');
    fs.symlinkSync(target, logFile());
    log('INFO', 'x');
    expect(fs.existsSync(target)).toBe(false);
  });

  it('writes nothing into a directory at the log path, no throw', () => {
    fs.mkdirSync(logFile(), { recursive: true });
    expect(() => log('INFO', 'x')).not.toThrow();
    expect(fs.readdirSync(logFile())).toEqual([]);
  });

  it('writes nothing into a fifo at the log path, with or without a reader', () => {
    fs.mkdirSync(dir, { recursive: true });
    execFileSync('mkfifo', [logFile()]);
    expect(() => log('INFO', 'no reader')).not.toThrow(); // O_NONBLOCK: fails fast, no hang
    const reader = fs.openSync(logFile(), fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
    try {
      log('INFO', 'with reader'); // opens, but the handle is not a regular file
      let got = 0;
      try {
        got = fs.readSync(reader, Buffer.alloc(4096), 0, 4096, null);
      } catch {
        got = 0; // EAGAIN: nothing in the pipe
      }
      expect(got).toBe(0);
    } finally {
      fs.closeSync(reader);
    }
    expect(fs.lstatSync(logFile()).isFIFO()).toBe(true);
  });
});

describe('sessionlog integration — update_ticket', () => {
  it('a status change writes exactly one INFO line with ids only', async () => {
    const db = createTestDb();
    initScrumSchema(db);
    runMigrations(db);
    const sprintId = Number(
      db
        .prepare(
          `INSERT INTO sprints (name, goal, status) VALUES ('SPRINT-SENTINEL-9f3a', 'g', 'implementation')`,
        )
        .run().lastInsertRowid,
    );
    const sentinel = 'TICKET-SENTINEL-7c1e secret title';
    const ticketId = Number(
      db
        .prepare(
          `INSERT INTO tickets (title, description, status, sprint_id) VALUES (?, 'DESC-SENTINEL-55b2', 'TODO', ?)`,
        )
        .run(sentinel, sprintId).lastInsertRowid,
    );
    const server = new FakeServer();
    registerScrumTools(server as never, db);

    const res = await server.tools.get('update_ticket')!({
      ticket_id: ticketId,
      status: 'IN_PROGRESS',
    });
    expect(res.isError).toBeFalsy();

    const lines = readLines();
    expect(lines).toHaveLength(1);
    const [, level, , , msg] = lines[0].split('\t');
    expect(level).toBe('INFO');
    expect(msg).toBe(`update_ticket: ticket=${ticketId} status TODO→IN_PROGRESS`);
    const raw = fs.readFileSync(path.join(dir, 'test-session.log'), 'utf-8');
    expect(raw).not.toContain('SENTINEL');
  });
});

describe('logToolExceptions — real McpServer through the SDK', () => {
  async function connect(patchTimes: number) {
    const server = new McpServer({ name: 't', version: '0' });
    for (let i = 0; i < patchTimes; i++) logToolExceptions(server);
    let seenThis: unknown;
    let seenExtra: unknown;
    server.tool('boom', 'throws', { id: z.number() }, async () => {
      throw Object.assign(new TypeError('SECRET-VALUE-in-message'), { code: 'E_X' });
    });
    server.tool('sync_boom', 'throws synchronously', {}, () => {
      throw new RangeError('SECRET-sync');
    });
    server.tool(
      'echo',
      'echoes',
      { id: z.number() },
      async function (this: unknown, { id }, extra) {
        // eslint-disable-next-line @typescript-eslint/no-this-alias -- the test checks the wrapper keeps `this`
        seenThis = this;
        seenExtra = extra;
        return { content: [{ type: 'text' as const, text: `id=${id}` }] };
      },
    );
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'c', version: '0' });
    await Promise.all([server.connect(st), client.connect(ct)]);
    return { server, client, seen: () => ({ seenThis, seenExtra }) };
  }

  it('keeps the zod schema enforced, passes args/extra through, logs one CRITICAL per throw', async () => {
    const { client, seen } = await connect(1);

    // (a) schema still enforced: invalid args never reach the handler
    const bad = (await client.callTool({ name: 'echo', arguments: { id: 'not-a-number' } })) as {
      isError?: boolean;
    };
    expect(bad.isError).toBe(true);
    // valid call goes through with the SDK's extra argument intact
    const ok = (await client.callTool({ name: 'echo', arguments: { id: 7 } })) as {
      content: Array<{ text: string }>;
    };
    expect(ok.content[0].text).toBe('id=7');
    expect(seen().seenExtra).toBeTypeOf('object');
    expect(readLines()).toHaveLength(0);

    // (b) a throwing handler yields exactly one CRITICAL line, class only
    const res = (await client.callTool({ name: 'boom', arguments: { id: 1 } })) as {
      isError?: boolean;
    };
    expect(res.isError).toBe(true);
    let lines = readLines();
    expect(lines).toHaveLength(1);
    const [, level, , , msg] = lines[0].split('\t');
    expect(level).toBe('CRITICAL');
    expect(msg).toBe('tool boom: unhandled exception error=TypeError(E_X)');

    // synchronous throws are caught too
    await client.callTool({ name: 'sync_boom', arguments: {} });
    lines = readLines();
    expect(lines).toHaveLength(2);
    expect(lines[1].split('\t')[4]).toBe('tool sync_boom: unhandled exception error=RangeError');
    expect(lines.join('\n')).not.toContain('SECRET');
  });

  it('(c) double-patching is a no-op — still exactly one line per throw', async () => {
    const { client } = await connect(2);
    await client.callTool({ name: 'boom', arguments: { id: 1 } });
    expect(readLines()).toHaveLength(1);
  });

  it('preserves this and handler arity', () => {
    const calls: unknown[] = [];
    const fake = {
      tool(this: unknown, ...args: unknown[]) {
        calls.push({ self: this, args });
      },
    };
    logToolExceptions(fake);
    const handler = function (this: unknown, _a: unknown, _b: unknown) {
      return this;
    };
    fake.tool('t', {}, handler);
    const { self, args } = calls[0] as { self: unknown; args: unknown[] };
    expect(self).toBe(fake);
    const wrapped = args[2] as (...a: unknown[]) => unknown;
    expect(wrapped.length).toBe(2);
    const ctx = { marker: 1 };
    expect(wrapped.call(ctx, 1, 2)).toBe(ctx);
    // non-handler shapes pass through untouched
    fake.tool('x');
    expect((calls[1] as { args: unknown[] }).args).toEqual(['x']);
  });
});

describe('logThrottled', () => {
  beforeEach(() => resetThrottle());

  it('one line per key per window, then reports the suppressed count', () => {
    const t0 = 1_000_000;
    logThrottled('401 /api/x', 'WARN', 'rejected', 60_000, t0);
    for (let i = 1; i <= 5; i++) logThrottled('401 /api/x', 'WARN', 'rejected', 60_000, t0 + i);
    logThrottled('403 /api/x', 'WARN', 'other key', 60_000, t0 + 10);
    expect(readLines()).toHaveLength(2);
    logThrottled('401 /api/x', 'WARN', 'rejected', 60_000, t0 + 60_000);
    const lines = readLines();
    expect(lines).toHaveLength(3);
    expect(lines[2].split('\t')[4]).toBe('rejected suppressed=5');
  });

  it('bounds the key table so varying keys cannot flood the log', () => {
    const t0 = 2_000_000;
    for (let i = 0; i < 1000; i++) logThrottled(`401 /p${i}`, 'WARN', 'rejected', 60_000, t0);
    expect(readLines().length).toBeLessThanOrEqual(257);
  });
});
