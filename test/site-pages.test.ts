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
  extra?: Record<string, any>; // other data files by path (e.g. data/private/index.json)
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
  Object.assign(files, o.extra || {});
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
      // CCA-08: uncached tokens (input + output + cache_write), derived from the
      // sessions of this pre-CCA-08 fixture: 91,550 → 55,400 = saved 39.5 % → 0.60×
      'UNCACHED CC',
      '0.60× vanilla',
      'COST CC',
      'Uncached tokens per PASS: vanilla 91,550 · cc 27,700', // 1 vs 2 passes
    ])
      expect(t).toContain(s);
    // The all-tokens total (mostly cache reads) is not a headline tile any more.
    expect(t).not.toContain('TOKENS CC');
    expect(t).toContain('zai-coding-plan/glm-5.3');
    expect(t).toContain('glm-20261010-153000');
    const d = w.document.getElementById('detail-body').textContent;
    expect(d).toContain('L1');
    expect(d).toContain('yes');
    expect(d).toContain('Index build'); // arm aggregate notes the cc index
    expect(d).toContain('Δ uncached cc (min … max)');
    expect(d).toContain('All tokens (vanilla)'); // demoted to the detail
    expect(d).toContain('Uncached per PASS');
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
    run.headline = {
      ...run.headline,
      success_cc_guided_pct: 100,
      guided_tokens_saved_pct: -20,
      uncached_saved_pct: 39.5,
      guided_uncached_saved_pct: -20,
      cost_saved_pct: null,
      guided_cost_saved_pct: null,
      uncached_per_pass: { vanilla: 91_550, cc: 27_700, cc_guided: 30_000 },
    };
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
      'UNCACHED GUIDED',
      '1.20× vanilla',
      'COST GUIDED',
      'guided 30,000',
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

describe('honest headline with spread (CCA-08)', () => {
  it('shows the uncached spread over repeats and signed per-task deltas with min … max', async () => {
    const run = glm();
    run.headline = {
      success_vanilla_pct: 66.7,
      success_cc_pct: 93.3,
      uncached_saved_pct: 9.3,
      uncached_saved_spread: { min: -4.2, max: 28.2, repeats: 3 },
      cost_saved_pct: -2.8,
      uncached_per_pass: { vanilla: 47_056, cc: 30_495 },
      tokens_saved_pct: -25.7,
      tool_calls_saved_pct: -31.9,
    };
    run.aggregate = {
      ...run.aggregate,
      per_task: [
        {
          ...run.aggregate.per_task[0],
          delta: { cc: { pairs: 3, saved_pct: -12.5, min: -30, max: 4.1 } },
        },
      ],
    };
    const w = load({ latest: run, index: { runs: [run] }, runs: { [run.run_id]: run } });
    await tick();
    const t = w.document.getElementById('latest-body').textContent;
    expect(t).toContain('0.91× vanilla'); // uncached
    expect(t).toContain('1.03× vanilla'); // cost
    expect(t).toContain('Uncached over 3 repeats: cc 0.72–1.04× vanilla');
    expect(t).toContain('vanilla 47,056 · cc 30,495');
    const cell = [...w.document.querySelectorAll('#detail-body td')].find((td: any) =>
      td.textContent.startsWith('−12.5 %'),
    ) as any;
    expect(cell.textContent).toBe('−12.5 % [−30.0 … +4.1]');
    expect(cell.className).toBe('neg'); // red = more uncached tokens than vanilla
    const hist = w.document.getElementById('history-body').textContent;
    expect(hist).toContain('uncached cc 0.91× vanilla · cost cc 1.03× vanilla');
  });
});

