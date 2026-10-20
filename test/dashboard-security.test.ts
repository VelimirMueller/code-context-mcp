/**
 * Dashboard HTML security (#252).
 *
 * Two halves: (1) the legacy fallback page's `simpleMarkdown()` escapes stored
 * vision/milestone text before it adds any tags, so an agent-written
 * `<img src=x onerror=…>` renders as text, not as a script; (2) every HTML
 * response carries a `Content-Security-Policy` whose `script-src` names one
 * per-response nonce, and the inline `window.__DASHBOARD_TOKEN__` script the
 * server injects carries that same nonce.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { JSDOM } from 'jsdom';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { freePort } from './helpers/free-port.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const DASHBOARD_HTML = path.join(REPO_ROOT, 'src/dashboard/dashboard.html');
const DASHBOARD_ENTRY = path.join(REPO_ROOT, 'src/dashboard/dashboard.ts');
const TSX_CLI = path.join(REPO_ROOT, 'node_modules/tsx/dist/cli.mjs');

/** Pull a top-level `function name(...) { ... }` out of dashboard.html, braces matched. */
function extractFunction(html: string, name: string): string {
  const start = html.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`function ${name} not found in dashboard.html`);
  let depth = 0;
  let i = html.indexOf('{', start);
  for (; i < html.length; i++) {
    if (html[i] === '{') depth++;
    else if (html[i] === '}') {
      depth--;
      if (depth === 0) break;
    }
  }
  return html.slice(start, i + 1);
}

function simpleMarkdownSandbox() {
  const html = readFileSync(DASHBOARD_HTML, 'utf8');
  const w = new JSDOM('', { runScripts: 'outside-only' }).window as any;
  w.eval(extractFunction(html, 'escapeHtml'));
  w.eval(extractFunction(html, 'simpleMarkdown'));
  return w;
}

describe('dashboard legacy simpleMarkdown escapes stored text', () => {
  it('renders <img src=x onerror=…> as text, not as an element', () => {
    const w = simpleMarkdownSandbox();
    const out = w.simpleMarkdown('<img src=x onerror=alert(1)>');
    expect(out).not.toContain('<img');
    expect(out).toContain('&lt;img src=x onerror=alert(1)&gt;');
    const div = w.document.createElement('div');
    div.innerHTML = out;
    expect(div.textContent).toBe('<img src=x onerror=alert(1)>');
    expect(div.querySelector('img')).toBe(null);
  });

  it('escapes & < > " \' before any markdown tag is added', () => {
    const w = simpleMarkdownSandbox();
    const out = w.simpleMarkdown('A & B < "quoted" > \'single\'');
    expect(out).not.toContain('<strong>');
    expect(out).toContain('A &amp; B &lt; &quot;quoted&quot; &gt; &#39;single&#39;');
  });

  it('keeps markdown headings and bold working on escaped input', () => {
    const w = simpleMarkdownSandbox();
    const out = w.simpleMarkdown('## <script>\n\n**bold**');
    expect(out).toContain('<h2>&lt;script&gt;</h2>');
    expect(out).toContain('<strong>bold</strong>');
    expect(out).not.toContain('<script>');
  });
});

const TOKEN = 'test-dashboard-security-token-0123456789abcdef';
const PORT = freePort();

let proc: ChildProcess;
let tmpRoot: string;
let serverLog = '';

function request(
  method: string,
  pathname: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port: PORT, method, path: pathname, headers },
      (res) => {
        let data = '';
        res.on('data', (c) => {
          data += c;
        });
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: data }),
        );
      },
    );
    req.on('error', reject);
    req.end();
  });
}

const LOCAL_HOST = `localhost:${PORT}`;

beforeAll(async () => {
  tmpRoot = mkdtempSync(path.join(tmpdir(), 'cc-dashboard-security-'));
  proc = spawn(
    process.execPath,
    [TSX_CLI, DASHBOARD_ENTRY, path.join(tmpRoot, 'context.db'), String(PORT)],
    {
      cwd: tmpRoot,
      env: { ...process.env, CODE_CONTEXT_DASHBOARD_TOKEN: TOKEN, DASHBOARD_PORT: String(PORT) },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    },
  );
  proc.stdout?.on('data', (d) => {
    serverLog += String(d);
  });
  proc.stderr?.on('data', (d) => {
    serverLog += String(d);
  });
  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) throw new Error(`dashboard exited early:\n${serverLog}`);
    try {
      if (
        (
          await request('GET', '/api/sprints', {
            Host: LOCAL_HOST,
            Authorization: `Bearer ${TOKEN}`,
          })
        ).status === 200
      )
        return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`dashboard did not start:\n${serverLog}`);
}, 40000);

afterAll(() => {
  if (proc?.pid) {
    try {
      process.kill(-proc.pid, 'SIGKILL');
    } catch {
      /* group already gone */
    }
  }
  if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
});

describe('dashboard HTML responses send a CSP with a matching nonce', () => {
  it('GET / carries the CSP header, and the inline token script carries its nonce', async () => {
    const res = await request('GET', '/', { Host: LOCAL_HOST });
    expect(res.status).toBe(200);
    const csp = res.headers['content-security-policy'];
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("base-uri 'self'");
    const m = /script-src 'self' 'nonce-([^']+)'/.exec(String(csp));
    expect(m).toBeTruthy();
    const nonce = m![1];
    expect(res.body).toContain(`<script nonce="${nonce}">window.__DASHBOARD_TOKEN__=`);
  });

  it('sends nosniff and no-referrer on the HTML response', async () => {
    const res = await request('GET', '/', { Host: LOCAL_HOST });
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
  });

  it('leaves the JSON API without a CSP header', async () => {
    const res = await request('GET', '/health', { Host: LOCAL_HOST });
    expect(res.status).toBe(200);
    expect(res.headers['content-security-policy']).toBeUndefined();
  });
});

describe('fallback page has no inline event handlers (#252)', () => {
  it('uses data attributes and a delegated listener instead of onclick', () => {
    const html = readFileSync(path.join(REPO_ROOT, 'src/dashboard/dashboard.html'), 'utf-8');
    expect(html).not.toMatch(/\son(click|change|input|submit)=/);
    expect(html).toContain("document.addEventListener('click'");
  });
});
