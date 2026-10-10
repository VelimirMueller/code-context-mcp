/*
 * Renders the benchmark site from static JSON. No dependencies, no network
 * except same-origin data. Three run kinds (PLAN data contract):
 *   simulated     context efficiency, no model (ccc-bench/1)
 *   agent-glm / agent-deepseek   real model, same agent with vs without code-context
 *   agent-claude  legacy overdrive-bench/2 runs, read-only, pre-registered
 *
 * latest.json is the newest run across ALL kinds (owner decision); history and
 * per-run detail keep everything, including the Claude pre-registration story.
 * The legacy verdict is recomputed from nv.lo / nv.hi; a stored verdict field
 * is only compared, never trusted.
 */
(function () {
  'use strict';
  var CFG = window.BENCH_CONFIG || {};
  var D = window.BenchData;
  var DEMO = /(^|[?&])demo(=|&|$)/.test(window.location.search);
  var NS = 'http://www.w3.org/2000/svg';
  var BRAND = CFG.BRAND || {};
  var runCache = {}; // id -> normalized full run (or null after a failed fetch)

  // ---- block-letter wordmark: the only place the full-block glyph appears ----
  var GLYPHS = {
    C: ['████', '█   ', '█   ', '█   ', '████'],
    O: ['████', '█  █', '█  █', '█  █', '████'],
    D: ['███ ', '█  █', '█  █', '█  █', '███ '],
    E: ['████', '█   ', '███ ', '█   ', '████'],
    N: ['█  █', '██ █', '█ ██', '█  █', '█  █'],
    T: ['████', ' ██ ', ' ██ ', ' ██ ', ' ██ '],
    X: ['█  █', ' ██ ', '  █ ', ' ██ ', '█  █'],
  };
  function renderWordmark() {
    var pre = document.getElementById('wordmark');
    if (!pre) return;
    var rows = ['', '', '', '', ''];
    var prev = '';
    'CODE CONTEXT'.split('').forEach(function (ch) {
      if (ch === ' ') {
        for (var i = 0; i < 5; i++) rows[i] += '   ';
        prev = ' ';
        return;
      }
      var gap = prev && prev !== ' ' ? ' ' : '';
      for (var j = 0; j < 5; j++) rows[j] += gap + GLYPHS[ch][j];
      prev = ch;
    });
    pre.textContent = rows.join('\n');
  }

  // ---- tiny DOM kit ----
  function el(tag, attrs, kids) {
    var e = document.createElement(tag);
    if (attrs)
      for (var k in attrs) {
        if (k === 'class') {
          if (attrs[k]) e.className = attrs[k];
        } else e.setAttribute(k, attrs[k]);
      }
    (kids || []).forEach(function (c) {
      e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    });
    return e;
  }
  function sv(tag, attrs, text) {
    var e = document.createElementNS(NS, tag);
    for (var k in attrs) e.setAttribute(k, attrs[k]);
    if (text != null) e.textContent = text;
    return e;
  }
  function $(id) {
    return document.getElementById(id);
  }
  function clear(n) {
    while (n && n.firstChild) n.removeChild(n.firstChild);
  }
  function isNum(x) {
    return typeof x === 'number' && isFinite(x);
  }
  function rawfmt(x, unit) {
    if (!isNum(x)) return 'n/a';
    if (/\bms\b/.test(String(unit || ''))) {
      var sec = x / 1000;
      return sec >= 60 ? (sec / 60).toFixed(1) + ' min' : sec.toFixed(1) + ' s';
    }
    // Integers (tokens, calls, counts, trials, W) print without decimals and
    // with thousands separators; large non-integers are counts with rounding
    // noise; only true fractions below 1000 keep decimals.
    if (Number.isInteger(x) || Math.abs(x) >= 1000) return Math.round(x).toLocaleString('en-US');
    return x.toFixed(3);
  }
  function fmt(x, d) {
    return isNum(x) ? x.toFixed(d == null ? 3 : d) : 'n/a';
  }
  function sgn(x, d) {
    return isNum(x)
      ? (x > 0 ? '+' : x < 0 ? '−' : '') + Math.abs(x).toFixed(d == null ? 3 : d)
      : 'n/a';
  }
  function ci(o, d) {
    return o && isNum(o.mean)
      ? sgn(o.mean, d) + ' [' + sgn(o.lo, d) + ', ' + sgn(o.hi, d) + ']'
      : 'n/a';
  }
  function pct(x) {
    return isNum(x) ? (x * 100).toFixed(1) + ' %' : 'n/a';
  }
  function pct1(x) {
    return isNum(x) ? x.toFixed(1) + ' %' : 'n/a';
  }
  function pcell(p) {
    return isNum(p) ? (p < 0.001 ? '<0.001' : p.toFixed(3)) : 'n/a';
  }
  // Composed form: "p = 0.032" / "p < 0.001" — never "p = <0.001".
  function pEq(p) {
    return isNum(p) ? (p < 0.001 ? 'p < 0.001' : 'p = ' + p.toFixed(3)) : 'p = n/a';
  }
  function bytesFmt(x) {
    if (!isNum(x)) return 'n/a';
    return x >= 1048576 ? (x / 1048576).toFixed(1) + ' MB' : (x / 1024).toFixed(0) + ' kB';
  }
  function msFmt(x) {
    if (!isNum(x)) return 'n/a';
    var s = x / 1000;
    return s >= 60
      ? Math.floor(s / 60) + ' min ' + (s % 60).toFixed(0) + ' s'
      : s.toFixed(1) + ' s';
  }

  function getJSON(url) {
    return fetch(url, { cache: 'no-cache' }).then(function (r) {
      if (!r.ok) throw new Error(url + ' ' + r.status);
      return r.json();
    });
  }

  // ---- box-drawing frames for headline numbers ----
  // Every line of a frame has the same character count (w + 2). Combined with
  // the pre.frames CSS (one mono font for bars and letters, no bold, ligatures
  // off, letter-spacing 0, line-height 1, white-space pre) the frame edges are
  // pixel-exact. framesNode renders one <pre> per block inside a wrapping flex
  // row; framesBlock (joined lines, <= 78 columns) stays as the test hook.
  function frameLines(label, value) {
    var w = Math.max(label.length, value.length);
    function pad(s) {
      var l = Math.floor((w - s.length) / 2);
      return new Array(l + 1).join(' ') + s + new Array(w - s.length - l + 1).join(' ');
    }
    var bar = new Array(w + 1).join('─');
    return ['┌' + bar + '┐', '│' + pad(label) + '│', '│' + pad(value) + '│', '└' + bar + '┘'];
  }
  function framesBlock(items) {
    var blocks = items.map(function (i) {
      return frameLines(i.label, i.value);
    });
    var lines = [];
    var width =
      blocks.reduce(function (a, b) {
        return a + b[0].length;
      }, 0) +
      2 * (blocks.length - 1);
    if (width <= 78) {
      for (var r = 0; r < 4; r++)
        lines.push({
          role: r === 1 ? 'label' : r === 2 ? 'value' : 'frame',
          text: blocks
            .map(function (b) {
              return b[r];
            })
            .join('  '),
        });
    } else {
      blocks.forEach(function (b, i) {
        if (i) lines.push({ role: 'frame', text: '' });
        for (var r2 = 0; r2 < 4; r2++)
          lines.push({ role: r2 === 1 ? 'label' : r2 === 2 ? 'value' : 'frame', text: b[r2] });
      });
    }
    return lines;
  }
  function framesNode(items) {
    var row = el('div', {
      class: 'frames-row',
      role: 'group',
      'aria-label': items
        .map(function (i) {
          return i.label + ' ' + i.value.trim();
        })
        .join(', '),
    });
    items.forEach(function (i) {
      var pre = el('pre', { class: 'frames' });
      frameLines(i.label, i.value).forEach(function (text, r) {
        if (r) pre.appendChild(document.createTextNode('\n'));
        pre.appendChild(el('span', { class: r === 1 ? 'fl' : r === 2 ? 'fv' : null }, [text]));
      });
      row.appendChild(pre);
    });
    return row;
  }

  function metaLine(run) {
    var raw = run.raw || {};
    var parts = [];
    if (run.model) parts.push('model ' + run.model);
    parts.push(run.date);
    parts.push(run.id);
    var c =
      raw.git && typeof raw.git.commit === 'string'
        ? raw.git.commit.slice(0, 7)
        : raw.fixture && typeof raw.fixture.tree_sha === 'string'
          ? raw.fixture.tree_sha.slice(0, 7)
          : null;
    if (c) parts.push('commit ' + c);
    if (raw.trigger) parts.push(raw.trigger);
    return el('p', { class: 'met' }, [parts.join('  ·  ')]);
  }

  function kindIntro(kind) {
    var m = D.kindMeta(kind) || { label: kind.toUpperCase(), blurb: '' };
    var cls = kind === 'simulated' ? 'k-sim' : kind === 'agent-claude' ? 'k-claude' : 'k-agent';
    return el('div', { class: 'kind-intro' }, [
      el('span', { class: 'kbadge ' + cls }, [m.label]),
      ' ', // real text node: "SIMULATED context efficiency…" also in textContent
      el('span', { class: 'sub' }, [m.blurb]),
    ]);
  }

  // ---- headline (latest run of any kind) ----
  function renderHeadline(run) {
    var box = $('latest-body');
    clear(box);
    if (!run) {
      box.appendChild(
        el('div', { class: 'card' }, [
          el('div', { class: 'verdict' }, [
            el('div', { class: 'badge pend' }, ['PENDING']),
            el('div', null, [
              el('div', { class: 'big' }, ['No published run yet']),
              el('div', { class: 'sub' }, [
                'Benchmarks run on demand, never on a schedule. The first published run appears here.',
              ]),
            ]),
          ]),
        ]),
      );
      return;
    }
    box.appendChild(kindIntro(run.kind));
    if (run.kind === 'simulated') headlineSimulated(run, box);
    else if (D.isAgentKind(run.kind)) headlineAgent(run, box);
    else headlineClaude(run, box);
    box.appendChild(metaLine(run));
  }

  function headlineSimulated(run, box) {
    var s = D.simulatedOf(run);
    box.appendChild(
      framesNode([
        { label: 'TOKENS SAVED', value: pct1(s.tokensSavedPct) },
        { label: 'CALLS SAVED', value: pct1(s.callsSavedPct) },
        { label: 'MCP WIN RATE', value: pct1(s.mcpWinsPct) },
      ]),
    );
    box.appendChild(
      el('p', { class: 'sub' }, [
        'Paired simulation over the repo fixture, no model in the loop. Wilcoxon ' +
          pEq(s.wilcoxonP) +
          ', effect size r = ' +
          fmt(s.effectSizeR, 2) +
          '.',
      ]),
    );
  }

  function headlineAgent(run, box) {
    var a = D.agentOf(run);
    box.appendChild(
      framesNode([
        { label: 'SUCCESS WITHOUT CC', value: pct1(a.successVanillaPct) },
        { label: 'SUCCESS WITH CC', value: pct1(a.successCcPct) },
        { label: 'TOKENS SAVED', value: pct1(a.tokensSavedPct) },
      ]),
    );
    var wall =
      a.wall && isNum(a.wall.vanilla_mean) && isNum(a.wall.cc_mean)
        ? 'Wall time ' + msFmt(a.wall.vanilla_mean) + ' → ' + msFmt(a.wall.cc_mean) + ' per task. '
        : '';
    box.appendChild(
      el('p', { class: 'sub' }, [
        wall + 'Same agent, same tasks, once without and once with the code-context MCP server.',
      ]),
    );
  }

  function headlineClaude(run, box) {
    var raw = run.raw || {};
    var L = D.legacyOf(run) || {};
    var v = L.verdict;
    var inv = D.isInvalid(raw);
    var old = L.preregVersion !== (CFG.PREREG_CURRENT || 'v2');
    var card = el('div', { class: 'card' }, [
      el('div', { class: 'verdict' }, [
        el(
          'div',
          {
            class:
              'badge ' +
              (inv && !old
                ? 'drop'
                : v === 'KEEP'
                  ? 'keep'
                  : v === 'DROP'
                    ? 'drop'
                    : v === 'INCONCLUSIVE'
                      ? 'inc'
                      : 'pend'),
          },
          [v || 'N/A'],
        ),
        el('div', null, [
          el('div', { class: 'big' }, ['NV ' + ci(L.nv)]),
          el('div', { class: 'sub' }, [
            'net value, 95 % bootstrap CI, pre-registration ' +
              L.preregVersion +
              '. KEEP needs the lower bound above 0.',
          ]),
        ]),
      ]),
      el('dl', { class: 'meta' }, metaRowsClaude(raw)),
    ]);
    if (L.storedVerdict && v && String(L.storedVerdict).toUpperCase() !== v)
      card.appendChild(
        el('div', { class: 'note' }, [
          'The data file states verdict ' +
            String(L.storedVerdict) +
            ', but the pre-registered rule applied to its CI gives ' +
            v +
            '. The rule wins.',
        ]),
      );
    if (inv && !old) {
      var t = D.treatmentRate(raw);
      card.appendChild(
        el('div', { class: 'note' }, [
          'INVALID: treatment not received' +
            (isNum(t)
              ? ' (' +
                pct(t) +
                ' of cc sessions used code-context; a valid run needs at least ' +
                Math.round((CFG.MIN_TREATMENT_RATE || 0.8) * 100) +
                ' %)'
              : '') +
            '. The run is published with its note and excluded from the verdict trend.',
        ]),
      );
    } else if (old) {
      card.appendChild(
        el('div', { class: 'note' }, [
          'Measured under pre-registration ' +
            L.preregVersion +
            '; not comparable with ' +
            (CFG.PREREG_CURRENT || 'v2') +
            ' runs.',
        ]),
      );
    } else if (L.cadence !== 'monthly') {
      card.appendChild(
        el('div', { class: 'note' }, [
          'This is a ' +
            (L.cadence || 'weekly') +
            ' run with n = ' +
            (L.n != null ? L.n : 3) +
            '. The interval is wide — read the interval, not the point. Runs start on demand; none is scheduled.',
        ]),
      );
    }
    box.appendChild(card);
    renderNotes(raw, box);
  }

  function metaRowsClaude(raw) {
    var rows = [];
    function row(k, val) {
      rows.push(el('dt', null, [k]));
      rows.push(el('dd', null, [val]));
    }
    row('Model', String(raw.model || 'unknown'));
    row('Claude Code', String(raw.claude_code_version || 'unknown'));
    row('Date', String(raw.date));
    row(
      'Run',
      String(raw.run_id || '') +
        ' ' +
        (raw.kind || 'unknown') +
        ', n = ' +
        (raw.n != null ? raw.n : '?') +
        ' per arm and task',
    );
    var pr = raw.prereg || {};
    row(
      'Pre-registration',
      String(pr.version || 'unknown') + ', SHA-256 ' + String(pr.sha256 || 'unknown'),
    );
    var t = D.treatmentRate(raw);
    row(
      'Treatment received',
      (t != null
        ? pct(t) +
          ' of cc sessions used code-context (valid needs at least ' +
          Math.round((CFG.MIN_TREATMENT_RATE || 0.8) * 100) +
          ' %)'
        : (CFG.KNOWN_TREATMENT_FAILURES || {})[raw.run_id] || 'not recorded') +
        (raw.valid === true ? '; run VALID' : raw.valid === false ? '; run INVALID' : ''),
    );
    var fx = raw.fixture || {};
    if (fx.repo_url || fx.commit_sha)
      row('Codebase', String(fx.repo_url || '') + ' @ ' + String(fx.commit_sha || ''));
    var hd = raw.hidden || {};
    row('Hidden tests SHA-256', String(hd.tests_sha256 || 'n/a'));
    row('Answer key SHA-256', String(hd.answer_key_sha256 || 'n/a'));
    return rows;
  }

  function renderNotes(raw, box) {
    var notes = Array.isArray(raw.notes)
      ? raw.notes.filter(function (n) {
          return typeof n === 'string' && n;
        })
      : [];
    if (raw.fake === true)
      notes.unshift(
        'This run is flagged as fake (harness self-test). Its numbers are not results.',
      );
    if (!notes.length) return;
    var ul = el('ul');
    notes.forEach(function (n) {
      ul.appendChild(el('li', null, [n]));
    });
    box.appendChild(
      el('div', { class: 'note run-notes' }, [
        el('strong', null, ['Run notes (' + String(raw.run_id || raw.date) + ')']),
        ul,
      ]),
    );
  }

  // ---- history (all runs, newest first) ----
  function headlineText(run) {
    var h = run.headline || {};
    if (run.kind === 'simulated')
      return (
        pct1(h.tokensSavedPct).trim() +
        ' tokens · ' +
        pct1(h.callsSavedPct).trim() +
        ' calls · ' +
        pct1(h.mcpWinsPct).trim() +
        ' wins'
      );
    if (D.isAgentKind(run.kind))
      return (
        pct1(h.success_vanilla_pct).trim() +
        ' → ' +
        pct1(h.success_cc_pct).trim() +
        ' success · ' +
        pct1(h.tokens_saved_pct).trim() +
        ' tokens'
      );
    var v =
      isNum(h.nv_lo) && h.nv_lo > 0
        ? 'KEEP'
        : isNum(h.nv_hi) && h.nv_hi < 0
          ? 'DROP'
          : isNum(h.nv_mean)
            ? 'INCONCLUSIVE'
            : null;
    var inv = run.raw && D.isInvalid(run.raw);
    return (
      (isNum(h.nv_mean)
        ? 'NV ' + sgn(h.nv_mean, 3) + ' [' + sgn(h.nv_lo, 3) + ', ' + sgn(h.nv_hi, 3) + '] · '
        : '') +
      (v || 'N/A') +
      (inv ? ' · INVALID' : '')
    );
  }

  // History rows are a CSS grid, not a <table>: the old table's nowrap columns
  // overflowed one inner scroll area (the "open" button clipped to "ope" at
  // 1280, columns off-screen at 390). Grid rows reflow: one line per run on
  // wide viewports, stacked cards below 720 px — nothing ever clips.
  function renderHistory(runs, onSelect) {
    var box = $('history-body');
    clear(box);
    if (!runs.length) {
      box.appendChild(
        el('div', { class: 'pending' }, [
          el('b', null, ['No published runs yet. ']),
          'History fills from data/index.json as runs are published.',
        ]),
      );
      return;
    }
    var head = el('div', { class: 'runs-head', 'aria-hidden': 'true' });
    ['Kind', 'Date', 'Model', 'Headline', ''].forEach(function (t) {
      head.appendChild(el('span', { class: 'rk rk-' + (t ? t.toLowerCase() : 'open') }, [t]));
    });
    var ul = el('ul', { class: 'runs' });
    runs.forEach(function (r) {
      var m = D.kindMeta(r.kind) || { label: r.kind };
      var cls =
        r.kind === 'simulated' ? 'k-sim' : r.kind === 'agent-claude' ? 'k-claude' : 'k-agent';
      var btn = el(
        'button',
        { class: 'rk rk-open rowbtn', type: 'button', 'aria-label': 'open run ' + r.id },
        ['open ->'],
      );
      btn.addEventListener('click', function () {
        onSelect(r);
      });
      ul.appendChild(
        el('li', { class: 'runrow' }, [
          el('span', { class: 'rk rk-kind' }, [el('span', { class: 'kbadge ' + cls }, [m.label])]),
          el('span', { class: 'rk rk-date' }, [r.date]),
          el('span', { class: 'rk rk-model' }, [r.model || '—']),
          el('span', { class: 'rk rk-headline' }, [headlineText(r)]),
          btn,
        ]),
      );
    });
    box.appendChild(head);
    box.appendChild(ul);
  }

  // ---- run detail ----
  // Selection generation: every renderDetail call bumps this counter. A load
  // that resolves for an older selection (the user picked another run, or the
  // initial render replaced a click) is stale and must not touch the DOM.
  var detailSeq = 0;

  function hasPayload(raw) {
    return !!(raw && (raw.deterministic || raw.arms || raw.criteria || raw.prereg));
  }
  function ensureFull(run) {
    if (!run) return Promise.resolve(null);
    if (run.id in runCache) return Promise.resolve(runCache[run.id]);
    if (hasPayload(run.raw)) {
      runCache[run.id] = run;
      return Promise.resolve(run);
    }
    return getJSON((CFG.RUNS_DIR || 'data/runs/') + run.id + '.json').then(
      function (raw) {
        var n = D.normalizeRun(raw);
        if (!n) throw new Error('unrecognized run file');
        runCache[run.id] = n;
        return n;
      },
      function () {
        runCache[run.id] = null;
        return null;
      },
    );
  }

  function renderDetail(run, allRuns) {
    var seq = ++detailSeq;
    var box = $('detail-body');
    clear(box);
    if (!run) {
      box.appendChild(
        el('div', { class: 'pending' }, [
          el('b', null, ['Nothing to show. ']),
          'Select a run in ALL RUNS, or publish the first run.',
        ]),
      );
      return;
    }
    ensureFull(run).then(function (full) {
      if (seq !== detailSeq) return; // stale load: another selection won
      clear(box);
      var f = full || run;
      box.appendChild(kindIntro(f.kind));
      var head = el('h3', null, [f.id + ' · ' + f.date + (f.model ? ' · ' + f.model : '')]);
      box.appendChild(head);
      if (!full) {
        box.appendChild(
          el('div', { class: 'note' }, [
            'Run file data/runs/' + f.id + '.json could not be loaded; showing index data only.',
          ]),
        );
      }
      if (f.kind === 'simulated') detailSimulated(f, box);
      else if (D.isAgentKind(f.kind)) detailAgent(f, box);
      else
        detailClaude(f, box, allRuns, function () {
          return seq !== detailSeq;
        });
      box.appendChild(metaLine(f));
    });
  }

  function detailSimulated(run, box) {
    var s = D.simulatedOf(run);
    var raw = run.raw || {};
    // deterministic task table
    if (s.tasks.length) {
      var tb = el('table');
      var hd = el('tr');
      [
        'Task',
        'Category',
        'Pts',
        'MCP tok',
        'Vanilla tok',
        'Tok saved',
        'MCP calls',
        'Vanilla calls',
      ].forEach(function (t) {
        hd.appendChild(el('th', null, [t]));
      });
      tb.appendChild(hd);
      s.tasks.forEach(function (t) {
        tb.appendChild(
          el('tr', null, [
            el('td', null, [String(t.id) + ' — ' + String(t.label || '')]),
            el('td', null, [String(t.category || '—')]),
            el('td', null, [String(t.points != null ? t.points : '—')]),
            el('td', null, [rawfmt(t.mcp && t.mcp.tokens)]),
            el('td', null, [rawfmt(t.vanilla && t.vanilla.tokens)]),
            el('td', { class: 'pos' }, [
              isNum(t.tokenSavingsPct) ? t.tokenSavingsPct.toFixed(1) + ' %' : 'n/a',
            ]),
            el('td', null, [rawfmt(t.mcp && t.mcp.calls)]),
            el('td', null, [rawfmt(t.vanilla && t.vanilla.calls)]),
          ]),
        );
      });
      box.appendChild(el('div', { class: 'tablewrap' }, [tb]));
    }
    if (s.summary) {
      var sm = s.summary;
      box.appendChild(
        el('p', { class: 'sub' }, [
          'Deterministic total: ' +
            rawfmt(sm.totalMcpTokens) +
            ' vs ' +
            rawfmt(sm.totalVanillaTokens) +
            ' tokens (' +
            pct1(s.tokensSavedPct).trim() +
            ' saved), ' +
            rawfmt(sm.totalMcpCalls) +
            ' vs ' +
            rawfmt(sm.totalVanillaCalls) +
            ' calls (' +
            pct1(s.callsSavedPct).trim() +
            ' saved).',
        ]),
      );
    }
    // stochastic stats block
    var st = s.stochastic;
    if (st) {
      var cfgSt = st.config || {};
      var res = st.results || {};
      var tok = st.tokens || {};
      var stats = st.statistics || {};
      var wil = stats.wilcoxon || {};
      var ci95 = tok.ci95 || {};
      var dl = el('dl', { class: 'meta' });
      function row(k, v) {
        dl.appendChild(el('dt', null, [k]));
        dl.appendChild(el('dd', null, [v]));
      }
      row('Stochastic trials', isNum(cfgSt.trials) ? String(cfgSt.trials) : 'n/a');
      row(
        'MCP win rate',
        pct1(s.mcpWinsPct).trim() +
          (isNum(res.mcpWins) ? ' (' + res.mcpWins + ' of ' + cfgSt.trials + ' trials)' : ''),
      );
      row('Token savings, mean', isNum(tok.savingsPct) ? tok.savingsPct.toFixed(1) + ' %' : 'n/a');
      row(
        'Token savings, 95 % CI',
        isNum(ci95.lower)
          ? '[' + ci95.lower.toFixed(1) + ' %, ' + (ci95.upper || 0).toFixed(1) + ' %]'
          : 'n/a',
      );
      row(
        'Wilcoxon signed-rank',
        'W = ' +
          rawfmt(wil.W) +
          ', z = ' +
          fmt(wil.z, 2) +
          ', ' +
          pEq(isNum(s.wilcoxonP) ? s.wilcoxonP : wil.p),
      );
      row(
        'Effect size',
        isNum(s.effectSizeR)
          ? 'r = ' +
              fmt(s.effectSizeR, 3) +
              (stats.effectLabel ? ' (' + stats.effectLabel + ')' : '')
          : 'n/a',
      );
      box.appendChild(el('div', { class: 'card' }, [el('h3', null, ['Stochastic block']), dl]));
      var bt = st.byTemplate;
      if (bt && Object.keys(bt).length) {
        var tb2 = el('table');
        var hd2 = el('tr');
        ['Template', 'Trials', 'MCP tok μ', 'Vanilla tok μ', 'Saved'].forEach(function (t) {
          hd2.appendChild(el('th', null, [t]));
        });
        tb2.appendChild(hd2);
        Object.keys(bt).forEach(function (k) {
          var b = bt[k] || {};
          tb2.appendChild(
            el('tr', null, [
              el('td', null, [k]),
              el('td', null, [String(b.count != null ? b.count : '—')]),
              el('td', null, [rawfmt(b.mcpMean)]),
              el('td', null, [rawfmt(b.vanillaMean)]),
              el('td', { class: 'pos' }, [
                isNum(b.savingsPct) ? b.savingsPct.toFixed(1) + ' %' : 'n/a',
              ]),
            ]),
          );
        });
        box.appendChild(el('div', { class: 'tablewrap' }, [tb2]));
      }
    }
    renderNotes(raw, box);
  }

  function detailAgent(run, box) {
    var a = D.agentOf(run);
    var raw = run.raw || {};
    var rows = a.perTask.length ? a.perTask : [];
    if (rows.length) {
      var tb = el('table');
      var hd = el('tr');
      [
        'Task',
        'OK vanilla',
        'OK cc',
        'Tok in van',
        'Tok out van',
        'Tok in cc',
        'Tok out cc',
        'Calls van',
        'Calls cc',
        'MCP calls',
        'Wall van',
        'Wall cc',
      ].forEach(function (t) {
        hd.appendChild(el('th', null, [t]));
      });
      tb.appendChild(hd);
      rows.forEach(function (p) {
        var v = p.vanilla || {};
        var c = p.cc || {};
        function tf(o, k) {
          return o && o.tokens && isNum(o.tokens[k]) ? rawfmt(o.tokens[k]) : 'n/a';
        }
        tb.appendChild(
          el('tr', null, [
            el('td', null, [String(p.task_id)]),
            el('td', { class: v.success === true ? 'pos' : 'neg' }, [
              v.success === true ? 'yes' : v.success === false ? 'no' : 'n/a',
            ]),
            el('td', { class: c.success === true ? 'pos' : 'neg' }, [
              c.success === true ? 'yes' : c.success === false ? 'no' : 'n/a',
            ]),
            el('td', null, [tf(v, 'input')]),
            el('td', null, [tf(v, 'output')]),
            el('td', null, [tf(c, 'input')]),
            el('td', null, [tf(c, 'output')]),
            el('td', null, [rawfmt(v.tool_calls)]),
            el('td', null, [rawfmt(c.tool_calls)]),
            el('td', null, [rawfmt(c.mcp_tool_calls)]),
            el('td', null, [msFmt(v.wall_ms)]),
            el('td', null, [msFmt(c.wall_ms)]),
          ]),
        );
      });
      box.appendChild(el('div', { class: 'tablewrap' }, [tb]));
    }
    // arm aggregates
    var dl = el('dl', { class: 'meta' });
    function row(k, v) {
      dl.appendChild(el('dt', null, [k]));
      dl.appendChild(el('dd', null, [v]));
    }
    // cache_read is shown when the run has it (runs since 2026-10-11 count it
    // in total); older runs keep input + output = total.
    function tokLine(t) {
      var cached = isNum(t.cache_read) ? ' + ' + rawfmt(t.cache_read) + ' cached' : '';
      return (
        rawfmt(t.input) +
        ' in' +
        cached +
        ' / ' +
        rawfmt(t.output) +
        ' out / ' +
        rawfmt(t.total) +
        ' total'
      );
    }
    var tk = a.tokens || {};
    var tv = tk.vanilla || {};
    var tc = tk.cc || {};
    var cl = a.toolCalls || {};
    row('Tokens (vanilla)', tokLine(tv));
    row('Tokens (cc)', tokLine(tc));
    row('Tokens saved', pct1(a.tokensSavedPct).trim());
    row(
      'Tool calls',
      rawfmt(cl.vanilla) +
        ' vanilla vs ' +
        rawfmt(cl.cc) +
        ' cc (' +
        pct1(a.toolCallsSavedPct).trim() +
        ' saved)',
    );
    if (a.wall)
      row(
        'Wall time per task',
        msFmt(a.wall.vanilla_mean) + ' vanilla vs ' + msFmt(a.wall.cc_mean) + ' cc',
      );
    if (a.indexMs != null)
      row('Index build', msFmt(a.indexMs) + ' (' + bytesFmt(a.dbBytes) + ' db)');
    if (a.agentCli) row('Agent CLI', a.agentCli.name + ' ' + (a.agentCli.version || ''));
    if (a.keyEnv) row('Auth', a.keyEnv + ' (name only, value never recorded)');
    box.appendChild(el('div', { class: 'card' }, [el('h3', null, ['Arms']), dl]));
    box.appendChild(
      el('div', { class: 'note' }, [
        'n = ' +
          (isNum(raw.n) ? raw.n : rows.length ? 1 : '?') +
          ' repeat per arm and task against ' +
          String(a.fixture || 'the fixture') +
          '. Wall time and tokens vary with provider load; single-repeat runs are indicative, not statistical.',
      ]),
    );
    renderNotes(raw, box);
  }

  // ---- legacy (agent-claude) detail: ported from the previous site ----
  var CRIT = [
    ['accuracy', 'Accuracy (T1 hidden tests)', 'q', 0.3],
    ['code_quality', 'Code quality (T1)', 'q', 0.2],
    ['systems', 'Systems knowledge (T2)', 'q', 0.15],
    ['stakeholder', 'Stakeholder communication (T3)', 'q', 0.1],
    ['control', 'Control / steerability (T4)', 'q', 0.25],
    ['time', 'Wall time (cost)', 'c', 0.5],
    ['tokens', 'Tokens (cost)', 'c', 0.5],
  ];

  function valCell(x, unit) {
    var td = el('td', null, [rawfmt(x, unit)]);
    if (isNum(x)) td.setAttribute('title', String(x) + (unit ? ' (' + unit + ')' : ''));
    return td;
  }
  function dcell(o, good) {
    var td = el('td', null, [ci(o)]);
    if (o && isNum(o.mean))
      td.className = (good ? o.mean : -o.mean) > 0 ? 'pos' : o.mean === 0 ? '' : 'neg';
    return td;
  }

  function detailClaude(run, box, allRuns, isStale) {
    var raw = run.raw || {};
    var by = {};
    (raw.criteria || []).forEach(function (c) {
      by[c.id] = c;
    });
    var tb = el('table');
    var hd = el('tr');
    ['Criterion', 'Weight', 'vanilla', 'cc', 'Δ (95 % CI)', 'p (Holm)', 'n'].forEach(function (t) {
      hd.appendChild(el('th', null, [t]));
    });
    tb.appendChild(hd);
    function summary(label, o) {
      tb.appendChild(
        el('tr', { class: 'sum' }, [
          el('td', null, [label]),
          el('td'),
          el('td'),
          el('td'),
          el('td', null, [ci(o)]),
          el('td'),
          el('td'),
        ]),
      );
    }
    CRIT.forEach(function (c, i) {
      if (i === 5) summary('Q (quality gain)', raw.q);
      var d = by[c[0]];
      var isQ = d && d.direction ? d.direction !== 'lower_better' : c[2] === 'q';
      var lbl = [c[1]];
      if (d && d.raw_unit)
        lbl.push(
          el('div', { class: 'sub' }, [
            String(d.raw_unit) + (isQ ? '' : '; Δ = cost increase of cc, positive is worse'),
          ]),
        );
      var tr = el('tr', null, [
        el('td', null, lbl),
        el('td', null, [(d && isNum(d.weight) ? d.weight : c[3]).toFixed(2)]),
        d ? valCell(d.vanilla, d.raw_unit) : el('td', null, ['n/a']),
        d ? valCell(d.cc, d.raw_unit) : el('td', null, ['n/a']),
      ]);
      tr.appendChild(dcell(d && d.delta, isQ));
      tr.appendChild(el('td', null, [d ? pcell(d.p_holm) : 'n/a']));
      tr.appendChild(el('td', null, [d && d.n != null ? String(d.n) : 'n/a']));
      tb.appendChild(tr);
    });
    summary('C (cost increase, negative = cc cheaper)', raw.c);
    summary('NV = Q − 0.5 · C', raw.nv);
    box.appendChild(el('div', { class: 'tablewrap' }, [tb]));
    box.appendChild(
      el('p', { class: 'sub' }, [
        'Run ' +
          String(raw.date) +
          ' (' +
          String(raw.kind || '?') +
          '). Units of vanilla and cc values are those of each criterion (pass rate, score, seconds, tokens); only Δ is comparable across rows.',
      ]),
    );
    renderNotes(raw, box);
    // trend + amortisation across all legacy runs
    var legacyRuns = (allRuns || []).filter(function (r) {
      return r.kind === 'agent-claude';
    });
    Promise.all(legacyRuns.map(ensureFull)).then(function (fulls) {
      if (isStale && isStale()) return; // stale load: another selection won
      var raws = fulls.filter(Boolean).map(function (r) {
        return r.raw;
      });
      if (raws.length) {
        renderTrend(raws, box);
        renderAmort(raws, box);
      }
    });
  }

  function niceTicks(lo, hi) {
    var span = hi - lo || 1;
    var raw = span / 5;
    var p = Math.pow(10, Math.floor(Math.log10(raw)));
    var s = raw / p;
    var step = (s < 1.5 ? 1 : s < 3.5 ? 2 : s < 7.5 ? 5 : 10) * p;
    var out = [];
    for (var t = Math.ceil(lo / step) * step; t <= hi + step * 1e-6; t += step)
      out.push(+t.toFixed(10));
    return out;
  }

  function chartColors() {
    var dark = document.documentElement.getAttribute('data-theme') === 'dark';
    if (
      !document.documentElement.getAttribute('data-theme') &&
      window.matchMedia &&
      window.matchMedia('(prefers-color-scheme: dark)').matches
    )
      dark = true;
    return {
      accent: dark ? BRAND.accentTextDark || '#818cf8' : BRAND.accentTextLight || '#4f46e5',
      fill: BRAND.accent || '#6366f1',
      line: dark ? '#26262b' : '#e4e4e7',
      zero: BRAND.faint || '#71717a',
      green: dark ? BRAND.greenDark || '#10b981' : BRAND.greenLight || '#047857',
    };
  }

  function renderTrend(raws, box) {
    var col = chartColors();
    var pts = raws.filter(function (r) {
      return D.legacyUsable(r) && r.nv && isNum(r.nv.mean) && isNum(r.nv.lo) && isNum(r.nv.hi);
    });
    if (!pts.length) return;
    var W = 720;
    var H = 320;
    var L = 52;
    var R = 16;
    var T = 16;
    var B = 40;
    var t = pts.map(function (r) {
      return Date.parse(r.date + 'T00:00:00Z');
    });
    var t0 = Math.min.apply(null, t);
    var t1 = Math.max.apply(null, t);
    if (t1 === t0) {
      t0 -= 7 * 864e5;
      t1 += 7 * 864e5;
    } else {
      var pad = (t1 - t0) * 0.04;
      t0 -= pad;
      t1 += pad;
    }
    var lo = Math.min(
      0,
      Math.min.apply(
        null,
        pts.map(function (r) {
          return r.nv.lo;
        }),
      ),
    );
    var hi = Math.max(
      0,
      Math.max.apply(
        null,
        pts.map(function (r) {
          return r.nv.hi;
        }),
      ),
    );
    var m = (hi - lo) * 0.08 || 0.05;
    lo -= m;
    hi += m;
    function X(x) {
      return L + ((x - t0) / (t1 - t0)) * (W - L - R);
    }
    function Y(y) {
      return T + ((hi - y) / (hi - lo)) * (H - T - B);
    }
    var svg = sv('svg', {
      viewBox: '0 0 ' + W + ' ' + H,
      role: 'img',
      'aria-label': 'Net value NV per Claude run with 95 percent confidence band',
    });
    niceTicks(lo, hi).forEach(function (y) {
      svg.appendChild(
        sv('line', {
          x1: L,
          x2: W - R,
          y1: Y(y),
          y2: Y(y),
          stroke: y === 0 ? col.zero : col.line,
          'stroke-width': y === 0 ? 1.5 : 1,
          'stroke-dasharray': y === 0 ? '' : '3 3',
        }),
      );
      svg.appendChild(
        sv('text', { x: L - 6, y: Y(y) + 4, 'text-anchor': 'end' }, sgn(y, 2).replace('+', '')),
      );
    });
    var step = Math.ceil(pts.length / 6);
    pts.forEach(function (r, i) {
      if (i % step) return;
      svg.appendChild(
        sv('text', { x: X(t[i]), y: H - 18, 'text-anchor': 'middle' }, r.date.slice(5)),
      );
    });
    svg.appendChild(
      sv(
        'text',
        { x: (L + W - R) / 2, y: H - 3, 'text-anchor': 'middle' },
        'run date (to scale), NV on the y axis, grey line = 0',
      ),
    );
    var up = pts.map(function (r, i) {
      return X(t[i]) + ',' + Y(r.nv.hi);
    });
    var dn = pts
      .map(function (r, i) {
        return X(t[i]) + ',' + Y(r.nv.lo);
      })
      .reverse();
    if (pts.length > 1)
      svg.appendChild(
        sv('polygon', {
          points: up.concat(dn).join(' '),
          fill: col.fill,
          'fill-opacity': '0.18',
          stroke: 'none',
        }),
      );
    svg.appendChild(
      sv('polyline', {
        points: pts
          .map(function (r, i) {
            return X(t[i]) + ',' + Y(r.nv.mean);
          })
          .join(' '),
        fill: 'none',
        stroke: col.accent,
        'stroke-width': 2,
      }),
    );
    pts.forEach(function (r, i) {
      var x = X(t[i]);
      var mo = r.kind === 'monthly';
      svg.appendChild(
        sv('line', {
          x1: x,
          x2: x,
          y1: Y(r.nv.lo),
          y2: Y(r.nv.hi),
          stroke: col.fill,
          'stroke-width': mo ? 2.5 : 1.5,
        }),
      );
      var c = sv(
        mo ? 'rect' : 'circle',
        mo
          ? { x: x - 5, y: Y(r.nv.mean) - 5, width: 10, height: 10 }
          : { cx: x, cy: Y(r.nv.mean), r: 4 },
        null,
      );
      c.setAttribute('fill', col.accent);
      c.setAttribute('stroke', col.zero);
      c.appendChild(
        sv('title', {}, r.date + ' ' + (r.kind || '') + ' n=' + r.n + ' NV ' + ci(r.nv)),
      );
      svg.appendChild(c);
    });
    box.appendChild(el('h3', null, ['NV over time (Claude runs)']));
    box.appendChild(svg);
    box.appendChild(
      el('div', { class: 'legend' }, [
        el('span', null, [
          'Circle = legacy run of kind weekly (n = 3), square = kind monthly (n = 10)',
        ]),
        el('span', null, ['Line = NV, indigo band and bars = 95 % CI']),
      ]),
    );
    box.appendChild(
      el('p', { class: 'sub' }, [
        'Only valid runs of the current pre-registration enter the trend. A run whose band includes 0 is INCONCLUSIVE.',
      ]),
    );
    var vers = {};
    pts.forEach(function (r) {
      vers[(r.model || '?') + ' / Claude Code ' + (r.claude_code_version || '?')] = 1;
    });
    if (Object.keys(vers).length > 1)
      box.appendChild(
        el('div', { class: 'note' }, [
          'Several model / Claude Code versions are in this chart (' +
            Object.keys(vers).join('; ') +
            '). A step in the trend may come from a version change rather than from code-context.',
        ]),
      );
  }

  function renderAmort(raws, box) {
    var col = chartColors();
    var mr = null;
    for (var i = raws.length - 1; i >= 0; i--)
      if (D.legacyUsable(raws[i]) && raws[i].s5 && raws[i].s5.tasks && raws[i].s5.tasks.length) {
        mr = raws[i];
        break;
      }
    if (!mr) return;
    var tk = mr.s5.tasks;
    var be = mr.s5.break_even_k;
    var W = 720;
    var H = 300;
    var L = 64;
    var R = 16;
    var T = 16;
    var B = 40;
    var maxY =
      Math.max.apply(
        null,
        tk.map(function (x) {
          return Math.max(x.vanilla_tokens, x.cc_tokens);
        }),
      ) * 1.08;
    var maxK = Math.max.apply(
      null,
      tk.map(function (x) {
        return x.k;
      }),
    );
    function X(k) {
      return L + ((k - 1) / Math.max(1, maxK - 1)) * (W - L - R);
    }
    function Y(y) {
      return T + (1 - y / maxY) * (H - T - B);
    }
    var svg = sv('svg', {
      viewBox: '0 0 ' + W + ' ' + H,
      role: 'img',
      'aria-label': 'Cumulative tokens per task for both arms',
    });
    niceTicks(0, maxY).forEach(function (y) {
      svg.appendChild(
        sv('line', {
          x1: L,
          x2: W - R,
          y1: Y(y),
          y2: Y(y),
          stroke: col.line,
          'stroke-dasharray': '3 3',
        }),
      );
      svg.appendChild(
        sv(
          'text',
          { x: L - 6, y: Y(y) + 4, 'text-anchor': 'end' },
          y >= 1e6 ? (y / 1e6).toFixed(1) + 'M' : y >= 1e3 ? (y / 1e3).toFixed(0) + 'k' : String(y),
        ),
      );
    });
    tk.forEach(function (x) {
      svg.appendChild(sv('text', { x: X(x.k), y: H - 18, 'text-anchor': 'middle' }, 'k=' + x.k));
    });
    svg.appendChild(
      sv(
        'text',
        { x: (L + W - R) / 2, y: H - 3, 'text-anchor': 'middle' },
        'cumulative tokens after task k (cc includes indexing)',
      ),
    );
    [
      ['vanilla_tokens', col.zero],
      ['cc_tokens', col.accent],
    ].forEach(function (s) {
      svg.appendChild(
        sv('polyline', {
          points: tk
            .map(function (x) {
              return X(x.k) + ',' + Y(x[s[0]]);
            })
            .join(' '),
          fill: 'none',
          stroke: s[1],
          'stroke-width': 2,
        }),
      );
      tk.forEach(function (x) {
        svg.appendChild(sv('circle', { cx: X(x.k), cy: Y(x[s[0]]), r: 3.5, fill: s[1] }));
      });
    });
    if (isNum(be) && be >= 1 && be <= maxK)
      svg.appendChild(
        sv('line', {
          x1: X(be),
          x2: X(be),
          y1: T,
          y2: H - B,
          stroke: col.green,
          'stroke-width': 1.5,
          'stroke-dasharray': '5 4',
        }),
      );
    box.appendChild(el('h3', null, ['Token amortisation (S5)']));
    box.appendChild(svg);
    box.appendChild(
      el('div', { class: 'legend' }, [
        el('span', null, ['grey = vanilla']),
        el('span', null, ['indigo = cc']),
        el('span', null, ['green dashed = break-even k*']),
      ]),
    );
    var msg = isNum(be)
      ? 'Break-even k* = ' +
        be +
        ' (from the run of ' +
        mr.date +
        '): from task ' +
        be +
        ' on, cumulative cc tokens including indexing are at or below vanilla.'
      : 'Break-even k* not reached within ' +
        maxK +
        ' tasks in the run of ' +
        mr.date +
        ': cc used more cumulative tokens than vanilla throughout.';
    box.appendChild(el('p', { class: 'big' }, [msg]));
  }

  // ---- demo mode (?demo): fixture-shaped runs for all kinds ----
  function demoData() {
    var git = { commit: '0000000000000000000000000000000000000000', branch: 'demo', dirty: false };
    var sim = {
      schema: 'ccc-bench/1',
      run_id: 'sim-demo-20261010-120000',
      kind: 'simulated',
      date: '2026-10-10',
      ts: '2026-10-10T12:00:00+0200',
      trigger: 'manual',
      duration_ms: 41000,
      code_context_version: '2.8.0',
      git: git,
      notes: ['demo data, generated in the browser'],
      model: null,
      deterministic: {
        meta: { fixture: 'test/fixtures/sample-project', fileCount: 10 },
        tasks: [
          {
            id: 'T01',
            label: 'Single-file lookup',
            category: 'retrieval',
            points: 1,
            mcp: { tokens: 161, calls: 2, files: 1 },
            vanilla: { tokens: 467, calls: 2, files: 1 },
            tokenSavingsPct: 65.5,
            callSavingsPct: 0,
          },
          {
            id: 'T02',
            label: 'Symbol search',
            category: 'retrieval',
            points: 1,
            mcp: { tokens: 31, calls: 1, files: 0 },
            vanilla: { tokens: 360, calls: 2, files: 1 },
            tokenSavingsPct: 91.4,
            callSavingsPct: 50,
          },
        ],
        summary: {
          totalMcpTokens: 192,
          totalVanillaTokens: 827,
          totalSavingsPct: 76.8,
          totalMcpCalls: 3,
          totalVanillaCalls: 4,
          callSavingsPct: 25,
        },
      },
      stochastic: {
        config: { trials: 200, seed: 42 },
        results: { mcpWins: 181, vanillaWins: 19, ties: 0, mcpWinRate: 90.5 },
        tokens: {
          mcpMean: 294,
          vanillaMean: 585,
          savingsPct: 49.7,
          ci95: { lower: 40.1, upper: 58.3 },
        },
        statistics: {
          wilcoxon: { W: 471, z: 11.688, p: 0, n: 200 },
          effectSize: 0.953,
          effectLabel: 'large',
        },
        byTemplate: {
          'single-file': { count: 55, mcpMean: 185, vanillaMean: 287, savingsPct: 35.5 },
        },
      },
      headline: {
        tokensSavedPct: 76.8,
        callsSavedPct: 25,
        mcpWinsPct: 90.5,
        wilcoxonP: 0,
        effectSizeR: 0.953,
      },
    };
    var ag = {
      schema: 'ccc-bench/1',
      run_id: 'glm-demo-20261009-090000',
      kind: 'agent-glm',
      date: '2026-10-09',
      ts: '2026-10-09T09:00:00+0200',
      trigger: 'manual',
      duration_ms: 300000,
      code_context_version: '2.8.0',
      git: git,
      notes: ['demo data'],
      model: 'zai-coding-plan/glm-5.3',
      agent_cli: { name: 'opencode', version: 'demo' },
      fixture: 'test/fixtures/sample-project',
      auth: { keyEnv: 'ZAI_API_KEY' },
      tasks: [{ id: 'L1', prompt: 'demo prompt', checker: { type: 'answer' } }],
      arms: {
        vanilla: {
          results: [
            {
              task_id: 'L1',
              success: false,
              timeout: false,
              tokens: { input: 100, output: 50, cache_read: 0, cache_write: 0 },
              tool_calls: 10,
              mcp_tool_calls: 0,
              wall_ms: 60000,
              session_id: 'd',
              events_path: 'd.jsonl',
            },
          ],
        },
        cc: {
          results: [
            {
              task_id: 'L1',
              success: true,
              timeout: false,
              tokens: { input: 60, output: 30, cache_read: 0, cache_write: 0 },
              tool_calls: 5,
              mcp_tool_calls: 3,
              wall_ms: 40000,
              session_id: 'd',
              events_path: 'd.jsonl',
            },
          ],
          index_ms: 130,
          db_bytes: 286720,
        },
      },
      aggregate: {
        success_rate: { vanilla: 0, cc: 1 },
        tokens: {
          vanilla: { input: 100, output: 50, total: 150 },
          cc: { input: 60, output: 30, total: 90 },
          saved_pct: 40,
        },
        tool_calls: { vanilla: 10, cc: 5, saved_pct: 50 },
        wall_ms: { vanilla_mean: 60000, cc_mean: 40000 },
        per_task: [
          {
            task_id: 'L1',
            vanilla: {
              success: false,
              tokens: { input: 100, output: 50, total: 150 },
              tool_calls: 10,
              mcp_tool_calls: 0,
              wall_ms: 60000,
            },
            cc: {
              success: true,
              tokens: { input: 60, output: 30, total: 90 },
              tool_calls: 5,
              mcp_tool_calls: 3,
              wall_ms: 40000,
            },
          },
        ],
      },
      headline: {
        success_vanilla_pct: 0,
        success_cc_pct: 100,
        tokens_saved_pct: 40,
        tool_calls_saved_pct: 50,
      },
    };
    var leg = {
      schema: 'overdrive-bench/2',
      run_id: '20261006-demo',
      date: '2026-10-06',
      ts: '2026-10-06T08:00:00+0200',
      kind: 'weekly',
      trigger: 'manual',
      fake: false,
      model: 'opus',
      claude_code_version: '2.1.295-demo',
      n: 3,
      prereg: { version: 'v2', sha256: '0' },
      hidden: { tests_sha256: '0', answer_key_sha256: '0' },
      valid: true,
      treatment_received_rate: 0.95,
      nv: { mean: 0.08, lo: -0.02, hi: 0.18 },
      q: { mean: 0.12, lo: 0.02, hi: 0.22 },
      c: { mean: 0.06, lo: -0.05, hi: 0.17 },
      criteria: [
        {
          id: 'time',
          vanilla: 400000,
          cc: 430000,
          delta: { mean: 0.07, lo: -0.01, hi: 0.15 },
          p_holm: 1,
          n: 3,
          raw_unit: 'wall ms per pair',
          direction: 'lower_better',
          weight: 0.5,
        },
        {
          id: 'tokens',
          vanilla: 380000,
          cc: 370000,
          delta: { mean: -0.01, lo: -0.08, hi: 0.06 },
          p_holm: 1,
          n: 3,
          raw_unit: 'weighted tokens per pair',
          direction: 'lower_better',
          weight: 0.5,
        },
      ],
      s5: {
        tasks: [
          { k: 1, vanilla_tokens: 100, cc_tokens: 190 },
          { k: 2, vanilla_tokens: 200, cc_tokens: 260 },
          { k: 3, vanilla_tokens: 300, cc_tokens: 330 },
          { k: 4, vanilla_tokens: 400, cc_tokens: 400 },
          { k: 5, vanilla_tokens: 500, cc_tokens: 470 },
        ],
        break_even_k: 4,
      },
      notes: ['demo data'],
      verdict: 'INCONCLUSIVE',
    };
    var runs = D.sortRunsDesc([sim, ag, leg]);
    return { runs: runs, latest: D.normalizeRun(sim) };
  }

  // ---- theme toggle ----
  function currentTheme() {
    var t = document.documentElement.getAttribute('data-theme');
    if (t === 'dark' || t === 'light') return t;
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches
      ? 'dark'
      : 'light';
  }
  function applyTheme(t, persist) {
    document.documentElement.setAttribute('data-theme', t);
    var b = $('theme-toggle');
    if (b) {
      b.textContent = '[ ' + t + ' ]';
      b.setAttribute('aria-pressed', String(t === 'dark'));
    }
    if (persist) {
      try {
        localStorage.setItem('cc-theme', t);
      } catch {
        /* unavailable: the choice just does not persist */
      }
    }
  }
  function wireTheme() {
    applyTheme(currentTheme(), false);
    var b = $('theme-toggle');
    if (!b) return;
    b.addEventListener('click', function () {
      applyTheme(currentTheme() === 'dark' ? 'light' : 'dark', true);
    });
  }

  // ---- data loading ----
  function loadIndexRuns() {
    return getJSON(CFG.INDEX || 'data/index.json')
      .then(function (idx) {
        return D.sortRunsDesc((idx && idx.runs) || []);
      })
      .catch(function () {
        return [];
      });
  }
  function loadLatest(indexRuns) {
    return getJSON(CFG.LATEST || 'data/latest.json')
      .then(function (raw) {
        var n = D.normalizeRun(raw);
        if (!n) throw new Error('unrecognized latest.json');
        return n;
      })
      .catch(function () {
        return indexRuns.length ? indexRuns[0] : null; // fallback: newest index entry
      });
  }

  function init() {
    renderWordmark();
    wireTheme();
    if (CFG.REPO) {
      ['repo-link', 'repo-link2'].forEach(function (id) {
        var a = $(id);
        if (a) a.href = CFG.REPO;
      });
    }
    if (DEMO) {
      var banner = $('demo-banner');
      if (banner) banner.hidden = false;
    }
    function paint(d) {
      renderHeadline(d.latest);
      renderHistory(d.runs, function (r) {
        renderDetail(r, d.runs);
      });
      renderDetail(d.latest, d.runs);
    }
    function paintEmpty() {
      renderHeadline(null);
      renderHistory([], function () {});
      renderDetail(null, []);
    }
    if (DEMO) {
      paint(demoData());
      return;
    }
    loadIndexRuns()
      .then(function (runs) {
        return loadLatest(runs).then(function (latest) {
          return { runs: runs, latest: latest };
        });
      })
      .then(paint)
      .catch(paintEmpty);
  }

  // Test hook (kept from the previous site; JSDOM tests drive these).
  window.BenchLogic = {
    verdict: D ? D.verdictOf : null,
    usable: D ? D.legacyUsable : null,
    isInvalid: D ? D.isInvalid : null,
    normalize: D ? D.normalizeRun : null,
    rawfmt: rawfmt,
    framesBlock: framesBlock,
    headlineText: headlineText,
  };
  if (D) {
    init();
  } else {
    // site/data.js failed to load (or loaded after app.js): fail loudly and
    // visibly instead of leaving a silently empty page.
    console.error(
      'bench site: window.BenchData is missing — site/data.js must load before site/app.js',
    );
    renderWordmark();
    var main = document.querySelector('main') || document.body;
    main.textContent =
      'Site data failed to load: site/data.js is missing or failed. Check that it is served next to app.js.';
    document.documentElement.setAttribute('data-state', 'error');
  }
})();