describe('private suite summaries (CCA-19)', () => {
  const arm = (success: number, unc: number, cost: number | null, wall: number) => ({
    sessions: 6, success_pct: success, uncached_per_session: unc, uncached_per_pass: Math.round(unc * 1.1),
    cost_usd: cost, cost_per_pass: cost === null ? null : cost / 5, wall_mean_ms: wall,
  });
  const saved = (pct: number, cost: number | null) => ({
    uncached_saved_pct: pct, uncached_saved_spread: { min: pct - 5, max: pct + 5, repeats: 2 }, cost_saved_pct: cost,
  });
  const block = () => ({
    arms: { vanilla: arm(83.3, 2850, 0.3, 30000), cc: arm(100, 1700, 0.18, 24000), cc_guided: arm(100, 1650, 0.18, 23000) },
    saved: { cc: saved(40.4, 40), cc_guided: saved(42.1, 40) },
  });
  const summary = {
    schema: 'ccc-bench-private-summary/1',
    alias: 'Real-world suite A',
    generated: '2026-10-12',
    code_context_version: '1.9.0',
    scope: { sources: 7, files: 5321, total_mb: 48.2, tasks: 12, tasks_per_group: { 'Single-page app': 4, 'cross-repo': 3 } },
    runs: [
      {
        model: 'claude-opus-4-1', provider_kind: 'agent-opus', date: '2026-10-12', repeats: 2, ...block(),
        groups: [{ group: 'Single-page app', tasks: 4, ...block() }, { group: 'cross-repo', tasks: 3, ...block() }],
      },
    ],
  };
  const index = {
    schema: 'ccc-bench-private-index/1',
    summaries: [
      { slug: 'real-world-suite-a', alias: 'Real-world suite A', generated: '2026-10-12', file: 'private/real-world-suite-a.json' },
      // A path outside data/private/ is never fetched.
      { slug: 'evil', alias: 'Evil', generated: '2026-10-12', file: '../runs/x.json' },
    ],
  };

  it('renders one card per summary: alias, scope, arm table, per-group table, privacy caption', async () => {
    const w = load({
      latest: sim(),
      index: { runs: [sim()] },
      extra: { 'data/private/index.json': index, 'data/private/real-world-suite-a.json': summary },
    });
    await tick();
    const sec = w.document.getElementById('private');
    expect(sec.hidden).toBe(false);
    const cards = sec.querySelectorAll('.private-card');
    expect(cards).toHaveLength(1);
    const text = cards[0].textContent;
    expect(text).toContain('Real-world suite A');
    expect(text).toContain('7 sources · 5,321 files · 48.2 MB · 12 tasks');
    expect(text).toContain('Single-page app 4 · cross-repo 3');
    expect(text).toContain('claude-opus-4-1 · AGENT OPUS · 2026-10-12 · n = 2 per task and arm');
    const arms = cards[0].querySelector('table[aria-label^="Arms"]');
    const rows = [...arms.querySelectorAll('tr')].map((r: any) => r.textContent);
    expect(rows).toHaveLength(4);
    expect(rows[2]).toContain('0.60× vanilla [0.55–0.65×]');
    const groups = cards[0].querySelector('table[aria-label="Per group"]');
    expect(groups.querySelectorAll('tr')).toHaveLength(3);
    expect(sec.textContent).toContain('Task texts, code, repository names and answers are private');
    expect(text).toContain('Task texts and code are private');
  });

  it('stays hidden without data/private/', async () => {
    const w = load({ latest: sim(), index: { runs: [sim()] } });
    await tick();
    expect(w.document.getElementById('private').hidden).toBe(true);
  });

  it('ignores files that are not private summaries', async () => {
    const w = load({
      latest: sim(),
      index: { runs: [sim()] },
      extra: { 'data/private/index.json': index, 'data/private/real-world-suite-a.json': { schema: 'ccc-bench/1', alias: 'x' } },
    });
    await tick();
    expect(w.document.getElementById('private').hidden).toBe(true);
  });
});

