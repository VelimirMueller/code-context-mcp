import { describe, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const SITE = join(__dirname, '..', 'site');
const FIX = join(__dirname, 'fixtures', 'site');

const fx = (f: string): any => JSON.parse(readFileSync(join(FIX, f), 'utf8'));

interface Opts {
  latest?: any; // false = 404
  index?: any;
  runs?: Record<string, any>; // id -> run JSON (served from data/runs/)
}

function load(o: Opts) {
  const dom = new JSDOM(readFileSync(join(SITE, 'index.html'), 'utf8'), {
    url: 'http://x/',
    runScripts: 'outside-only',
  });
  const w = dom.window as any;
  const files: Record<string, any> = {};
  if (o.latest !== false) files['data/latest.json'] = o.latest;
  if (o.index !== undefined) files['data/index.json'] = o.index;
  for (const [id, run] of Object.entries(o.runs || {})) files[`data/runs/${id}.json`] = run;
  w.fetch = (u: string) => {
    const hit = Object.entries(files).find(
      ([p]) => u.endsWith(p) || u === p || u.endsWith('/' + p),
    );
    if (hit) return Promise.resolve({ ok: true, json: () => hit[1] });
    return Promise.resolve({ ok: false, status: 404 });
  };
  w.eval(readFileSync(join(SITE, 'config.js'), 'utf8'));
  w.eval(readFileSync(join(SITE, 'data.js'), 'utf8'));
  w.eval(readFileSync(join(SITE, 'app.js'), 'utf8'));
  return w as any;
}

const tick = (ms = 80) => new Promise((r) => setTimeout(r, ms));

const sim = () => fx('simulated.run.json');
const glm = () => fx('agent-glm.run.json');
const claude = () => fx('agent-claude.run.json');
const indexFixture = () => fx('index.json');

describe('site shell', () => {
  it('renders the block wordmark, <= 80 columns, full-block glyph only there', async () => {
    const w = load({
      latest: sim(),
      index: { runs: [sim()] },
      runs: { 'sim-20261010-140322': sim() },
    });
    await tick();
    const lines = w.document.getElementById('wordmark').textContent.split('\n');
    expect(lines).toHaveLength(5);
    expect(lines.every((l: string) => l.length <= 80)).toBe(true);
    expect(lines[0]).toContain('████');
    const frames = w.document.querySelectorAll('pre.frames').length;
    const bodyText = w.document.body.textContent;
    expect(bodyText.includes('█')).toBe(true);
    expect(frames).toBeGreaterThan(0);
  });
  it('fails visibly when site/data.js never loaded (no window.BenchData)', async () => {
    const dom = new JSDOM(readFileSync(join(SITE, 'index.html'), 'utf8'), {
      url: 'http://x/',
      runScripts: 'outside-only',
    });
    const w = dom.window as any;
    w.fetch = () => Promise.resolve({ ok: false, status: 404 });
    w.eval(readFileSync(join(SITE, 'config.js'), 'utf8'));
    // site/data.js deliberately NOT loaded — app.js must not crash silently.
    w.eval(readFileSync(join(SITE, 'app.js'), 'utf8'));
    await tick();
    expect(w.document.documentElement.getAttribute('data-state')).toBe('error');
    expect(w.document.body.textContent).toContain('Site data failed to load');
  });
  it('marks the demo mode banner', async () => {
    const dom = new JSDOM(readFileSync(join(SITE, 'index.html'), 'utf8'), {
      url: 'http://x/?demo',
      runScripts: 'outside-only',
    });
    const w = dom.window as any;
    w.eval(readFileSync(join(SITE, 'config.js'), 'utf8'));
    w.eval(readFileSync(join(SITE, 'data.js'), 'utf8'));
    w.eval(readFileSync(join(SITE, 'app.js'), 'utf8'));
    await tick();
    expect(w.document.getElementById('demo-banner').hidden).toBe(false);
    expect(w.document.getElementById('latest-body').textContent).toContain('TOKENS SAVED');
  });
  it('ships no hardcoded dark theme toggle state (initial state is derived)', () => {
    const html = readFileSync(join(SITE, 'index.html'), 'utf8');
    expect(html).toContain('aria-pressed="false"');
    expect(html).toContain('[ theme ]');
    expect(html).not.toContain('aria-pressed="true"');
    // the head script resolves the theme (stored or OS) before first paint
    expect(html).toMatch(/prefers-color-scheme: dark/);
  });
});

describe('headline per kind (latest.json)', () => {
  it('simulated: three box-framed numbers + stochastic stats line', async () => {
    const w = load({
      latest: sim(),
      index: { runs: [sim()] },
      runs: { 'sim-20261010-140322': sim() },
    });
    await tick();
    const t = w.document.getElementById('latest-body').textContent;
    expect(t).toContain('SIMULATED');
    expect(t).toContain('context efficiency, no model');
    for (const s of ['TOKENS SAVED', '44.9 %', 'CALLS SAVED', '27.9 %', 'MCP WIN RATE', '90.5 %'])
      expect(t).toContain(s);
    const pre = w.document.querySelector('#latest-body pre.frames');
    expect(pre).toBeTruthy();
    const lines = pre.textContent.split('\n');
    expect(lines.every((l: string) => l.length <= 80)).toBe(true);
    expect(lines.join('\n')).toMatch(/┌|─/); // box-drawing frame
    expect(t).toContain('sim-20261010-140322');
  });
  it('agent: success with vs without code-context, model, wall time', async () => {
    const w = load({
      latest: glm(),
      index: { runs: [glm()] },
      runs: { 'glm-20261010-153000': glm() },
    });
    await tick();
    const t = w.document.getElementById('latest-body').textContent;
    expect(t).toContain('AGENT GLM');
    for (const s of [
      'SUCCESS VANILLA',
      '50.0 %',
      'SUCCESS CC',
      '100.0 %',
      'TOKENS CC',
      '0.62× vanilla', // saved 38.4 % → cc uses 0.62× the vanilla tokens
    ])
      expect(t).toContain(s);
    expect(t).toContain('zai-coding-plan/glm-5.3');
    expect(t).toContain('glm-20261010-153000');
    const d = w.document.getElementById('detail-body').textContent;
    expect(d).toContain('L1');
    expect(d).toContain('yes');
    expect(d).toContain('Index build'); // arm aggregate notes the cc index
  });
  it('agent-claude (legacy): verdict + criteria, never misread as a new kind', async () => {
    const w = load({
      latest: claude(),
      index: { runs: [claude()] },
      runs: { '20261009-101417': claude() },
    });
    await tick();
    const h = w.document.getElementById('latest-body').textContent;
    expect(w.BenchLogic.normalize(claude()).kind).toBe('agent-claude');
    expect(h).toContain('AGENT CLAUDE');
    expect(h).toContain('NV');
    expect(h).toContain('INCONCLUSIVE');
    expect(h).not.toContain('TOKENS SAVED'); // no simulated framing on a Claude run
    expect(h).toContain('pre-registration v1');
    await tick();
    const d = w.document.getElementById('detail-body').textContent;
    expect(d).toContain('Accuracy (T1 hidden tests)');
    expect(d).toContain('7.2 min'); // rawfmt wall-ms formatting
    expect(d).toContain('387,918'); // thousands separators
    expect(d).toContain('treatment not received');
  });
  it('recomputes the verdict from the CI; the rule wins over the stored verdict', async () => {
    const tampered = { ...claude(), verdict: 'KEEP' };
    const w = load({
      latest: tampered,
      index: { runs: [tampered] },
      runs: { '20261009-101417': tampered },
    });
    await tick();
    const t = w.document.getElementById('latest-body').textContent;
    expect(t).toContain('INCONCLUSIVE');
    expect(t).toContain('The rule wins.');
  });
});

describe('history', () => {
  it('lists all runs newest first across mixed kinds', async () => {
    const idx = indexFixture();
    idx.runs = [idx.runs[3], idx.runs[0], idx.runs[2], idx.runs[1]]; // shuffle input
    const w = load({
      latest: glm(),
      index: idx,
      runs: {
        'sim-20261010-140322': sim(),
        'glm-20261010-153000': glm(),
        'dsk-20261009-180000': fx('agent-deepseek.run.json'),
        '20261009-101417': claude(),
      },
    });
    await tick();
    const rows = [...w.document.querySelectorAll('#history-body .runrow')];
    const ids = rows.map(
      (r: any) =>
        r.querySelector('.rk-date').textContent + '|' + r.querySelector('.kbadge').textContent,
    );
    expect(ids).toEqual([
      '2026-10-10|AGENT GLM',
      '2026-10-10|SIMULATED',
      '2026-10-09|AGENT DEEPSEEK',
      '2026-10-09|AGENT CLAUDE',
    ]);
  });
  it('history is a responsive runs grid, not a nowrap table (clipping defect)', async () => {
    const w = load({
      latest: glm(),
      index: indexFixture(),
      runs: {
        'sim-20261010-140322': sim(),
        'glm-20261010-153000': glm(),
        '20261009-101417': claude(),
      },
    });
    await tick();
    expect(w.document.querySelector('#history-body table')).toBe(null);
    const rows = [...w.document.querySelectorAll('#history-body .runrow')];
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      // every card carries kind, date, model, headline and the open link
      for (const sel of ['.rk-kind .kbadge', '.rk-date', '.rk-model', '.rk-headline', 'button'])
        expect(row.querySelector(sel)).toBeTruthy();
      // the open button text must be whole, never clipped to "ope"
      expect(row.querySelector('button').textContent).toBe('open ->');
    }
  });
  it('opens a run detail on demand from the history row', async () => {
    const w = load({
      latest: glm(),
      index: indexFixture(),
      runs: {
        'sim-20261010-140322': sim(),
        'glm-20261010-153000': glm(),
        '20261009-101417': claude(),
      },
    });
    await tick();
    const simRow = [...w.document.querySelectorAll('#history-body .runrow')].find((r: any) =>
      r.textContent.includes('SIMULATED'),
    );
    (simRow.querySelector('button') as any).click();
    await tick();
    const d = w.document.getElementById('detail-body').textContent;
    expect(d).toContain('sim-20261010-140322');
    expect(d).toContain('T01');
    expect(d).toContain('Stochastic block');
    expect(d).toContain('90.5 %');
  });
  it('a stale detail load never overwrites the newer selection (async race)', async () => {
    const claudeRun = claude();
    const simRun = sim();
    const dom = new JSDOM(readFileSync(join(SITE, 'index.html'), 'utf8'), {
      url: 'http://x/',
      runScripts: 'outside-only',
    });
    const w = dom.window as any;
    w.fetch = (u: string) => {
      if (u.includes('data/index.json'))
        return Promise.resolve({ ok: true, json: () => indexFixture() });
      // the Claude run file resolves LATE; the selection has moved on by then
      if (u.includes('20261009-101417'))
        return new Promise((res) => setTimeout(() => res({ ok: true, json: () => claudeRun }), 60));
      if (u.includes('sim-20261010-140322'))
        return Promise.resolve({ ok: true, json: () => simRun });
      return Promise.resolve({ ok: false, status: 404 });
    };
    w.eval(readFileSync(join(SITE, 'config.js'), 'utf8'));
    w.eval(readFileSync(join(SITE, 'data.js'), 'utf8'));
    w.eval(readFileSync(join(SITE, 'app.js'), 'utf8'));
    await tick();

    const rows = [...w.document.querySelectorAll('#history-body .runrow')];
    const claudeRow = rows.find((r: any) => r.textContent.includes('AGENT CLAUDE'));
    const simRow = rows.find((r: any) => r.textContent.includes('SIMULATED'));
    (claudeRow.querySelector('button') as any).click(); // slow load starts
    (simRow.querySelector('button') as any).click(); // newer selection wins
    await tick(120); // slow load resolves after the switch

    const d = w.document.getElementById('detail-body').textContent;
    expect(d).toContain('sim-20261010-140322');
    expect(d).toContain('Stochastic block');
    expect(d).not.toContain('Accuracy (T1 hidden tests)'); // stale Claude detail dropped
  });
});

