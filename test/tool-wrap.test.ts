import { describe, it, expect, afterEach } from 'vitest';
import {
  resolveToolsets,
  toolsetOf,
  toolFilter,
  PROFILES,
  TOOLSETS,
  DEFAULT_PROFILE,
  CODE_TOOLS,
  CODE_ADMIN_TOOLS,
  instrumentTools,
  decorate,
  flairHeader,
  flairFooter,
  looksLikeJson,
  OPTIONAL_TOOLSETS,
  flairEnabled,
  showTimestamps,
  serverInstructions,
  MAX_INSTRUCTIONS_CHARS,
} from '../src/server/tool-wrap.js';

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

/** The selection for a profile env and a toolsets env, as the server reads them. */
const sel = (profile?: string, toolsets?: string) => resolveToolsets(profile, toolsets);

const savedToolsets = process.env.CODE_CONTEXT_TOOLSETS;
const savedProfile = process.env.CODE_CONTEXT_PROFILE;
afterEach(() => {
  process.env.OVERDRIVE_FLAIR = '0';
  if (savedToolsets === undefined) delete process.env.CODE_CONTEXT_TOOLSETS;
  else process.env.CODE_CONTEXT_TOOLSETS = savedToolsets;
  if (savedProfile === undefined) delete process.env.CODE_CONTEXT_PROFILE;
  else process.env.CODE_CONTEXT_PROFILE = savedProfile;
});

describe('toolsets', () => {
  it('the optional toolsets are off in every profile but all', () => {
    for (const p of ['code', 'full']) {
      const hidden = toolFilter(sel(p));
      for (const t of [...OPTIONAL_TOOLSETS.fun, ...OPTIONAL_TOOLSETS.stream])
        expect(hidden.has(t)).toBe(true);
      expect(hidden.has('search_files')).toBe(false);
    }
    expect(toolFilter(sel('full')).has('request_user_input')).toBe(false);
    for (const t of [...OPTIONAL_TOOLSETS.fun, ...OPTIONAL_TOOLSETS.stream])
      expect(toolFilter(sel('all')).has(t)).toBe(false);
  });

  it('CODE_CONTEXT_TOOLSETS adds sets by name, or all', () => {
    expect(toolFilter(sel('full', 'fun')).has('record_mood')).toBe(false);
    expect(toolFilter(sel('full', 'fun')).has('send_claude_output')).toBe(true);
    expect(sel('full', ' +stream , fun ').toolsets).toEqual(TOOLSETS);
    expect(sel(undefined, 'all').toolsets).toEqual(TOOLSETS);
    expect(toolFilter(sel('full', 'default')).has('generate_vision_animation')).toBe(true);
  });

  it('every tool belongs to one toolset; unnamed tools are scrum', () => {
    for (const t of CODE_TOOLS) expect(toolsetOf(t)).toBe('code');
    for (const t of CODE_ADMIN_TOOLS) expect(toolsetOf(t)).toBe('code-admin');
    expect(toolsetOf('record_mood')).toBe('fun');
    expect(toolsetOf('send_claude_step')).toBe('stream');
    for (const t of ['create_ticket', 'get_resume_state', 'request_user_input'])
      expect(toolsetOf(t)).toBe('scrum');
  });

  it('never registers a hidden tool', () => {
    const { server, registered } = fakeServer();
    instrumentTools(server, toolFilter(sel('full')));
    (server as any).tool('record_mood', 'd', {}, () => ({ content: [] }));
    (server as any).tool('search_files', 'd', {}, () => ({ content: [] }));
    expect([...registered.keys()]).toEqual(['search_files']);
  });
});