describe('verdict (CCA-20)', () => {
  const stored = {
    code: 'BENEFICIAL',
    indicative: true,
    repeats: 1,
    arm: 'cc_guided',
    arms: {},
    sentences: [
      'Result: code-context helps when the agent gets the instruction to use it.',
      'With guidance, code-context decreases the token use by 28 %.',
      'This result is indicative only: the run has 1 repeat.',
    ],
  };

  it('renders a stored verdict on the latest card, in the detail and in the history row', async () => {
    const run = glm();
    run.headline = { ...run.headline, verdict: stored };
    const w = load({ latest: run, index: { runs: [run] }, runs: { [run.run_id]: run } });
    await tick();
    const latest = w.document.getElementById('latest-body');
    const badge = latest.querySelector('.verdict-card [data-verdict]');
    expect(badge.textContent).toBe('BENEFICIAL');
    expect(badge.className).toContain('keep'); // green status
    expect(latest.querySelector('.verdict-ind').textContent).toBe('indicative');
    const items = [...latest.querySelectorAll('ul.ste li')].map((li: any) => li.textContent);
    expect(items).toEqual(stored.sentences);
    // Verdict first in the card, before the number tiles.
    expect(latest.textContent.indexOf('Result:')).toBeLessThan(
      latest.textContent.indexOf('SUCCESS VANILLA'),
    );
    const detail = w.document.getElementById('detail-body');
    expect(detail.querySelector('.verdict-card h3').textContent).toBe('Verdict');
    expect(detail.textContent).toContain(
      'With guidance, code-context decreases the token use by 28 %.',
    );
    expect(w.document.getElementById('history-body').textContent).toContain(
      'BENEFICIAL (indicative) · ',
    );
  });

  it('computes the verdict on the fly for a published run without one', async () => {
    const run = glm();
    delete run.headline.verdict;
    run.headline = {
      ...run.headline,
      success_vanilla_pct: 80,
      success_cc_pct: 60,
      uncached_saved_pct: 30,
    };
    const w = load({ latest: run, index: { runs: [run] }, runs: { [run.run_id]: run } });
    await tick();
    const badge = w.document.querySelector('#latest-body [data-verdict]');
    expect(badge.getAttribute('data-verdict')).toBe('SUBOPTIMAL');
    expect(badge.textContent).toBe('SUBOPTIMAL');
    expect(badge.className).toContain('drop'); // red status
    expect(w.document.getElementById('latest-body').textContent).toContain(
      'The success rate decreases by more than 5 percentage points.',
    );
  });

  it('private card: run verdict block and a verdict column per group', async () => {
    const arm = (success: number, wall: number) => ({
      sessions: 6,
      success_pct: success,
      uncached_per_session: 2000,
      uncached_per_pass: 2400,
      cost_usd: null,
      cost_per_pass: null,
      wall_mean_ms: wall,
    });
    const blk = (saved: number) => ({
      arms: { vanilla: arm(80, 30000), cc: arm(80, 24000) },
      saved: {
        cc: {
          uncached_saved_pct: saved,
          uncached_saved_spread: { min: saved - 3, max: saved + 3, repeats: 3 },
          cost_saved_pct: null,
        },
      },
    });
    const summary = {
      schema: 'ccc-bench-private-summary/1',
      alias: 'Real-world suite A',
      generated: '2026-10-12',
      code_context_version: '1.9.0',
      scope: {
        sources: 2,
        files: null,
        total_mb: null,
        tasks: 4,
        tasks_per_group: { one: 2, two: 2 },
      },
      runs: [
        {
          model: 'claude-opus-4-1',
          provider_kind: 'agent-opus',
          date: '2026-10-12',
          repeats: 3,
          ...blk(20),
          // An older summary without `verdict`: computed with the same rule.
          groups: [
            { group: 'one', tasks: 2, ...blk(30) },
            { group: 'two', tasks: 2, ...blk(1) },
          ],
        },
      ],
    };
    const index = {
      schema: 'ccc-bench-private-index/1',
      summaries: [
        {
          slug: 'real-world-suite-a',
          alias: 'Real-world suite A',
          generated: '2026-10-12',
          file: 'private/real-world-suite-a.json',
        },
      ],
    };
    const w = load({
      latest: sim(),
      index: { runs: [sim()] },
      extra: { 'data/private/index.json': index, 'data/private/real-world-suite-a.json': summary },
    });
    await tick();
    const card = w.document.querySelector('.private-card');
    expect(card.querySelector('[data-verdict]').textContent).toBe('BENEFICIAL');
    expect(card.textContent).toContain('Code-context decreases the token use by 20 %.');
    const rows = [...card.querySelectorAll('table[aria-label="Per group"] tr')].map((r: any) =>
      [...r.children].map((c: any) => c.textContent),
    );
    expect(rows[0][2]).toBe('Verdict');
    expect(rows[1].slice(0, 3)).toEqual(['one', '2', 'BENEFICIAL']);
    expect(rows[2].slice(0, 3)).toEqual(['two', '2', 'NO CLEAR EFFECT']);
  });
});