describe('data states', () => {
  it('empty data shows pending states, not errors', async () => {
    const w = load({ latest: false, index: { runs: [] } });
    await tick();
    expect(w.document.getElementById('latest-body').textContent).toContain('No published run yet');
    expect(w.document.getElementById('history-body').textContent).toContain(
      'No published runs yet',
    );
    expect(w.document.getElementById('detail-body').textContent).toContain('Nothing to show');
  });
  it('latest.json fetch failure falls back to the newest index entry', async () => {
    const w = load({
      latest: false,
      index: indexFixture(),
      runs: { 'glm-20261010-153000': glm() },
    });
    await tick();
    const t = w.document.getElementById('latest-body').textContent;
    expect(t).toContain('AGENT GLM');
    expect(t).toContain('SUCCESS VANILLA');
    expect(t).toContain('50.0 %');
  });
});

describe('preserved behaviour from the previous site', () => {
  it('validity gating: unusable legacy runs never enter the trend (usable())', () => {
    const L = w0();
    const v1 = claude(); // v1, no valid flag
    expect(L.usable(v1)).toBe(false);
    expect(
      L.usable({ ...v1, prereg: { version: 'v2' }, valid: true, treatment_received_rate: 0.9 }),
    ).toBe(true);
    expect(
      L.usable({ ...v1, prereg: { version: 'v2' }, valid: true, treatment_received_rate: 0.3 }),
    ).toBe(false);
    expect(L.usable({ ...v1, prereg: { version: 'v2' }, valid: false })).toBe(false);
  });
  it('v1 runs are labelled as an earlier method, not as current results', async () => {
    const w = load({
      latest: claude(),
      index: { runs: [claude()] },
      runs: { '20261009-101417': claude() },
    });
    await tick();
    const t = w.document.getElementById('latest-body').textContent;
    expect(t).toContain('not comparable with v2');
  });
  it('rawfmt keeps time/token formatting and the legacy frames contract (<= 78 cols)', () => {
    const L = w0();
    expect(L.rawfmt(429981.33, 'wall ms per pair (T1-T4)')).toBe('7.2 min');
    expect(L.rawfmt(387918.13)).toBe('387,918');
    const lines = L.framesBlock([
      { label: 'SUCCESS WITHOUT CC', value: '50.0 %' },
      { label: 'SUCCESS WITH CC', value: '100.0 %' },
      { label: 'TOKENS SAVED', value: '38.4 %' },
    ]).map((l: any) => l.text);
    expect(lines.every((l: string) => l.length <= 78)).toBe(true);
    expect(lines.join('\n')).toContain('┌');
  });
});