describe('flair', () => {
  it('header and footer follow FLAIR.md and fit 72 chars', () => {
    expect(flairHeader('search_files')).toBe('● code-context ▸ search_files ░▒▓');
    expect(flairFooter(79, false)).toMatch(/^\S.* 79 ms$/);
    expect(flairFooter(79, true)).toMatch(/^(\(╯°□°\)╯︵ ┻━┻|ಠ_ಠ) 79 ms$/);
    expect(flairHeader('x'.repeat(100)).length).toBeLessThanOrEqual(72);
  });

  it('decorates text responses with one header and one footer', () => {
    process.env.OVERDRIVE_FLAIR = '1';
    const out = decorate({ content: [{ type: 'text', text: 'body' }] }, 'search_files', 12) as any;
    const lines = out.content[0].text.split('\n');
    expect(lines[0]).toBe('● code-context ▸ search_files ░▒▓');
    expect(lines[1]).toBe('body');
    expect(lines[2]).toMatch(/ 12 ms$/);
    expect(lines).toHaveLength(3);
  });

  it('leaves JSON responses alone', () => {
    process.env.OVERDRIVE_FLAIR = '1';
    const r = { content: [{ type: 'text', text: JSON.stringify({ a: 1 }, null, 2) }] };
    expect(decorate(r, 'health', 3)).toBe(r);
    expect(looksLikeJson('[1,2]')).toBe(true);
    expect(looksLikeJson('[STALE] not json')).toBe(false);
  });

  it('errors keep the text plain and first, footer uses a fail kaomoji', () => {
    process.env.OVERDRIVE_FLAIR = '1';
    const out = decorate(
      { content: [{ type: 'text', text: 'Error: boom' }], isError: true },
      'query',
      4,
    ) as any;
    expect(out.content[0].text.startsWith('Error: boom\n')).toBe(true);
    expect(out.content[0].text).not.toContain('░▒▓');
    expect(out.content[0].text).toMatch(/(┻━┻|ಠ_ಠ) 4 ms$/);
  });

  it('OVERDRIVE_FLAIR=0 turns it off (the test default: no art in non-flair tests)', () => {
    process.env.OVERDRIVE_FLAIR = '0';
    const r = { content: [{ type: 'text', text: 'body' }] };
    expect(decorate(r, 'x', 1)).toBe(r);
  });

  it('the instrumented handler times, decorates and keeps sync/async behaviour', async () => {
    process.env.OVERDRIVE_FLAIR = '1';
    const { server, registered } = fakeServer();
    instrumentTools(server, new Set());
    (server as any).tool('a', 'd', {}, async () => ({
      content: [{ type: 'text', text: 'async' }],
    }));
    (server as any).tool('b', 'd', {}, () => ({ content: [{ type: 'text', text: 'sync' }] }));
    const a = (await registered.get('a')!({})) as any;
    expect(a.content[0].text).toMatch(/^● code-context ▸ a ░▒▓\nasync\n.+ \d+ ms$/);
    const b = registered.get('b')!({}) as any;
    expect(typeof b.then).toBe('undefined');
    expect(b.content[0].text).toContain('▸ b ░▒▓');
  });

  it('instrumentTools is idempotent', () => {
    process.env.OVERDRIVE_FLAIR = '1';
    const { server, registered } = fakeServer();
    instrumentTools(server, new Set());
    instrumentTools(server, new Set());
    (server as any).tool('a', 'd', {}, () => ({ content: [{ type: 'text', text: 'x' }] }));
    const out = registered.get('a')!({}) as any;
    expect(out.content[0].text.match(/░▒▓/g)).toHaveLength(1);
  });
});

