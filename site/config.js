// Single place that defines where benchmark data lives, how run kinds are
// labelled, and the legacy (pre-ccc-bench) rules the site still honours.
//
// Data layout on the bench-results branch (the Pages workflow copies it to site/data/):
//   data/latest.json          full run JSON of the newest run across ALL kinds
//   data/index.json           ccc-bench-index/1, newest first (jq fallback: full run objects, oldest first)
//   data/runs/<run_id>.json   one file per run, common envelope schema ccc-bench/1
// Legacy run files (schema overdrive-bench/2) are read-only and mapped to kind agent-claude.
window.BENCH_CONFIG = {
  DATA_DIR: 'data/',
  LATEST: 'data/latest.json',
  INDEX: 'data/index.json',
  RUNS_DIR: 'data/runs/',
  SCHEMA: 'ccc-bench/1',
  LEGACY_SCHEMA: 'overdrive-bench/2',
  KINDS: {
    simulated: { label: 'SIMULATED', blurb: 'context efficiency, no model' },
    'agent-glm': {
      label: 'AGENT GLM',
      blurb: 'real model, same agent with vs without code-context',
    },
    'agent-deepseek': {
      label: 'AGENT DEEPSEEK',
      blurb: 'real model, same agent with vs without code-context',
    },
    'agent-opus': {
      label: 'AGENT OPUS',
      blurb: 'Claude Code (Opus), same agent with vs without code-context',
    },
    'agent-claude': {
      label: 'AGENT CLAUDE',
      blurb: 'real Claude Code sessions under pre-registration v1/v2',
    },
  },
  PREREG_VERSIONS: ['v1', 'v2'], // versions this page knows
  PREREG_CURRENT: 'v2', // the version the Method section presents
  MIN_TREATMENT_RATE: 0.8, // prereg v2: a run is VALID only if >= 80 % of cc sessions received the treatment
  // Runs whose treatment failure is documented in the prereg v2 change log but not recorded in the run row.
  KNOWN_TREATMENT_FAILURES: {
    '20261009-101417': '0 of 12 cc sessions called code-context, per the prereg v2 change log',
  },
  REPO: 'https://github.com/VelimirMueller/code-context-mcp',
  // Flagship brand tokens for the SVG charts. The full set lives in style.css
  // (page/text/line/grid/green per theme); these are the ones JS draws with.
  BRAND: {
    accent: '#6366f1', // accent fill
    accentTextDark: '#818cf8', // accent text on dark
    accentTextLight: '#4f46e5', // accent text on light
    greenDark: '#10b981',
    greenLight: '#047857',
    faint: '#71717a',
    line: '#26262b',
  },
};