describe('render defects fixed after a real render', () => {
  it('rawfmt: integers print without decimals, with thousands separators', () => {
    const L = w0();
    expect(L.rawfmt(161)).toBe('161');
    expect(L.rawfmt(49)).toBe('49');
    expect(L.rawfmt(1071)).toBe('1,071');
    expect(L.rawfmt(387918.13)).toBe('387,918'); // large counts: rounding noise only
    expect(L.rawfmt(3.5)).toBe('3.500'); // true fractions keep decimals
  });
  it('p-values compose as "p < 0.001", never "p = <0.001"', async () => {
    const w = load({ latest: sim(), index: { runs: [sim()] }, runs: {} });
    await tick();
    const t = w.document.getElementById('latest-body').textContent;
    expect(t).toContain('Wilcoxon p < 0.001');
    expect(t).not.toContain('p = <');
  });
  it('kind badge and its description are separated by a real space in textContent', async () => {
    const w = load({ latest: sim(), index: { runs: [sim()] }, runs: {} });
    await tick();
    const t = w.document.getElementById('latest-body').textContent;
    expect(t).toContain('SIMULATED context efficiency, no model');
    expect(t).not.toContain('SIMULATEDcontext');
  });
  it('headline frames: one pre per block, all four lines of equal character length', async () => {
    const w = load({ latest: sim(), index: { runs: [sim()] }, runs: {} });
    await tick();
    const pres = [...w.document.querySelectorAll('#latest-body pre.frames')];
    expect(pres.length).toBe(3); // three framed numbers, each its own box
    for (const pre of pres) {
      const lines = pre.textContent.split('\n');
      expect(lines).toHaveLength(4);
      const len = lines[0].length;
      expect(lines.every((l: string) => l.length === len)).toBe(true);
      expect(lines[0][0]).toBe('┌');
      expect(lines[3][len - 1]).toBe('┘');
    }
  });
  it('header carries no hero art (image text must never sit under the wordmark)', async () => {
    const w = load({ latest: sim(), index: { runs: [sim()] }, runs: {} });
    await tick();
    expect(w.document.querySelector('.hero-bg')).toBe(null);
    expect(w.document.querySelectorAll('header img').length).toBe(0);
    expect(w.document.body.textContent.includes('hero')).toBe(false);
  });
  it('shows the brand hero as its own block, switched by data-theme', async () => {
    const w = load({ latest: sim(), index: { runs: [sim()] }, runs: {} });
    await tick();
    const srcs = [...w.document.querySelectorAll('.hero img')].map((i: any) => [
      i.className,
      i.getAttribute('src'),
    ]);
    expect(srcs).toEqual([
      ['only-dark', 'assets/hero-v2-dark.svg'],
      ['only-light', 'assets/hero-v2-light.svg'],
    ]);
    // The site copies must not drift from the README hero.
    for (const f of ['hero-v2-dark.svg', 'hero-v2-light.svg']) {
      const repo = readFileSync(join(SITE, '..', 'assets', 'banner', f));
      expect(readFileSync(join(SITE, 'assets', f)).equals(repo)).toBe(true);
    }
  });
  it('every section has a divider image and keeps a real, hidden <h2>', async () => {
    const w = load({ latest: sim(), index: { runs: [sim()] }, runs: {} });
    await tick();
    for (const id of ['latest', 'history', 'detail', 'method']) {
      const sec = w.document.getElementById(id);
      const img = sec.querySelector('img.divider');
      expect(img.getAttribute('src')).toBe(`assets/divider-${id}-v2.svg`);
      expect(img.getAttribute('alt')).toBe('');
      expect(existsSync(join(SITE, img.getAttribute('src')))).toBe(true);
      expect(sec.querySelector('h2').classList.contains('visually-hidden')).toBe(true);
    }
  });
});