describe('latest run: one plain table per model (#160)', () => {
  const pArm = (success: number, wall: number) => ({
    sessions: 9,
    success_pct: success,
    uncached_per_session: 2000,
    uncached_per_pass: 2400,
    cost_usd: null,
    cost_per_pass: null,
    wall_mean_ms: wall,
  });
  const pSaved = (pct: number, min: number, max: number, cost: number | null) => ({
    uncached_saved_pct: pct,
    uncached_saved_spread: { min, max, repeats: 3 },
    cost_saved_pct: cost,
  });
  const summary = {
    schema: 'ccc-bench-private-summary/1',
    alias: 'Real-world suite A',
    generated: '2026-10-12',
    code_context_version: '2.12.0',
    scope: { sources: 7, files: null, total_mb: null, tasks: 12, tasks_per_group: { spa: 4 } },
    runs: [
      {
        model: 'zai-coding-plan/glm-5.3',
        provider_kind: 'agent-glm',
        date: '2026-10-12',
        repeats: 3,
        arms: { vanilla: pArm(91.7, 78739), cc: pArm(83.3, 66091), cc_guided: pArm(86.1, 60332) },
        saved: { cc: pSaved(11.6, 1.9, 23.2, null), cc_guided: pSaved(25, 9.2, 34.2, null) },
        groups: [],
      },
      {
        model: 'deepseek/deepseek-v4-pro',
        provider_kind: 'agent-deepseek',
        date: '2026-10-12',
        repeats: 3,
        arms: { vanilla: pArm(90, 10000), cc: pArm(90, 12000) },
        saved: { cc: pSaved(-8, -15, 3, -3) },
        groups: [],
      },
      {
        // Same day as the public Opus run: the public run wins.
        model: 'claude-opus-5-5',
        provider_kind: 'agent-opus',
        date: '2026-10-11',
        repeats: 1,
        arms: { vanilla: pArm(50, 1000), cc: pArm(10, 1000) },
        saved: {
          cc: { uncached_saved_pct: -50, uncached_saved_spread: null, cost_saved_pct: null },
        },
        groups: [],
      },
    ],
  };
  const privIndex = {
    schema: 'ccc-bench-private-index/1',
    summaries: [
      {
        slug: 'real-world-suite-a',
        alias: 'Real-world suite A',
        generated: '2026-10-12',
        file: 'private/real-world-suite-a.json',
      },
    ],
  };
  const opus = () => {
    const r = glm();
    r.run_id = 'opus-20261011-120000';
    r.kind = 'agent-opus';
    r.model = 'claude-opus-5-5';
    r.date = '2026-10-11';
    r.ts = '2026-10-11T12:00:00Z';
    r.headline = {
      success_vanilla_pct: 75,
      success_cc_pct: 75,
      success_cc_guided_pct: 87.5,
      uncached_saved_pct: 11.2,
      guided_uncached_saved_pct: 15.4,
      uncached_saved_spread: null,
      guided_uncached_saved_spread: null,
      cost_saved_pct: 7.9,
      guided_cost_saved_pct: 13.5,
      tokens_saved_pct: -19.7,
      tool_calls_saved_pct: -5.6,
    };
    r.aggregate = {
      ...r.aggregate,
      wall_ms: { vanilla_mean: 100000, cc_mean: 90000, cc_guided_mean: 80000 },
    };
    return r;
  };
  const page = () => {
    const o = opus();
    const g = glm(); // public GLM 2026-10-10: older than the private GLM run
    return load({
      latest: o,
      index: { runs: [o, g, sim()] },
      runs: { [o.run_id]: o, [g.run_id]: g },
      extra: {
        'data/private/index.json': privIndex,
        'data/private/real-world-suite-a.json': summary,
      },
    });
  };
  const rowCells = (w: any, kind: string) =>
    [...w.document.querySelector(`#simple-body tr[data-kind="${kind}"]`).children].map(
      (c: any) => c.textContent,
    );

  it('latestPerModel: a private run only when it is newer than the public run of that model', () => {
    const w = load({ latest: false, index: { runs: [] } });
    const D = w.BenchData;
    const runs = D.sortRunsDesc([opus(), glm(), sim()]);
    const picks = D.latestPerModel(runs, [D.privateSummaryOf(summary)]);
    expect(picks.map((p: any) => [p.label, p.source, p.date])).toEqual([
      ['GLM', 'private', '2026-10-12'],
      ['Opus', 'public', '2026-10-11'],
      ['DeepSeek', 'private', '2026-10-12'],
    ]);
    expect(picks[0].suite).toBe('Real-world suite A');
    // Without summaries: the public runs only, simulated runs never.
    expect(D.latestPerModel(runs, []).map((p: any) => p.kind)).toEqual(['agent-glm', 'agent-opus']);
  });

  it('renders one row per model with plain words, chips and a dash for unknown cost', async () => {
    const w = page();
    await tick(150);
    const table = w.document.querySelector('#simple-body table.simple');
    const heads = [...table.querySelectorAll('thead th')].map((t: any) => t.textContent);
    expect(heads).toEqual(['Model', 'Result', 'Success', 'Tokens', 'Cost', 'Speed', 'Repeats']);
    expect(rowCells(w, 'agent-glm')).toEqual([
      'GLM',
      'SUBOPTIMAL',
      '92 % → 86 %',
      '25 % less',
      '—',
      '23 % faster',
      '3×',
    ]);
    expect(rowCells(w, 'agent-opus')).toEqual([
      'Opus',
      'BENEFICIAL indicative',
      '75 % → 88 %',
      '15 % less',
      '14 % less',
      '20 % faster',
      '1×', // the fixture has one session per task and arm
    ]);
    expect(rowCells(w, 'agent-deepseek')).toEqual([
      'DeepSeek',
      'NO CLEAR EFFECT',
      '90 % → 90 %',
      '8 % more',
      '3 % more',
      '20 % slower',
      '3×',
    ]);
    const chip = (kind: string) =>
      w.document.querySelector(`#simple-body tr[data-kind="${kind}"] .chip`).className;
    expect(chip('agent-glm')).toContain('drop'); // red
    expect(chip('agent-opus')).toContain('keep'); // green
    expect(chip('agent-deepseek')).toContain('inc'); // grey
    expect(table.textContent).not.toMatch(/uncached|cc-guided|×\s*vanilla|\[/i);
    const body = w.document.getElementById('simple-body').textContent;
    expect(body).toContain('2026-10-12 / 2026-10-11 · Real-world suite A / test fixture');
    expect(body).toContain('Tokens = tokens the model had to process (cache excluded).');
    const notes = [...w.document.querySelectorAll('#simple-body ul.simple-notes li')].map(
      (li: any) => li.textContent,
    );
    expect(notes[0]).toBe(
      'GLM: Code-context is suboptimal for these tasks. The success rate decreases by more than 5 percentage points.',
    );
    expect(notes[2]).toBe(
      'DeepSeek: Code-context shows no clear effect. The result is not stable across repeats.',
    );
  });

  it('keeps everything else in one "Show details" block, collapsed by default', async () => {
    const w = page();
    await tick(150);
    const det = w.document.getElementById('bench-details');
    expect(det.tagName).toBe('DETAILS');
    expect(det.open).toBe(false);
    expect(det.querySelector('summary').textContent).toBe('Show details');
    for (const id of ['latest-body', 'history', 'detail', 'private'])
      expect(det.contains(w.document.getElementById(id))).toBe(true);
    expect(det.contains(w.document.getElementById('simple-body'))).toBe(false);
    expect(det.querySelectorAll('.private-card')).toHaveLength(1);
  });

  it('shows a pending note when no agent run exists', async () => {
    const w = load({ latest: sim(), index: { runs: [sim()] } });
    await tick();
    expect(w.document.getElementById('simple-body').textContent).toContain('No agent run yet.');
  });
});

describe('latest-run table: review fixes (#160)', () => {
  const D = () => load({ latest: false, index: { runs: [] } }).BenchData;
  const arm = (success: number, wall: number) => ({ success_pct: success, wall_mean_ms: wall });
  const block = (verdict: unknown, repeats?: unknown) => ({
    kind: 'agent-glm',
    date: '2026-10-12',
    repeats,
    arms: { vanilla: arm(90, 10000), cc: arm(80, 9000) },
    saved: {
      cc: {
        uncached_saved_pct: 20,
        uncached_saved_spread: { min: 5, max: 30, repeats: 3 },
        cost_saved_pct: null,
      },
    },
    verdict,
  });
  const pick = (b: unknown) => ({
    kind: 'agent-glm',
    label: 'GLM',
    source: 'private',
    date: '2026-10-12',
    suite: 'A',
    block: b,
  });

  it('simpleRowOf reads a stored HARMFUL verdict as SUBOPTIMAL with the current text', () => {
    const legacy = {
      code: 'HARMFUL',
      indicative: false,
      repeats: 3,
      arm: 'cc',
      arms: { cc: { code: 'HARMFUL', sentences: ['x'] } },
      sentences: [
        'Result: code-context makes the result worse.',
        'The success rate decreases by more than 5 percentage points.',
      ],
    };
    const row = D().simpleRowOf(pick(block(legacy, 3)), null);
    expect(row.verdict.code).toBe('SUBOPTIMAL');
    expect(row.summary).toEqual([
      'Result: code-context is suboptimal for these tasks.',
      'The success rate decreases by more than 5 percentage points.',
    ]);
  });

  it('simpleRowOf ignores an odd stored verdict (arm vanilla) and never shows vanilla numbers', () => {
    const odd = { code: 'BENEFICIAL', indicative: false, repeats: 3, arm: 'vanilla', arms: {}, sentences: ['x'] };
    const row = D().simpleRowOf(pick(block(odd, 3)), null);
    expect(row.verdict.arm).toBe('cc'); // computed with the rule, not the stored object
    expect(row.verdict.code).toBe('SUBOPTIMAL'); // success 90 → 80
    expect([row.successVanillaPct, row.successArmPct]).toEqual([90, 80]);
  });

  it('blockVerdictInputOf falls back to 1 repeat for a missing or bad count', () => {
    const d = D();
    for (const r of [undefined, null, 0, -2, 'x']) expect(d.blockVerdictInputOf(block(null), r).repeats).toBe(1);
    expect(d.blockVerdictInputOf(block(null), 3).repeats).toBe(3);
    const row = d.simpleRowOf(pick(block(null, undefined)), null);
    expect(row.repeats).toBe(1);
    expect(row.verdict.indicative).toBe(true);
  });

  it('text and colour agree on zero: a value that rounds to 0 is "same" and neutral', () => {
    const L = load({ latest: false, index: { runs: [] } }).BenchLogic;
    for (const x of [0, 0.4, -0.4]) {
      expect(L.changeText(x, 'less', 'more')).toBe('same');
      expect(L.changeClass(x)).toBe('num');
    }
    expect(L.changeText(-0.6, 'less', 'more')).toBe('1 % more');
    expect(L.changeClass(-0.6)).toBe('num neg');
    expect(L.changeText(null, 'less', 'more')).toBe('—');
    expect(L.changeClass(null)).toBe('num na');
  });
});