describe('profiles — code is the default (#178, 3.0.0)', () => {
  it('no env selects the code profile and only the code toolset', () => {
    expect(DEFAULT_PROFILE).toBe('code');
    expect(sel()).toEqual({ profile: 'code', toolsets: ['code'], ignored: [] });
    expect(sel('', '')).toEqual(sel());
    const f = toolFilter(sel());
    for (const t of CODE_TOOLS) expect(f.has(t)).toBe(false);
    for (const t of [...CODE_ADMIN_TOOLS, 'create_ticket', 'plan_sprint', 'get_resume_state'])
      expect(f.has(t)).toBe(true);
  });
  it('full is the 2.x default: code, code-admin and scrum', () => {
    expect(sel('full').toolsets).toEqual(['code', 'code-admin', 'scrum']);
    expect(sel(' FULL ').profile).toBe('full');
    const f = toolFilter(sel('full'));
    for (const t of [...CODE_TOOLS, ...CODE_ADMIN_TOOLS, 'create_ticket', 'get_resume_state'])
      expect(f.has(t)).toBe(false);
    expect(f.has('record_mood')).toBe(true);
  });
  it('all lists every toolset', () => {
    expect(sel('all').toolsets).toEqual(TOOLSETS);
    expect(PROFILES.all).toEqual(TOOLSETS);
  });
  it('a second entry point can pick its own default profile (#179)', () => {
    expect(resolveToolsets(undefined, undefined, 'full').profile).toBe('full');
    expect(resolveToolsets('code', undefined, 'full').profile).toBe('code');
  });
  it('reads process.env by default', () => {
    process.env.CODE_CONTEXT_PROFILE = 'full';
    delete process.env.CODE_CONTEXT_TOOLSETS;
    expect(resolveToolsets().toolsets).toContain('scrum');
    delete process.env.CODE_CONTEXT_PROFILE;
    expect(resolveToolsets().toolsets).toEqual(['code']);
  });
  it('unknown values fall back and are reported, never widen the list', () => {
    const s = sel('everything', 'scrumm,code-admin');
    expect(s.profile).toBe('code');
    expect(s.toolsets).toEqual(['code', 'code-admin']);
    expect(s.ignored).toEqual(['CODE_CONTEXT_PROFILE=everything', 'CODE_CONTEXT_TOOLSETS:scrumm']);
  });
});

describe('toolFilter — per-toolset selection', () => {
  it('code keeps exactly the code tools', () => {
    const f = toolFilter(sel(undefined, 'code'));
    for (const t of CODE_TOOLS) expect(f.has(t)).toBe(false);
    for (const t of ['create_ticket', 'plan_sprint', 'record_mood', 'send_claude_output'])
      expect(f.has(t)).toBe(true);
  });
  it('code is the reading tools; maintenance tools need code-admin', () => {
    expect([...CODE_TOOLS].sort()).toEqual([
      'exports_in',
      'find_symbol',
      'get_file_context',
      'query',
      'search_files',
      'who_imports',
    ]);
    const f = toolFilter(sel('code'));
    for (const t of CODE_ADMIN_TOOLS) expect(f.has(t)).toBe(true);
    const admin = toolFilter(sel(undefined, 'code, +code-admin'));
    for (const t of [...CODE_TOOLS, ...CODE_ADMIN_TOOLS]) expect(admin.has(t)).toBe(false);
    expect(admin.has('create_ticket')).toBe(true);
  });
  it('scrum alone adds the sprint tools without the maintenance tools', () => {
    const f = toolFilter(sel(undefined, 'scrum'));
    expect(f.has('create_ticket')).toBe(false);
    expect(f.has('index_directory')).toBe(true);
  });
  it('the full and all profiles keep the maintenance tools', () => {
    for (const s of [sel('full'), sel('all'), sel(undefined, 'all'), sel('code', 'code,all')]) {
      for (const t of CODE_ADMIN_TOOLS) expect(toolFilter(s).has(t)).toBe(false);
    }
  });
  it('the toolsets list only adds: code never narrows a wider profile', () => {
    expect(toolFilter(sel(undefined, 'code,all')).has('create_ticket')).toBe(false);
    expect(toolFilter(sel('full', 'code')).has('create_ticket')).toBe(false);
  });
  it('instrumentTools registers only code tools under the code profile', () => {
    const registered: string[] = [];
    const server = {
      tool: (name: string) => {
        registered.push(name);
        return {};
      },
    };
    instrumentTools(server, toolFilter(sel()));
    for (const n of ['find_symbol', 'create_ticket', 'get_file_context', 'log_decision']) {
      (server.tool as (...a: unknown[]) => unknown)(n, 'd', {}, async () => ({}));
    }
    expect(registered).toEqual(['find_symbol', 'get_file_context']);
  });
});