function w0() {
  return load({ latest: false, index: { runs: [] } }).BenchLogic;
}

describe('agent runs with a cc-guided arm (2026-10-11)', () => {
  it('shows the guided tiles, MCP calls and cost, and five tiles stay within 78 columns', async () => {
    const run = glm();
    run.headline = { ...run.headline, success_cc_guided_pct: 100, guided_tokens_saved_pct: -20 };
    run.aggregate = {
      ...run.aggregate,
      tokens: {
        ...run.aggregate.tokens,
        guided_saved_pct: -20,
        cc_guided: { input: 1, cache_read: 0, output: 1, total: 2 },
      },
      mcp_tool_calls: { cc: 0, cc_guided: 7 },
      cost_usd: { vanilla: null, cc: null, cc_guided: null },
    };
    const w = load({ latest: run, index: { runs: [run] }, runs: {} });
    await tick();
    const t = w.document.getElementById('latest-body').textContent;
    for (const s of [
      'SUCCESS GUIDED',
      'TOKENS GUIDED',
      '1.20× vanilla',
      'code-context calls: cc 0, guided 7',
      'guided n/a',
    ])
      expect(t).toContain(s);
    const pre = [...w.document.querySelectorAll('#latest-body pre')]
      .map((p: any) => p.textContent)
      .join('\n');
    expect(pre.split('\n').every((l: string) => l.length <= 78)).toBe(true);
  });
});
