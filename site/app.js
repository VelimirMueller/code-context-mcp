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

  // "3.73× vanilla" reads unambiguously; "tokens saved −273 %" did not.
  // Below 1× is a saving, above 1× costs more. From saved_pct = (van − cc) / van.
  function ratioText(savedPct) {
    return isNum(savedPct) ? (1 - savedPct / 100).toFixed(2) + '× vanilla' : 'n/a';
  }
  function usd(x) {
    return isNum(x) ? '$' + x.toFixed(x < 1 ? 4 : 2) : 'n/a';
  }

  // "a–b× vanilla" from a saved-% spread (min saved = the highest ratio).
  function spreadText(sp) {
    return sp && isNum(sp.min) && isNum(sp.max)
      ? (1 - sp.max / 100).toFixed(2) + '–' + (1 - sp.min / 100).toFixed(2) + '×'
      : null;
  }
  function perPassText(pp, guided) {
    pp = pp || {};
    return (
      'vanilla ' +
      rawfmt(pp.vanilla) +
      ' · cc ' +
      rawfmt(pp.cc) +
      (guided ? ' · guided ' + rawfmt(pp.cc_guided) : '')
    );
  }

  // ---- rule-based verdict (CCA-20) ----
  // Badge colour is a status: green = BENEFICIAL, grey = NO CLEAR EFFECT,
  // red = SUBOPTIMAL. The sentences are the ASD-STE100 text of the verdict.
  var VERDICT_CLASS = { BENEFICIAL: 'keep', NO_CLEAR_EFFECT: 'inc', SUBOPTIMAL: 'drop' };
  function verdictLabel(v) {
    return (D.VERDICT_LABELS[v.code] || v.code) + (v.indicative ? ' (indicative)' : '');
  }
  function verdictBadge(v) {
    return el(
      'span',
      {
        class: 'badge ' + (VERDICT_CLASS[v.code] || 'pend'),
        'data-verdict': v.code,
      },
      [D.VERDICT_LABELS[v.code] || v.code],
    );
  }
  // Badge + the verdict sentences. `title` names the block (e.g. "Verdict").
  function verdictBlock(v, title) {
    var kids = [];
    if (title) kids.push(el('h3', null, [title]));
    var head = [verdictBadge(v)];
    if (v.indicative) head.push(el('span', { class: 'sub verdict-ind' }, ['indicative']));
    kids.push(el('div', { class: 'verdict' }, head));
    var ul = el('ul', { class: 'ste' });
    v.sentences.forEach(function (t) {
      ul.appendChild(el('li', null, [t]));
    });
    kids.push(ul);
    return el('div', { class: 'card verdict-card' }, kids);
  }

  // Headline (CCA-08): success, uncached tokens (input + output + cache
  // write), cost, uncached tokens per PASS. The all-tokens total is mostly
  // cache reads (billed at ~1 % of input), so it lives in the detail only.
  function headlineAgent(run, box) {
    var a = D.agentOf(run);
    var verdict = D.agentVerdictOf(run);
    if (verdict) box.appendChild(verdictBlock(verdict));
    var guided = isNum(a.successCcGuidedPct);
    var tiles = [
      { label: 'SUCCESS VANILLA', value: pct1(a.successVanillaPct) },
      { label: 'SUCCESS CC', value: pct1(a.successCcPct) },
    ];
    if (guided) tiles.push({ label: 'SUCCESS GUIDED', value: pct1(a.successCcGuidedPct) });
    tiles.push({ label: 'UNCACHED CC', value: ratioText(a.uncachedSavedPct) });
    if (guided)
      tiles.push({ label: 'UNCACHED GUIDED', value: ratioText(a.guidedUncachedSavedPct) });
    tiles.push({ label: 'COST CC', value: ratioText(a.costSavedPct) });
    if (guided) tiles.push({ label: 'COST GUIDED', value: ratioText(a.guidedCostSavedPct) });
    box.appendChild(framesNode(tiles));
    var sp = spreadText(a.uncachedSpread);
    var gsp = guided ? spreadText(a.guidedUncachedSpread) : null;
    box.appendChild(
      el('p', { class: 'sub' }, [
        'Uncached tokens per PASS: ' +
          perPassText(a.uncachedPerPass, guided) +
          '.' +
          (sp
            ? ' Uncached over ' +
              a.uncachedSpread.repeats +
              ' repeats: cc ' +
              sp +
              (gsp ? ', guided ' + gsp : '') +
              ' vanilla.'
            : ''),
      ]),
    );
    if (a.mcpCalls && isNum(a.mcpCalls.cc)) {
      box.appendChild(
        el('p', { class: 'sub' }, [
          'code-context calls: cc ' +
            rawfmt(a.mcpCalls.cc) +
            (isNum(a.mcpCalls.cc_guided) ? ', guided ' + rawfmt(a.mcpCalls.cc_guided) : '') +
            '. Cost: vanilla ' +
            usd(a.cost && a.cost.vanilla) +
            ', cc ' +
            usd(a.cost && a.cost.cc) +
            (guided ? ', guided ' + usd(a.cost && a.cost.cc_guided) : '') +
            '.',
        ]),
      );
    }
    var wall =
      a.wall && isNum(a.wall.vanilla_mean) && isNum(a.wall.cc_mean)
        ? 'Wall time ' + msFmt(a.wall.vanilla_mean) + ' → ' + msFmt(a.wall.cc_mean) + ' per task. '
        : '';
    box.appendChild(
      el('p', { class: 'sub' }, [
        wall +
          (guided
            ? 'Same agent, same tasks: without the server, with it, and with it plus the instruction to use it first.'
            : 'Same agent, same tasks, once without and once with the code-context MCP server.') +
          ' Uncached = input + output + cache write; all tokens incl. cache reads are in the detail.',
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
    if (D.isAgentKind(run.kind)) {
      var verdict = D.agentVerdictOf(run);
      return (
        (verdict ? verdictLabel(verdict) + ' · ' : '') +
        pct1(h.success_vanilla_pct).trim() +
        ' → ' +
        pct1(h.success_cc_pct).trim() +
        (isNum(h.success_cc_guided_pct)
          ? ' / ' + pct1(h.success_cc_guided_pct).trim() + ' guided'
          : '') +
        ' success · ' +
        (isNum(h.uncached_saved_pct)
          ? 'uncached cc ' +
            ratioText(h.uncached_saved_pct) +
            (isNum(h.guided_uncached_saved_pct)
              ? ' · guided ' + ratioText(h.guided_uncached_saved_pct)
              : '') +
            (isNum(h.cost_saved_pct) ? ' · cost cc ' + ratioText(h.cost_saved_pct) : '')
          : // pre-CCA-08 index entry: only the all-tokens figure exists
            'cc ' +
            ratioText(h.tokens_saved_pct) +
            (isNum(h.guided_tokens_saved_pct)
              ? ' · guided ' + ratioText(h.guided_tokens_saved_pct)
              : '') +
            ' tokens')
      );
    }
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
    var verdict = D.agentVerdictOf(run);
    if (verdict) box.appendChild(verdictBlock(verdict, 'Verdict'));
    var rows = a.perTask.length ? a.perTask : [];
    var guided = rows.some(function (p) {
      return p && p.cc_guided;
    });
    // Ladder size per task (S, M, ML, L, XL) from the run's task list, when present.
    var sizeOf = {};
    (Array.isArray(raw.tasks) ? raw.tasks : []).forEach(function (t) {
      if (t && typeof t.id === 'string' && typeof t.size === 'string') sizeOf[t.id] = t.size;
    });
    // Success per task: success_rate (repeats) or a boolean (single-repeat demo runs).
    function okCell(o) {
      o = o || {};
      var r = isNum(o.success_rate)
        ? o.success_rate
        : o.success === true
          ? 1
          : o.success === false
            ? 0
            : null;
      if (r === null) return el('td', null, ['n/a']);
      var txt = isNum(o.success_rate) ? Math.round(r * 100) + ' %' : r === 1 ? 'yes' : 'no';
      return el('td', { class: r === 1 ? 'pos' : 'neg' }, [txt]);
    }
    // Paired uncached delta vs vanilla, with the min–max over repeats.
    // Green = the arm used fewer uncached tokens, red = more.
    function deltaCell(d) {
      if (!d || !isNum(d.saved_pct)) return el('td', null, ['n/a']);
      var txt =
        sgn(d.saved_pct, 1) +
        ' %' +
        (d.pairs > 1 ? ' [' + sgn(d.min, 1) + ' … ' + sgn(d.max, 1) + ']' : '');
      return el('td', { class: d.saved_pct > 0 ? 'pos' : d.saved_pct < 0 ? 'neg' : null }, [txt]);
    }
    if (rows.length) {
      var tb = el('table');
      var hd = el('tr');
      var heads = ['Task', 'OK vanilla', 'OK cc'];
      if (guided) heads.push('OK guided');
      heads.push('Uncached van', 'Uncached cc', 'Δ uncached cc (min … max)');
      if (guided) heads.push('Uncached guided', 'Δ uncached guided');
      heads.push('Calls van', 'Calls cc', 'MCP calls', 'Wall van', 'Wall cc');
      heads.forEach(function (t) {
        hd.appendChild(el('th', null, [t]));
      });
      tb.appendChild(hd);
      rows.forEach(function (p) {
        var v = p.vanilla || {};
        var c = p.cc || {};
        var hv = D.taskHonestOf(run, p, 'vanilla');
        var hc = D.taskHonestOf(run, p, 'cc');
        var hg = guided ? D.taskHonestOf(run, p, 'cc_guided') : null;
        var cells = [
          el('td', null, [
            String(p.task_id) + (sizeOf[p.task_id] ? ' · ' + sizeOf[p.task_id] : ''),
          ]),
          okCell(v),
          okCell(c),
        ];
        if (guided) cells.push(okCell(p.cc_guided));
        cells.push(
          el('td', null, [rawfmt(hv.uncached)]),
          el('td', null, [rawfmt(hc.uncached)]),
          deltaCell(hc.delta),
        );
        if (guided) cells.push(el('td', null, [rawfmt(hg.uncached)]), deltaCell(hg.delta));
        cells.push(
          el('td', null, [rawfmt(v.tool_calls)]),
          el('td', null, [rawfmt(c.tool_calls)]),
          el('td', null, [rawfmt(c.mcp_tool_calls)]),
          el('td', null, [msFmt(isNum(v.wall_ms_mean) ? v.wall_ms_mean : v.wall_ms)]),
          el('td', null, [msFmt(isNum(c.wall_ms_mean) ? c.wall_ms_mean : c.wall_ms)]),
        );
        tb.appendChild(el('tr', null, cells));
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
      t = t || {};
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
    var un = a.uncached || {};
    var g = isNum(a.successCcGuidedPct) || !!tk.cc_guided;
    row(
      'Uncached tokens',
      'vanilla ' +
        rawfmt(un.vanilla) +
        ' · cc ' +
        rawfmt(un.cc) +
        ' (' +
        ratioText(a.uncachedSavedPct) +
        (spreadText(a.uncachedSpread)
          ? ', ' + spreadText(a.uncachedSpread) + ' over repeats'
          : '') +
        ')' +
        (g
          ? ' · guided ' +
            rawfmt(un.cc_guided) +
            ' (' +
            ratioText(a.guidedUncachedSavedPct) +
            (spreadText(a.guidedUncachedSpread)
              ? ', ' + spreadText(a.guidedUncachedSpread) + ' over repeats'
              : '') +
            ')'
          : ''),
    );
    row('Uncached per PASS', perPassText(a.uncachedPerPass, g));
    var pp = a.perPass || {};
    if (pp.vanilla && isNum(pp.vanilla.passes)) {
      var passes = function (o) {
        return o ? rawfmt(o.passes) + '/' + rawfmt(o.sessions) : 'n/a';
      };
      row(
        'PASS / sessions',
        'vanilla ' +
          passes(pp.vanilla) +
          ' · cc ' +
          passes(pp.cc) +
          (g ? ' · guided ' + passes(pp.cc_guided) : ''),
      );
      if (isNum(pp.vanilla.tokens_per_pass) || isNum(pp.cc && pp.cc.tokens_per_pass))
        row(
          'All tokens per PASS',
          'vanilla ' +
            rawfmt(pp.vanilla.tokens_per_pass) +
            ' · cc ' +
            rawfmt(pp.cc && pp.cc.tokens_per_pass) +
            (g ? ' · guided ' + rawfmt(pp.cc_guided && pp.cc_guided.tokens_per_pass) : ''),
        );
    }
    // All tokens = input + cache_read + output: mostly cache reads, which
    // providers bill at ~1 % of input. Shown for completeness, not as a result.
    row('All tokens (vanilla)', tokLine(tv));
    row('All tokens (cc)', tokLine(tc));
    row('All tokens cc', ratioText(a.tokensSavedPct));
    if (tk.cc_guided) {
      row('All tokens (guided)', tokLine(tk.cc_guided));
      row('All tokens guided', ratioText(a.guidedTokensSavedPct));
    }
    if (a.mcpCalls && isNum(a.mcpCalls.cc)) {
      row(
        'code-context calls',
        'cc ' +
          rawfmt(a.mcpCalls.cc) +
          (isNum(a.mcpCalls.cc_guided) ? ' · guided ' + rawfmt(a.mcpCalls.cc_guided) : ''),
      );
    }
    if (a.cost) {
      row(
        'Cost',
        'vanilla ' +
          usd(a.cost.vanilla) +
          ' · cc ' +
          usd(a.cost.cc) +
          (isNum(a.costSavedPct) ? ' (' + ratioText(a.costSavedPct) + ')' : '') +
          (tk.cc_guided
            ? ' · guided ' +
              usd(a.cost.cc_guided) +
              (isNum(a.guidedCostSavedPct) ? ' (' + ratioText(a.guidedCostSavedPct) + ')' : '')
            : ''),
      );
      if (pp.vanilla && (isNum(pp.vanilla.cost_per_pass) || isNum(pp.cc && pp.cc.cost_per_pass)))
        row(
          'Cost per PASS',
          'vanilla ' +
            usd(pp.vanilla.cost_per_pass) +
            ' · cc ' +
            usd(pp.cc && pp.cc.cost_per_pass) +
            (g ? ' · guided ' + usd(pp.cc_guided && pp.cc_guided.cost_per_pass) : ''),
        );
    }
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
            mcp: { tokens: 136, calls: 2, files: 1 },
            vanilla: { tokens: 387, calls: 2, files: 1 },
            tokenSavingsPct: 64.9,
            callSavingsPct: 0,
          },
          {
            id: 'T02',
            label: 'Symbol search',
            category: 'retrieval',
            points: 1,
            mcp: { tokens: 16, calls: 1, files: 0 },
            vanilla: { tokens: 310, calls: 2, files: 1 },
            tokenSavingsPct: 94.8,
            callSavingsPct: 50,
          },
        ],
        summary: {
          totalMcpTokens: 152,
          totalVanillaTokens: 697,
          totalSavingsPct: 78.2,
          totalMcpCalls: 3,
          totalVanillaCalls: 4,
          callSavingsPct: 25,
        },
      },
      stochastic: {
        config: { trials: 200, seed: 42 },
        results: { mcpWins: 185, vanillaWins: 14, ties: 1, mcpWinRate: 92.5 },
        tokens: {
          mcpMean: 302,
          vanillaMean: 605,
          savingsPct: 50.1,
          ci95: { lower: 19.6, upper: 45.9 },
        },
        statistics: {
          wilcoxon: { W: 446, z: 11.684, p: 0, n: 199 },
          effectSize: 0.955,
          effectLabel: 'large',
        },
        byTemplate: {
          'single-file': { count: 55, mcpMean: 169, vanillaMean: 287, savingsPct: 41.1 },
        },
      },
      headline: {
        tokensSavedPct: 78.2,
        callsSavedPct: 25,
        mcpWinsPct: 92.5,
        wilcoxonP: 0,
        effectSizeR: 0.955,
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

  // ---- private-suite summaries (CCA-19) ----
  // Redacted summaries only: alias, scope counts and numbers. Task texts,
  // code and source names never reach the site, so none are rendered.
  var PRIVATE_ARMS = [
    ['vanilla', 'vanilla'],
    ['cc', 'cc'],
    ['cc_guided', 'cc-guided'],
  ];

  function successText(a) {
    return a && isNum(a.success_pct) ? a.success_pct.toFixed(1) + ' %' : 'n/a';
  }
  // "0.62× vanilla [0.55–0.70×]" for an arm's saved block.
  function savedText(sv) {
    if (!sv) return 'n/a';
    var sp = spreadText(sv.uncached_saved_spread);
    return ratioText(sv.uncached_saved_pct) + (sp ? ' [' + sp + ']' : '');
  }

  function privateArmsTable(block, caption) {
    var tb = el('table', { 'aria-label': caption });
    var hd = el('tr');
    [
      'Arm',
      'Success',
      'Uncached / session',
      'Uncached / PASS',
      'Uncached vs vanilla (min–max)',
      'Cost',
      'Cost vs vanilla',
      'Wall / session',
    ].forEach(function (t) {
      hd.appendChild(el('th', null, [t]));
    });
    tb.appendChild(hd);
    PRIVATE_ARMS.forEach(function (pa) {
      var a = block.arms[pa[0]];
      if (!a) return;
      var sv = pa[0] === 'vanilla' ? null : block.saved[pa[0]];
      tb.appendChild(
        el('tr', null, [
          el('td', null, [pa[1]]),
          el('td', null, [successText(a)]),
          el('td', null, [rawfmt(a.uncached_per_session)]),
          el('td', null, [rawfmt(a.uncached_per_pass)]),
          el(
            'td',
            sv && isNum(sv.uncached_saved_pct)
              ? {
                  class:
                    sv.uncached_saved_pct > 0 ? 'pos' : sv.uncached_saved_pct < 0 ? 'neg' : null,
                }
              : null,
            [sv ? savedText(sv) : '1.00× (baseline)'],
          ),
          el('td', null, [usd(a.cost_usd)]),
          el('td', null, [sv ? ratioText(sv.cost_saved_pct) : '1.00× (baseline)']),
          el('td', null, [msFmt(a.wall_mean_ms)]),
        ]),
      );
    });
    return el('div', { class: 'tablewrap' }, [tb]);
  }

  function privateGroupsTable(run, guided) {
    var tb = el('table', { 'aria-label': 'Per group' });
    var hd = el('tr');
    var heads = ['Group', 'Tasks', 'Verdict', 'OK vanilla', 'OK cc'];
    if (guided) heads.push('OK guided');
    heads.push('Uncached cc vs vanilla', 'Cost cc vs vanilla');
    if (guided) heads.push('Uncached guided vs vanilla');
    heads.forEach(function (t) {
      hd.appendChild(el('th', null, [t]));
    });
    tb.appendChild(hd);
    run.groups.forEach(function (g) {
      var cells = [
        el('td', null, [g.group]),
        el('td', null, [rawfmt(g.tasks)]),
        el('td', { class: 'verdict-cell' }, [g.verdict ? verdictLabel(g.verdict) : 'n/a']),
        el('td', null, [successText(g.arms.vanilla)]),
        el('td', null, [successText(g.arms.cc)]),
      ];
      if (guided) cells.push(el('td', null, [successText(g.arms.cc_guided)]));
      cells.push(
        el('td', null, [savedText(g.saved.cc)]),
        el('td', null, [ratioText(g.saved.cc && g.saved.cc.cost_saved_pct)]),
      );
      if (guided) cells.push(el('td', null, [savedText(g.saved.cc_guided)]));
      tb.appendChild(el('tr', null, cells));
    });
    return el('div', { class: 'tablewrap' }, [tb]);
  }

  function privateCard(s) {
    var card = el('div', { class: 'card private-card' });
    card.appendChild(
      el('div', { class: 'kind-intro' }, [
        el('span', { class: 'kbadge k-private' }, ['REAL-WORLD PRIVATE SUITE']),
        el('h3', null, [s.alias]),
      ]),
    );
    var sc = s.scope;
    var groups = Object.keys(sc.perGroup)
      .map(function (k) {
        return k + ' ' + rawfmt(sc.perGroup[k]);
      })
      .join(' · ');
    var dl = el('dl', { class: 'meta' });
    function row(k, v) {
      dl.appendChild(el('dt', null, [k]));
      dl.appendChild(el('dd', null, [v]));
    }
    row(
      'Scope',
      rawfmt(sc.sources) +
        ' sources · ' +
        (isNum(sc.files) ? rawfmt(sc.files) + ' files · ' : '') +
        (isNum(sc.totalMb) ? sc.totalMb.toFixed(1) + ' MB · ' : '') +
        rawfmt(sc.tasks) +
        ' tasks',
    );
    if (groups) row('Tasks per group', groups);
    row('Summary', (s.generated || 'n/a') + (s.version ? ' · code-context ' + s.version : ''));
    card.appendChild(dl);
    s.runs.forEach(function (r) {
      var meta = kindIntroLabel(r.kind);
      card.appendChild(
        el('h4', null, [
          (r.model || 'unknown model') +
            ' · ' +
            meta +
            ' · ' +
            (r.date || 'n/a') +
            ' · n = ' +
            rawfmt(r.repeats) +
            ' per task and arm',
        ]),
      );
      if (r.verdict) card.appendChild(verdictBlock(r.verdict));
      card.appendChild(privateArmsTable(r, 'Arms: ' + (r.model || '')));
      var guided = !!r.arms.cc_guided;
      if (r.groups.length > 1 || (r.groups.length === 1 && r.groups[0].group !== 'all'))
        card.appendChild(privateGroupsTable(r, guided));
    });
    card.appendChild(
      el('p', { class: 'sub' }, [
        'Task texts and code are private. Published: alias, counts and the numbers above (ccc-bench-private-summary/1).',
      ]),
    );
    return card;
  }

  function kindIntroLabel(kind) {
    var m = D.kindMeta(kind);
    return m && m.label ? m.label : String(kind || 'agent');
  }

  function renderPrivate(summaries) {
    var sec = $('private');
    var box = $('private-body');
    if (!sec || !box) return;
    clear(box);
    var list = (summaries || []).filter(Boolean);
    sec.hidden = list.length === 0;
    list.forEach(function (s) {
      box.appendChild(privateCard(s));
    });
  }

  function loadPrivate() {
    var dir = CFG.DATA_DIR || 'data/';
    return getJSON(CFG.PRIVATE_INDEX || 'data/private/index.json')
      .then(function (idx) {
        return Promise.all(
          D.privateIndexOf(idx).map(function (e) {
            return getJSON(dir + e.file)
              .then(D.privateSummaryOf)
              .catch(function () {
                return null;
              });
          }),
        );
      })
      .catch(function () {
        return [];
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
    // Independent of the runs: a missing data/private/ keeps the section hidden.
    loadPrivate().then(renderPrivate);
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
    renderPrivate: renderPrivate,
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