describe('flair default per profile (CCA-06, #121; #178)', () => {
  it('full and all: on unless OVERDRIVE_FLAIR=0', () => {
    expect(flairEnabled('', sel('full'))).toBe(true);
    expect(flairEnabled('', sel('full', 'fun,stream'))).toBe(true);
    expect(flairEnabled('0', sel('full'))).toBe(false);
    expect(flairEnabled('', sel(undefined, 'code,all'))).toBe(true);
  });
  it('code (the default): off unless OVERDRIVE_FLAIR=1', () => {
    expect(flairEnabled('', sel())).toBe(false);
    expect(flairEnabled('', sel(undefined, 'code'))).toBe(false);
    expect(flairEnabled('', sel(undefined, 'code,code-admin'))).toBe(false);
    expect(flairEnabled('1', sel())).toBe(true);
    expect(flairEnabled('yes', sel())).toBe(true);
    expect(flairEnabled('0', sel())).toBe(false);
  });
  it('follows the scrum toolset, not the profile name', () => {
    expect(flairEnabled('', sel('code', 'scrum'))).toBe(true);
    expect(flairEnabled('', sel('code', 'code-admin'))).toBe(false);
  });
  it('decorate follows the profile: no art under code, art with OVERDRIVE_FLAIR=1', () => {
    delete process.env.CODE_CONTEXT_PROFILE;
    process.env.CODE_CONTEXT_TOOLSETS = 'code';
    delete process.env.OVERDRIVE_FLAIR;
    const r = { content: [{ type: 'text', text: 'body' }] };
    expect(decorate(r, 'find_symbol', 5)).toBe(r);
    process.env.OVERDRIVE_FLAIR = '1';
    expect((decorate(r, 'find_symbol', 5) as any).content[0].text).toMatch(
      /^● code-context ▸ find_symbol ░▒▓\nbody\n.+ 5 ms$/,
    );
  });
});

describe('timestamps switch (CCA-06, #121)', () => {
  it('off unless CODE_CONTEXT_TIMESTAMPS is truthy', () => {
    expect(showTimestamps('')).toBe(false);
    expect(showTimestamps('')).toBe(false);
    expect(showTimestamps('0')).toBe(false);
    expect(showTimestamps('1')).toBe(true);
    expect(showTimestamps('TRUE')).toBe(true);
  });
});

describe('server instructions (CCA-06, #121)', () => {
  it('are short and plain, and route the graph questions', () => {
    const text = serverInstructions(toolFilter(sel()), false)!;
    expect(text.length).toBeLessThanOrEqual(MAX_INSTRUCTIONS_CHARS);
    expect(Math.ceil(text.length / 4)).toBeLessThanOrEqual(100); // ~80-95 tokens
    for (const t of [
      'who_imports',
      'find_symbol',
      'get_file_context',
      'exports_in',
      'snippet:true',
      'grep',
      'project-relative',
    ]) {
      expect(text).toContain(t);
    }
    expect(text).toMatch(/never hold full code/);
    expect(text).not.toMatch(/[░▒▓●]|\n/);
  });
  it('every profile lists the same code tools, so the same text; no sprint tool is named', () => {
    const lean = serverInstructions(toolFilter(sel()), false)!;
    for (const p of ['full', 'all']) {
      expect(serverInstructions(toolFilter(sel(p)), false)).toBe(lean);
    }
    expect(lean).not.toMatch(/ticket|sprint|kickoff|index_directory/);
  });
  it('name only listed tools; nothing when no code tool is listed', () => {
    const noGraph = serverInstructions(
      { has: (n: string) => n === 'who_imports' || n === 'exports_in' },
      false,
    )!;
    expect(noGraph).not.toContain('who_imports');
    expect(noGraph).not.toContain('exports_in');
    expect(noGraph).toContain('find_symbol');
    const noFileContext = serverInstructions(
      { has: (n: string) => n === 'get_file_context' },
      false,
    )!;
    expect(noFileContext).not.toContain('get_file_context');
    expect(noFileContext).not.toContain('snippet');
    expect(serverInstructions({ has: () => true }, false)).toBeUndefined();
  });
  it('do not claim relative paths when CODE_CONTEXT_ABSOLUTE_PATHS is on', () => {
    expect(serverInstructions(toolFilter(sel()), true)).not.toContain('project-relative');
  });
});
