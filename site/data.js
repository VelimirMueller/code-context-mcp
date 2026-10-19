/*
 * Pure data layer for the benchmark site: no DOM, no fetch, no throwing.
 * Normalises the three run kinds of the ccc-bench/1 contract plus the legacy
 * overdrive-bench/2 runs already published on bench-results (mapped to kind
 * agent-claude, never modified). Invalid entries are filtered, never thrown.
 *
 * Loaded by index.html after config.js and before app.js; exposes window.BenchData.
 */
(function () {
  'use strict';

  var CFG = window.BENCH_CONFIG || {};
  var NEW_KINDS = ['simulated', 'agent-glm', 'agent-deepseek', 'agent-opus'];
  var AGENT_KINDS = ['agent-glm', 'agent-deepseek', 'agent-opus'];
  var LEGACY_SCHEMA = CFG.LEGACY_SCHEMA || 'overdrive-bench/2';
  var MIN_TREATMENT_RATE = isNum(CFG.MIN_TREATMENT_RATE) ? CFG.MIN_TREATMENT_RATE : 0.8;

  function isObj(x) {
    return x !== null && typeof x === 'object' && !Array.isArray(x);
  }
  function isNum(x) {
    return typeof x === 'number' && isFinite(x);
  }
  function arr(x) {
    return Array.isArray(x) ? x : [];
  }

  // Legacy detection: schema overdrive-bench/2, fallback prereg + nv (PLAN data contract).
  function isLegacy(raw) {
    if (!isObj(raw)) return false;
    if (raw.schema === LEGACY_SCHEMA) return true;
    return raw.schema == null && isObj(raw.prereg) && isObj(raw.nv);
  }

  function kindOf(raw) {
    if (!isObj(raw)) return null;
    if (isLegacy(raw)) return 'agent-claude';
    if (NEW_KINDS.indexOf(raw.kind) >= 0) return raw.kind;
    if (raw.kind === 'agent-claude') return 'agent-claude'; // normalised index summaries
    return null;
  }

  function isAgentKind(kind) {
    return AGENT_KINDS.indexOf(kind) >= 0;
  }

  // Verdict from the pre-registered rule (CI bounds); a stored verdict never wins.
  function verdictOf(nv) {
    if (!isObj(nv) || !isNum(nv.lo) || !isNum(nv.hi)) return null;
    if (nv.lo > 0) return 'KEEP';
    if (nv.hi < 0) return 'DROP';
    return 'INCONCLUSIVE';
  }

  // Legacy headline: { nv_mean, nv_lo, nv_hi, verdict } or null.
  function legacyHeadline(raw) {
    if (isObj(raw.headline) && isNum(raw.headline.nv_mean)) return raw.headline; // index summary
    if (isObj(raw.nv) && isNum(raw.nv.mean) && isNum(raw.nv.lo) && isNum(raw.nv.hi)) {
      return {
        nv_mean: raw.nv.mean,
        nv_lo: raw.nv.lo,
        nv_hi: raw.nv.hi,
        verdict: verdictOf(raw.nv),
      };
    }
    return null;
  }

  function headlineOf(raw) {
    if (!isObj(raw)) return null;
    var kind = kindOf(raw);
    if (kind === 'agent-claude') return legacyHeadline(raw);
    if (isObj(raw.headline)) return raw.headline;
    return null;
  }

  // raw -> { id, kind, date, ts, model, headline, raw } or null (invalid, filtered).
  function normalizeRun(raw) {
    var kind = kindOf(raw);
    if (!kind || typeof raw.run_id !== 'string' || !raw.run_id) return null;
    if (typeof raw.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(raw.date)) return null;
    var ts = typeof raw.ts === 'string' && raw.ts ? raw.ts : raw.date;
    var model = typeof raw.model === 'string' && raw.model ? raw.model : null;
    return {
      id: raw.run_id,
      kind: kind,
      date: raw.date,
      ts: ts,
      model: model,
      headline: headlineOf(raw),
      raw: raw,
    };
  }

  // Sort key: (ts || date, run_id), newest first. Nulls dropped, never thrown.
  // ts stamps parse as UTC milliseconds when possible (date-only legacy stamps
  // count as UTC midnight); a missing or unparseable stamp sorts oldest, and
  // equal timestamps tie-break on run_id — same contract as the index builder.
  function tsMillis(ts) {
    var t = Date.parse(ts);
    return isNaN(t) ? null : t;
  }
  function sortRunsDesc(list) {
    return arr(list)
      .map(normalizeRun)
      .filter(function (r) {
        return !!r;
      })
      .sort(function (a, b) {
        var ma = tsMillis(a.ts);
        var mb = tsMillis(b.ts);
        if (ma !== null && mb !== null && ma !== mb) return ma > mb ? -1 : 1;
        if (ma !== mb) return ma !== null ? -1 : 1; // parseable beats missing/garbage
        if (a.ts !== b.ts) return a.ts > b.ts ? -1 : 1;
        return a.id > b.id ? -1 : a.id < b.id ? 1 : 0;
      });
  }

  // ---- history restart (BENCH_CONFIG.HISTORY) ----
  // runs: index entries (raw or normalized); baseline: raw baseline run files.
  // Returns null when no restart is configured, else
  //   { runs: kept runs newest first, groups: [{ label, date, note, baseline, runs }], note }
  // Groups: one per publish date at or after h.since, newest first, numbered
  // "Run 1" for the oldest kept date; the baseline group comes last.
  function historyOf(runs, baseline, h) {
    if (!isObj(h) || typeof h.since !== 'string') return null;
    var cut = tsMillis(h.since);
    if (cut === null) return null;
    var kept = sortRunsDesc(
      arr(runs).map(function (r) {
        return r && r.raw ? r.raw : r;
      }),
    ).filter(function (r) {
      var t = tsMillis(r.ts);
      return t !== null && t >= cut;
    });
    var dates = [];
    kept.forEach(function (r) {
      if (dates.indexOf(r.date) < 0) dates.push(r.date);
    });
    dates.sort();
    var groups = dates
      .map(function (d, i) {
        return {
          label: 'Run ' + (i + 1),
          date: d,
          note: null,
          baseline: false,
          runs: kept.filter(function (r) {
            return r.date === d;
          }),
        };
      })
      .reverse();
    var b = isObj(h.baseline) ? h.baseline : null;
    var base = sortRunsDesc(baseline);
    if (b && base.length) {
      groups.push({
        label: typeof b.label === 'string' && b.label ? b.label : 'Baseline',
        date: base[0].date,
        note: typeof b.note === 'string' ? b.note : null,
        baseline: true,
        runs: base,
      });
    }
    return { runs: kept, groups: groups, note: typeof h.note === 'string' ? h.note : null };
  }

  // ---- legacy validity rules (pre-registration v2) ----
  function preregVersion(raw) {
    return isObj(raw) && isObj(raw.prereg) && typeof raw.prereg.version === 'string'
      ? raw.prereg.version
      : 'unknown';
  }
  function treatmentRate(raw) {
    if (!isObj(raw)) return null;
    if (isNum(raw.treatment_received_rate)) return raw.treatment_received_rate;
    if (isObj(raw.treatment) && isNum(raw.treatment.rate)) return raw.treatment.rate;
    return null;
  }
  // A legacy run counts only with valid === true and (if recorded) treatment rate >= MIN_TREATMENT_RATE.
  function isInvalid(raw) {
    if (raw.valid !== true) return true;
    var t = treatmentRate(raw);
    return isNum(t) && t < MIN_TREATMENT_RATE;
  }
  function legacyUsable(raw) {
    return preregVersion(raw) === (CFG.PREREG_CURRENT || 'v2') && !isInvalid(raw);
  }

  // ---- kind-specific accessors (all defensive; null/[] when the run lacks data) ----
  function simulatedOf(run) {
    var r = isObj(run) && isObj(run.raw) ? run.raw : run;
    if (kindOf(r) !== 'simulated') return null;
    var d = isObj(r.deterministic) ? r.deterministic : {};
    var s = isObj(r.stochastic) ? r.stochastic : {};
    var h = isObj(r.headline) ? r.headline : {};
    var stats = isObj(s.statistics) ? s.statistics : {};
    var wil = isObj(stats.wilcoxon) ? stats.wilcoxon : {};
    var res = isObj(s.results) ? s.results : {};
    var sum = isObj(d.summary) ? d.summary : {};
    return {
      tasks: arr(d.tasks),
      summary: isObj(d.summary) ? d.summary : null,
      meta: isObj(d.meta) ? d.meta : null,
      stochastic: isObj(s) && Object.keys(s).length ? s : null,
      tokensSavedPct: isNum(h.tokensSavedPct)
        ? h.tokensSavedPct
        : isNum(sum.totalSavingsPct)
          ? sum.totalSavingsPct
          : null,
      callsSavedPct: isNum(h.callsSavedPct)
        ? h.callsSavedPct
        : isNum(sum.callSavingsPct)
          ? sum.callSavingsPct
          : null,
      mcpWinsPct: isNum(h.mcpWinsPct)
        ? h.mcpWinsPct
        : isNum(res.mcpWinRate)
          ? res.mcpWinRate
          : null,
      wilcoxonP: isNum(h.wilcoxonP) ? h.wilcoxonP : isNum(wil.p) ? wil.p : null,
      effectSizeR: isNum(h.effectSizeR)
        ? h.effectSizeR
        : isNum(stats.effectSize)
          ? stats.effectSize
          : null,
    };
  }

  // ---- honest agent metrics (CCA-08) ----
  // uncached = input + output + cache_write (cache reads are billed at ~1 % of
  // input, so the all-tokens total is mostly cache volume). Per PASS = all
  // sessions of an arm / its passing sessions. Runs normalised since CCA-08
  // carry these in headline/aggregate; older full run files get them derived
  // here from arms.*.results, so the page never needs a re-publish.
  var ARM_KEYS = ['vanilla', 'cc', 'cc_guided'];
  function round1(x) {
    return Math.round(x * 10) / 10;
  }
  function savedOrNull(van, arm) {
    return isNum(van) && isNum(arm) && van > 0 ? round1(((van - arm) / van) * 100) : null;
  }
  function armFromResults(results) {
    var rs = arr(results);
    if (!rs.length) return null;
    var unc = 0;
    var passes = 0;
    var cost = 0;
    var costKnown = true;
    rs.forEach(function (x) {
      var t = isObj(x) && isObj(x.tokens) ? x.tokens : {};
      unc +=
        (isNum(t.input) ? t.input : 0) +
        (isNum(t.output) ? t.output : 0) +
        (isNum(t.cache_write) ? t.cache_write : 0);
      if (isObj(x) && x.success === true) passes++;
      if (isObj(x) && isNum(x.cost_usd)) cost += x.cost_usd;
      else costKnown = false;
    });
    return {
      sessions: rs.length,
      passes: passes,
      uncached_tokens: unc,
      cost_usd: costKnown ? Math.round(cost * 1e6) / 1e6 : null,
      uncached_per_pass: passes > 0 ? Math.round(unc / passes) : null,
    };
  }
  // Per-arm efficiency: aggregate.per_pass when present, else derived from sessions.
  function perPassOf(r) {
    var agg = isObj(r.aggregate) ? r.aggregate : {};
    if (isObj(agg.per_pass)) return agg.per_pass;
    var arms = isObj(r.arms) ? r.arms : {};
    var out = null;
    ARM_KEYS.forEach(function (k) {
      var a = isObj(arms[k]) ? armFromResults(arms[k].results) : null;
      if (a) (out = out || {})[k] = a;
    });
    return out;
  }
  function pick(h, k, fallback) {
    return Object.prototype.hasOwnProperty.call(h, k) ? h[k] : fallback;
  }
  function honestOf(r, h, agg) {
    var pp = perPassOf(r) || {};
    var v = pp.vanilla || {};
    var c = pp.cc || {};
    var g = pp.cc_guided || null;
    var cost = isObj(agg.cost_usd) ? agg.cost_usd : {};
    var vCost = isNum(v.cost_usd) ? v.cost_usd : isNum(cost.vanilla) ? cost.vanilla : null;
    var cCost = isNum(c.cost_usd) ? c.cost_usd : isNum(cost.cc) ? cost.cc : null;
    var gCost = g && isNum(g.cost_usd) ? g.cost_usd : isNum(cost.cc_guided) ? cost.cc_guided : null;
    var hp = isObj(h.uncached_per_pass) ? h.uncached_per_pass : null;
    var perPass = {
      vanilla: hp
        ? pick(hp, 'vanilla', null)
        : isNum(v.uncached_per_pass)
          ? v.uncached_per_pass
          : null,
      cc: hp ? pick(hp, 'cc', null) : isNum(c.uncached_per_pass) ? c.uncached_per_pass : null,
      cc_guided: hp
        ? pick(hp, 'cc_guided', null)
        : g && isNum(g.uncached_per_pass)
          ? g.uncached_per_pass
          : null,
    };
    var unc = isObj(agg.uncached_tokens) ? agg.uncached_tokens : {};
    var spreadOk = function (x) {
      return isObj(x) && isNum(x.min) && isNum(x.max) ? x : null;
    };
    return {
      uncachedSavedPct: isNum(h.uncached_saved_pct)
        ? h.uncached_saved_pct
        : isNum(unc.saved_pct)
          ? unc.saved_pct
          : savedOrNull(v.uncached_tokens, c.uncached_tokens),
      guidedUncachedSavedPct: isNum(h.guided_uncached_saved_pct)
        ? h.guided_uncached_saved_pct
        : isNum(unc.guided_saved_pct)
          ? unc.guided_saved_pct
          : g
            ? savedOrNull(v.uncached_tokens, g.uncached_tokens)
            : null,
      uncachedSpread: spreadOk(h.uncached_saved_spread) || spreadOk(unc.spread),
      guidedUncachedSpread: spreadOk(h.guided_uncached_saved_spread) || spreadOk(unc.guided_spread),
      costSavedPct: pick(h, 'cost_saved_pct', savedOrNull(vCost, cCost)),
      guidedCostSavedPct:
        g || isNum(h.guided_cost_saved_pct)
          ? pick(h, 'guided_cost_saved_pct', savedOrNull(vCost, gCost))
          : null,
      uncachedPerPass: perPass,
      perPass: isObj(pp) && Object.keys(pp).length ? pp : null,
      uncached: {
        vanilla: isNum(unc.vanilla)
          ? unc.vanilla
          : isNum(v.uncached_tokens)
            ? v.uncached_tokens
            : null,
        cc: isNum(unc.cc) ? unc.cc : isNum(c.uncached_tokens) ? c.uncached_tokens : null,
        cc_guided: isNum(unc.cc_guided)
          ? unc.cc_guided
          : g && isNum(g.uncached_tokens)
            ? g.uncached_tokens
            : null,
      },
    };
  }

  // Repeat number of a session: -rN in its events file, else its 1-based position.
  function repeatOf(x, i) {
    var m =
      isObj(x) && typeof x.events_path === 'string' ? /-r(\d+)\.jsonl$/.exec(x.events_path) : null;
    return m ? Number(m[1]) : i + 1;
  }
  function uncachedOfSession(x) {
    var t = isObj(x) && isObj(x.tokens) ? x.tokens : {};
    return (
      (isNum(t.input) ? t.input : 0) +
      (isNum(t.output) ? t.output : 0) +
      (isNum(t.cache_write) ? t.cache_write : 0)
    );
  }
  // Per-task uncached tokens of one arm + the paired delta vs vanilla
  // ({ pairs, saved_pct, min, max }) — from per_task when the run has it
  // (CCA-08), else derived from the sessions. Null parts when unknown.
  function taskHonestOf(run, row, armKey) {
    var r = isObj(run) && isObj(run.raw) ? run.raw : run;
    var cell = isObj(row) && isObj(row[armKey]) ? row[armKey] : {};
    var stored =
      isObj(row) && isObj(row.delta) && armKey !== 'vanilla' ? row.delta[armKey] : undefined;
    var arms = isObj(r) && isObj(r.arms) ? r.arms : {};
    var of = function (k) {
      return arr(isObj(arms[k]) ? arms[k].results : null).filter(function (x) {
        return isObj(x) && x.task_id === row.task_id;
      });
    };
    var mine = of(armKey);
    var uncached = isNum(cell.uncached_tokens)
      ? cell.uncached_tokens
      : mine.length
        ? mine.reduce(function (a, x) {
            return a + uncachedOfSession(x);
          }, 0)
        : null;
    var delta = null;
    if (stored !== undefined) delta = isObj(stored) ? stored : null;
    else if (armKey !== 'vanilla' && mine.length) {
      var byRep = {};
      mine.forEach(function (x, i) {
        byRep[repeatOf(x, i)] = x;
      });
      var pcts = [];
      var vs = 0;
      var as = 0;
      of('vanilla').forEach(function (x, i) {
        var y = byRep[repeatOf(x, i)];
        var vu = uncachedOfSession(x);
        if (!y || vu <= 0) return;
        var au = uncachedOfSession(y);
        vs += vu;
        as += au;
        pcts.push(round1(((vu - au) / vu) * 100));
      });
      if (pcts.length)
        delta = {
          pairs: pcts.length,
          saved_pct: round1(((vs - as) / vs) * 100),
          min: Math.min.apply(null, pcts),
          max: Math.max.apply(null, pcts),
        };
    }
    return { uncached: uncached, delta: delta };
  }

  function agentOf(run) {
    var r = isObj(run) && isObj(run.raw) ? run.raw : run;
    var kind = kindOf(r);
    if (!isAgentKind(kind)) return null;
    var agg = isObj(r.aggregate) ? r.aggregate : {};
    var arms = isObj(r.arms) ? r.arms : {};
    var cc = isObj(arms.cc) ? arms.cc : {};
    var h = isObj(r.headline) ? r.headline : {};
    var sr = isObj(agg.success_rate) ? agg.success_rate : {};
    var honest = honestOf(r, h, agg);
    return {
      model: typeof r.model === 'string' ? r.model : null,
      agentCli: isObj(r.agent_cli) ? r.agent_cli : null,
      fixture: typeof r.fixture === 'string' ? r.fixture : null,
      keyEnv: isObj(r.auth) && typeof r.auth.keyEnv === 'string' ? r.auth.keyEnv : null, // name only, never a value
      indexMs: isNum(cc.index_ms) ? cc.index_ms : null,
      dbBytes: isNum(cc.db_bytes) ? cc.db_bytes : null,
      taskDefs: arr(r.tasks),
      notes: arr(r.notes).filter(function (n) {
        return typeof n === 'string' && n;
      }),
      successVanillaPct: isNum(h.success_vanilla_pct)
        ? h.success_vanilla_pct
        : isNum(sr.vanilla)
          ? sr.vanilla * 100
          : null,
      successCcPct: isNum(h.success_cc_pct) ? h.success_cc_pct : isNum(sr.cc) ? sr.cc * 100 : null,
      tokensSavedPct:
        isObj(agg.tokens) && isNum(agg.tokens.saved_pct)
          ? agg.tokens.saved_pct
          : isNum(h.tokens_saved_pct)
            ? h.tokens_saved_pct
            : null,
      toolCallsSavedPct:
        isObj(agg.tool_calls) && isNum(agg.tool_calls.saved_pct)
          ? agg.tool_calls.saved_pct
          : isNum(h.tool_calls_saved_pct)
            ? h.tool_calls_saved_pct
            : null,
      // cc-guided arm (runs since 2026-10-11); null on older runs.
      successCcGuidedPct: isNum(h.success_cc_guided_pct) ? h.success_cc_guided_pct : null,
      guidedTokensSavedPct:
        isObj(agg.tokens) && isNum(agg.tokens.guided_saved_pct)
          ? agg.tokens.guided_saved_pct
          : null,
      mcpCalls: isObj(agg.mcp_tool_calls) ? agg.mcp_tool_calls : null,
      cost: isObj(agg.cost_usd) ? agg.cost_usd : null,
      tokens: isObj(agg.tokens) ? agg.tokens : null,
      toolCalls: isObj(agg.tool_calls) ? agg.tool_calls : null,
      wall: isObj(agg.wall_ms) ? agg.wall_ms : null,
      perTask: arr(agg.per_task),
      // Honest metrics (CCA-08); null when the run lacks the data.
      uncachedSavedPct: honest.uncachedSavedPct,
      guidedUncachedSavedPct: honest.guidedUncachedSavedPct,
      uncachedSpread: honest.uncachedSpread,
      guidedUncachedSpread: honest.guidedUncachedSpread,
      costSavedPct: isNum(honest.costSavedPct) ? honest.costSavedPct : null,
      guidedCostSavedPct: isNum(honest.guidedCostSavedPct) ? honest.guidedCostSavedPct : null,
      uncachedPerPass: honest.uncachedPerPass,
      perPass: honest.perPass,
      uncached: honest.uncached,
    };
  }

  function legacyOf(run) {
    var r = isObj(run) && isObj(run.raw) ? run.raw : run;
    if (kindOf(r) !== 'agent-claude') return null;
    return {
      nv: isObj(r.nv) ? r.nv : null,
      q: isObj(r.q) ? r.q : null,
      c: isObj(r.c) ? r.c : null,
      criteria: arr(r.criteria),
      s5: isObj(r.s5) ? r.s5 : null,
      notes: arr(r.notes).filter(function (n) {
        return typeof n === 'string' && n;
      }),
      fake: r.fake === true,
      valid: r.valid === true,
      trate: treatmentRate(r),
      prereg: isObj(r.prereg) ? r.prereg : null,
      preregVersion: preregVersion(r),
      cadence: r.kind === 'monthly' ? 'monthly' : r.kind === 'weekly' ? 'weekly' : null,
      n: isNum(r.n) ? r.n : null,
      storedVerdict: typeof r.verdict === 'string' ? r.verdict : null,
      verdict: verdictOf(r.nv),
      usable: legacyUsable(r),
    };
  }

  // ---- private-suite summaries (CCA-19): numbers only, under a public alias ----
  var PRIVATE_FILE_RE = /^private\/[a-z0-9][a-z0-9-]{0,59}\.json$/;

  /** Entries of data/private/index.json whose file path is a plain private/<slug>.json. */
  function privateIndexOf(raw) {
    return arr(isObj(raw) ? raw.summaries : null).filter(function (e) {
      return (
        isObj(e) &&
        typeof e.alias === 'string' &&
        typeof e.file === 'string' &&
        PRIVATE_FILE_RE.test(e.file)
      );
    });
  }

  function numOrNull(x) {
    return isNum(x) ? x : null;
  }

  /** A ccc-bench-private-summary/1 file, normalized; null when it is not one. */
  function privateSummaryOf(raw) {
    var schema = CFG.PRIVATE_SCHEMA || 'ccc-bench-private-summary/1';
    if (!isObj(raw) || raw.schema !== schema || typeof raw.alias !== 'string') return null;
    var sc = isObj(raw.scope) ? raw.scope : {};
    var block = function (b) {
      return {
        arms: isObj(b.arms) ? b.arms : {},
        saved: isObj(b.saved) ? b.saved : {},
        verdict: isObj(b.verdict) ? b.verdict : null,
      };
    };
    return {
      alias: raw.alias,
      generated: typeof raw.generated === 'string' ? raw.generated : null,
      version: typeof raw.code_context_version === 'string' ? raw.code_context_version : null,
      scope: {
        sources: numOrNull(sc.sources),
        files: numOrNull(sc.files),
        totalMb: numOrNull(sc.total_mb),
        tasks: numOrNull(sc.tasks),
        perGroup: isObj(sc.tasks_per_group) ? sc.tasks_per_group : {},
      },
      runs: arr(raw.runs)
        .filter(isObj)
        .map(function (r) {
          var b = block(r);
          return {
            model: typeof r.model === 'string' ? r.model : null,
            kind: typeof r.provider_kind === 'string' ? r.provider_kind : null,
            date: typeof r.date === 'string' ? r.date : null,
            repeats: numOrNull(r.repeats),
            arms: b.arms,
            saved: b.saved,
            verdict: blockVerdictOf(b, numOrNull(r.repeats) || 1),
            groups: arr(r.groups)
              .filter(isObj)
              .map(function (g) {
                var gb = block(g);
                return {
                  group: typeof g.group === 'string' ? g.group : '?',
                  tasks: numOrNull(g.tasks),
                  arms: gb.arms,
                  saved: gb.saved,
                  verdict: blockVerdictOf(gb, numOrNull(r.repeats) || 1),
                };
              }),
          };
        }),
    };
  }

  // ---- rule-based verdict (CCA-20) ----
  // Port of scripts/bench/lib/verdict.mts (the source of truth; read its
  // header for the rule). test/bench-verdict.test.ts runs both on the same
  // inputs and requires equal output, so the two can never drift. A run
  // normalised since CCA-20 carries headline.verdict and the page renders it;
  // older runs and summaries get it computed here from the same fields.
  var VERDICT_RULE = {
    minRepeats: 3,
    maxSuccessDropPp: 5,
    maxSlowerPct: 25,
    minSavedPctFewRepeats: 10,
    minIncreasePctFewRepeats: 10,
    smallEffectPct: 10,
  };
  var VERDICT_CODES = ['BENEFICIAL', 'NO_CLEAR_EFFECT', 'SUBOPTIMAL'];
  var VERDICT_LABELS = {
    BENEFICIAL: 'BENEFICIAL',
    NO_CLEAR_EFFECT: 'NO CLEAR EFFECT',
    SUBOPTIMAL: 'SUBOPTIMAL',
  };
  // Old stored codes (before #158) and the code they mean now.
  var LEGACY_VERDICT_CODES = { HARMFUL: 'SUBOPTIMAL' };
  var VERDICT_RANK = { BENEFICIAL: 2, NO_CLEAR_EFFECT: 1, SUBOPTIMAL: 0 };
  var VERDICT_PREFIX = { cc: 'Without guidance, ', cc_guided: 'With guidance, ' };

  function whole(x) {
    var r = Math.round(x);
    return r === 0 ? 0 : r;
  }
  function vSpread(x) {
    return isObj(x) && isNum(x.min) && isNum(x.max)
      ? { min: x.min, max: x.max, repeats: isNum(x.repeats) ? x.repeats : 0 }
      : null;
  }
  function armFacts(a, repeats) {
    var R = VERDICT_RULE;
    var delta =
      isNum(a.success_vanilla_pct) && isNum(a.success_arm_pct)
        ? round1(a.success_arm_pct - a.success_vanilla_pct)
        : 0;
    var sp = a.spread && isNum(a.spread.min) && isNum(a.spread.max) ? a.spread : null;
    // The spread decides with enough repeats; else the point estimate (both ways).
    var useSpread = repeats >= R.minRepeats && !!sp;
    var f = {
      successDropTooBig: delta < -R.maxSuccessDropPp,
      alwaysWorse: !!sp && sp.max < 0,
      tooSlow: isNum(a.wall_faster_pct) && a.wall_faster_pct < -R.maxSlowerPct,
      unstable: !!sp && sp.min <= 0 && sp.max >= 0,
      fewRepeatsWorse:
        !useSpread &&
        isNum(a.uncached_saved_pct) &&
        a.uncached_saved_pct <= -R.minIncreasePctFewRepeats,
      repeats: repeats,
      increasePct: isNum(a.uncached_saved_pct) ? whole(-a.uncached_saved_pct) : 0,
      code: 'NO_CLEAR_EFFECT',
    };
    if (f.successDropTooBig || f.alwaysWorse || f.fewRepeatsWorse || f.tooSlow)
      f.code = 'SUBOPTIMAL';
    else {
      var tokensOk = useSpread
        ? sp.min > 0
        : isNum(a.uncached_saved_pct) && a.uncached_saved_pct >= R.minSavedPctFewRepeats;
      var costOk = !isNum(a.cost_saved_pct) || a.cost_saved_pct >= 0;
      if (tokensOk && costOk) f.code = 'BENEFICIAL';
    }
    return f;
  }
  function factSentences(a, prefix) {
    var out = [];
    var subject = prefix ? prefix + 'code-context' : 'Code-context';
    if (isNum(a.uncached_saved_pct)) {
      var s = whole(a.uncached_saved_pct);
      out.push(
        s > 0
          ? subject + ' decreases the token use by ' + s + ' %.'
          : s < 0
            ? subject + ' increases the token use by ' + -s + ' %.'
            : subject + ' does not change the token use.',
      );
      subject = 'It';
    }
    if (isNum(a.cost_saved_pct)) {
      var c = whole(a.cost_saved_pct);
      out.push(
        c > 0
          ? subject + ' decreases the cost by ' + c + ' %.'
          : c < 0
            ? subject + ' increases the cost by ' + -c + ' %.'
            : subject + ' does not change the cost.',
      );
    }
    if (isNum(a.wall_faster_pct)) {
      var w = whole(a.wall_faster_pct);
      out.push(
        w > 0
          ? 'The tasks complete ' + w + ' % faster.'
          : w < 0
            ? 'The tasks complete ' + -w + ' % slower.'
            : 'The tasks complete in the same time.',
      );
    } else {
      out.push('The wall time is not known.');
    }
    if (isNum(a.success_vanilla_pct) && isNum(a.success_arm_pct)) {
      var v = whole(a.success_vanilla_pct);
      var r = whole(a.success_arm_pct);
      out.push(
        r > v
          ? 'The success rate increases from ' + v + ' % to ' + r + ' %.'
          : r < v
            ? 'The success rate decreases from ' + v + ' % to ' + r + ' %.'
            : 'The success rate is ' + v + ' % with and without code-context.',
      );
    }
    return out;
  }
  function warningSentences(f) {
    var R = VERDICT_RULE;
    var out = [];
    if (f.successDropTooBig)
      out.push(
        'The success rate decreases by more than ' + R.maxSuccessDropPp + ' percentage points.',
      );
    if (f.tooSlow) out.push('The tasks are more than ' + R.maxSlowerPct + ' % slower.');
    if (f.alwaysWorse) out.push('The token use increases in all repeats.');
    if (f.fewRepeatsWorse)
      out.push(
        'The token use increases by ' +
          f.increasePct +
          ' % in ' +
          f.repeats +
          (f.repeats === 1 ? ' repeat.' : ' repeats.'),
      );
    if (f.unstable) out.push('The result is not stable across repeats.');
    return out;
  }
  function headlineSentence(best, codes) {
    var code = codes[best];
    if (code === 'SUBOPTIMAL') return 'Result: code-context is suboptimal for these tasks.';
    if (code === 'NO_CLEAR_EFFECT') return 'Result: code-context shows no clear effect.';
    var both = codes.cc !== undefined && codes.cc_guided !== undefined;
    if (!both) return 'Result: code-context helps.';
    if (codes.cc === 'BENEFICIAL' && codes.cc_guided === 'BENEFICIAL')
      return 'Result: code-context helps with and without the instruction to use it.';
    return best === 'cc_guided'
      ? 'Result: code-context helps when the agent gets the instruction to use it.'
      : 'Result: code-context helps when the agent gets no instruction to use it.';
  }
  function otherArmSentences(key, a, f, bestCode) {
    var p = VERDICT_PREFIX[key];
    if (f.code === 'BENEFICIAL') {
      var out = [p + 'code-context also helps.'];
      if (isNum(a.uncached_saved_pct) && whole(a.uncached_saved_pct) > 0)
        out.push('It decreases the token use by ' + whole(a.uncached_saved_pct) + ' %.');
      return out;
    }
    if (f.code === 'SUBOPTIMAL')
      return [
        p + 'code-context is ' + (bestCode === 'SUBOPTIMAL' ? 'also ' : '') + 'suboptimal.',
      ].concat(warningSentences(f));
    var small =
      !isNum(a.uncached_saved_pct) || Math.abs(a.uncached_saved_pct) < VERDICT_RULE.smallEffectPct;
    return [p + 'the effect is ' + (small ? 'small' : 'not clear') + '.'];
  }

  /** Same contract as verdict.mts computeVerdict(input); null when no arm has data. */
  function computeVerdict(input) {
    if (!isObj(input)) return null;
    var repeats = isNum(input.repeats) && input.repeats > 0 ? Math.round(input.repeats) : 1;
    var keys = [];
    if (input.cc) keys.push('cc');
    if (input.cc_guided) keys.push('cc_guided');
    if (!keys.length) return null;
    var both = keys.length === 2;
    var facts = {};
    var codes = {};
    var arms = {};
    keys.forEach(function (k) {
      var f = armFacts(input[k], repeats);
      facts[k] = f;
      codes[k] = f.code;
      arms[k] = {
        code: f.code,
        sentences: factSentences(input[k], both ? VERDICT_PREFIX[k] : '').concat(
          warningSentences(f),
        ),
      };
    });
    var best = keys[0];
    keys.forEach(function (k) {
      if (VERDICT_RANK[codes[k]] >= VERDICT_RANK[codes[best]]) best = k;
    });
    var bestCode = codes[best];
    var indicative = repeats < VERDICT_RULE.minRepeats;
    var sentences = [headlineSentence(best, codes)].concat(arms[best].sentences);
    keys.forEach(function (k) {
      if (k !== best)
        sentences = sentences.concat(otherArmSentences(k, input[k], facts[k], bestCode));
    });
    if (indicative)
      sentences.push(
        'This result is indicative only: the run has ' +
          repeats +
          (repeats === 1 ? ' repeat.' : ' repeats.'),
      );
    return {
      code: bestCode,
      indicative: indicative,
      repeats: repeats,
      arm: best,
      arms: arms,
      sentences: sentences,
    };
  }

  function wallFasterPct(van, arm) {
    return isNum(van) && isNum(arm) && van > 0 ? round1(((van - arm) / van) * 100) : null;
  }

  // Port of normalizeVerdict (verdict.mts): a stored verdict with an old code
  // (HARMFUL, before #158) is read as SUBOPTIMAL with the current text.
  function legacyCode(c) {
    return typeof c === 'string' && Object.prototype.hasOwnProperty.call(LEGACY_VERDICT_CODES, c);
  }
  function legacySentence(t) {
    if (typeof t !== 'string') return t;
    if (t === 'Result: code-context makes the result worse.')
      return 'Result: code-context is suboptimal for these tasks.';
    var m = /^(.*)code-context (also )?makes the result worse\.$/.exec(t);
    return m ? m[1] + 'code-context is ' + (m[2] || '') + 'suboptimal.' : t;
  }
  function normalizeVerdict(x) {
    if (!isObj(x)) return null;
    var arms = isObj(x.arms) ? x.arms : {};
    var legacy =
      legacyCode(x.code) ||
      Object.keys(arms).some(function (k) {
        return isObj(arms[k]) && legacyCode(arms[k].code);
      });
    if (!legacy) return isRunVerdict(x) ? x : null;
    var out = {};
    Object.keys(x).forEach(function (k) {
      out[k] = x[k];
    });
    out.code = legacyCode(x.code) ? LEGACY_VERDICT_CODES[x.code] : x.code;
    out.arms = {};
    Object.keys(arms).forEach(function (k) {
      var a = isObj(arms[k]) ? arms[k] : {};
      var b = {};
      Object.keys(a).forEach(function (f) {
        b[f] = a[f];
      });
      if (legacyCode(a.code)) b.code = LEGACY_VERDICT_CODES[a.code];
      if (Array.isArray(a.sentences)) b.sentences = a.sentences.map(legacySentence);
      out.arms[k] = b;
    });
    if (Array.isArray(x.sentences)) out.sentences = x.sentences.map(legacySentence);
    return isRunVerdict(out) ? out : null;
  }

  /** A stored verdict that is safe to render as is. */
  function isRunVerdict(x) {
    return (
      isObj(x) &&
      VERDICT_CODES.indexOf(x.code) >= 0 &&
      typeof x.indicative === 'boolean' &&
      (x.arm === 'cc' || x.arm === 'cc_guided') &&
      Array.isArray(x.sentences) &&
      x.sentences.every(function (t) {
        return typeof t === 'string';
      })
    );
  }

  // Repeats per task and arm: the highest vanilla session count of any task.
  function repeatsOfRun(r) {
    var arms = isObj(r.arms) ? r.arms : {};
    var counts = {};
    var max = 0;
    arr(isObj(arms.vanilla) ? arms.vanilla.results : null).forEach(function (x) {
      if (!isObj(x) || typeof x.task_id !== 'string') return;
      counts[x.task_id] = (counts[x.task_id] || 0) + 1;
      if (counts[x.task_id] > max) max = counts[x.task_id];
    });
    return max;
  }

  /**
   * Verdict input of an agent run (full run or index entry): success, uncached
   * saving, spread, cost and wall time per code-context arm. Null when the run
   * has no success rates or no uncached-token figure (pre-CCA-08).
   */
  function agentVerdictInputOf(run) {
    var r = isObj(run) && isObj(run.raw) ? run.raw : run;
    if (!isObj(r) || !isAgentKind(kindOf(r))) return null;
    var a = agentOf(r);
    if (!a || !isNum(a.successVanillaPct) || !isNum(a.successCcPct) || !isNum(a.uncachedSavedPct))
      return null;
    var w = a.wall || {};
    var cc = {
      success_vanilla_pct: a.successVanillaPct,
      success_arm_pct: a.successCcPct,
      uncached_saved_pct: isNum(a.uncachedSavedPct) ? a.uncachedSavedPct : null,
      spread: vSpread(a.uncachedSpread),
      cost_saved_pct: a.costSavedPct,
      wall_faster_pct: wallFasterPct(w.vanilla_mean, w.cc_mean),
    };
    var g = isNum(a.successCcGuidedPct)
      ? {
          success_vanilla_pct: a.successVanillaPct,
          success_arm_pct: a.successCcGuidedPct,
          uncached_saved_pct: isNum(a.guidedUncachedSavedPct) ? a.guidedUncachedSavedPct : null,
          spread: vSpread(a.guidedUncachedSpread),
          cost_saved_pct: a.guidedCostSavedPct,
          wall_faster_pct: wallFasterPct(w.vanilla_mean, w.cc_guided_mean),
        }
      : null;
    var fromSpread = Math.max(
      cc.spread ? cc.spread.repeats : 0,
      g && g.spread ? g.spread.repeats : 0,
    );
    var input = { repeats: repeatsOfRun(r) || fromSpread || 1, cc: cc };
    if (g) input.cc_guided = g;
    return input;
  }

  /**
   * Verdict of an agent run (full run or index entry): headline.verdict when
   * the run carries one, else computed from its headline, wall means and
   * repeats. Null when the run has no success rates.
   */
  function agentVerdictOf(run) {
    var r = isObj(run) && isObj(run.raw) ? run.raw : run;
    if (!isObj(r) || !isAgentKind(kindOf(r))) return null;
    var h = isObj(r.headline) ? r.headline : {};
    var stored = normalizeVerdict(h.verdict);
    if (stored) return stored;
    // No uncached-token figure (a pre-CCA-08 entry without sessions): no verdict.
    var input = agentVerdictInputOf(r);
    return input ? computeVerdict(input) : null;
  }

  /** Verdict input of a private-summary block ({ arms, saved }); null without vanilla success. */
  function blockVerdictInputOf(block, repeats) {
    if (!isObj(block)) return null;
    var arms = isObj(block.arms) ? block.arms : {};
    var saved = isObj(block.saved) ? block.saved : {};
    var v = isObj(arms.vanilla) ? arms.vanilla : {};
    if (!isNum(v.success_pct)) return null;
    function arm(k) {
      var x = isObj(arms[k]) ? arms[k] : {};
      var sv = isObj(saved[k]) ? saved[k] : null;
      if (!isNum(x.success_pct) || !sv) return null;
      return {
        success_vanilla_pct: v.success_pct,
        success_arm_pct: x.success_pct,
        uncached_saved_pct: isNum(sv.uncached_saved_pct) ? sv.uncached_saved_pct : null,
        spread: vSpread(sv.uncached_saved_spread),
        cost_saved_pct: isNum(sv.cost_saved_pct) ? sv.cost_saved_pct : null,
        wall_faster_pct: wallFasterPct(v.wall_mean_ms, x.wall_mean_ms),
      };
    }
    var input = { repeats: isNum(repeats) && repeats > 0 ? repeats : 1, cc: arm('cc') };
    var g = arm('cc_guided');
    if (g) input.cc_guided = g;
    return input;
  }

  /** Verdict of a private-summary block ({ arms, saved, verdict? }); same rule. */
  function blockVerdictOf(block, repeats) {
    if (!isObj(block)) return null;
    var stored = normalizeVerdict(block.verdict);
    if (stored) return stored;
    var input = blockVerdictInputOf(block, repeats);
    return input ? computeVerdict(input) : null;
  }

  // Port of verdictSummary() in scripts/bench/lib/verdict.mts (#160): the
  // result sentence and its main reason, both taken from the verdict as is.
  var WARNING_RE =
    /^The (success rate decreases by more than |tasks are more than |token use increases (in all repeats|by \d+ % in )|result is not stable across repeats)/;
  function verdictSummary(v) {
    if (!isObj(v) || !Array.isArray(v.sentences) || v.sentences.length === 0) return [];
    var head = v.sentences[0];
    var rest = v.sentences.slice(1);
    var warning =
      v.code === 'BENEFICIAL'
        ? undefined
        : rest.filter(function (t) {
            return WARNING_RE.test(t);
          })[0];
    var reason = warning || rest[0];
    return reason ? [head, reason] : [head];
  }

  // ---- latest run: one row per model (#160) ----
  var MODEL_ROWS = [
    { kind: 'agent-glm', label: 'GLM' },
    { kind: 'agent-opus', label: 'Opus' },
    { kind: 'agent-deepseek', label: 'DeepSeek' },
  ];

  /**
   * "Latest run" per agent model (GLM, Opus, DeepSeek), one pick each:
   * the newest private-suite summary run of that model when its date is
   * NEWER than the newest public run of that model, else the newest public
   * run. Dates compare as YYYY-MM-DD (summaries carry no time); on the same
   * day the public run wins, because anyone can rerun it. `runs` is the
   * public index sorted newest first (sortRunsDesc), `summaries` the
   * normalized private summaries (privateSummaryOf).
   * A pick is { kind, label, source: 'public'|'private', date, suite, run? | block? }.
   */
  function latestPerModel(runs, summaries) {
    var out = [];
    MODEL_ROWS.forEach(function (m) {
      var pub = null;
      arr(runs).forEach(function (r) {
        if (!pub && isObj(r) && r.kind === m.kind) pub = r; // runs are newest first
      });
      var priv = null;
      arr(summaries).forEach(function (s) {
        if (!isObj(s)) return;
        arr(s.runs).forEach(function (b) {
          if (!isObj(b) || b.kind !== m.kind || typeof b.date !== 'string') return;
          if (!priv || b.date > priv.block.date) priv = { block: b, suite: s.alias };
        });
      });
      var pubDate = pub ? String(pub.date || pub.ts || '').slice(0, 10) : '';
      if (priv && (!pub || priv.block.date > pubDate)) {
        out.push({
          kind: m.kind,
          label: m.label,
          source: 'private',
          date: priv.block.date,
          suite: priv.suite,
          block: priv.block,
        });
      } else if (pub) {
        out.push({
          kind: m.kind,
          label: m.label,
          source: 'public',
          date: pubDate,
          suite: null,
          run: pub,
        });
      }
    });
    return out;
  }

  /**
   * The table row of one pick: the verdict and the numbers of the verdict's
   * best arm (success vanilla → arm, uncached saving, cost saving, speed).
   * `full` is the loaded run file of a public pick (wall times live there);
   * without it the index entry is used.
   */
  function simpleRowOf(pick, full) {
    var input = null;
    var verdict = null;
    if (pick.source === 'private') {
      input = blockVerdictInputOf(pick.block, pick.block.repeats);
      // Same normalization as blockVerdictOf: an old code (HARMFUL) reads as SUBOPTIMAL.
      verdict = normalizeVerdict(pick.block.verdict) || (input ? computeVerdict(input) : null);
    } else {
      var run = full || pick.run;
      input = agentVerdictInputOf(run);
      verdict = agentVerdictOf(run);
    }
    // Only a code-context arm is "with code-context"; never vanilla.
    var best =
      verdict && (verdict.arm === 'cc' || verdict.arm === 'cc_guided') ? verdict.arm : 'cc';
    var a = input ? input[best] || input.cc || null : null;
    return {
      kind: pick.kind,
      label: pick.label,
      source: pick.source,
      date: pick.date,
      suite: pick.suite,
      verdict: verdict,
      successVanillaPct: a ? a.success_vanilla_pct : null,
      successArmPct: a ? a.success_arm_pct : null,
      tokensSavedPct: a ? a.uncached_saved_pct : null,
      costSavedPct: a ? a.cost_saved_pct : null,
      fasterPct: a ? a.wall_faster_pct : null,
      repeats: verdict ? verdict.repeats : input ? input.repeats : null,
      summary: verdictSummary(verdict),
    };
  }

  function kindMeta(kind) {
    var k = CFG.KINDS || {};
    return isObj(k[kind]) ? k[kind] : null;
  }

  window.BenchData = {
    isLegacy: isLegacy,
    kindOf: kindOf,
    isAgentKind: isAgentKind,
    normalizeRun: normalizeRun,
    sortRunsDesc: sortRunsDesc,
    historyOf: historyOf,
    headlineOf: headlineOf,
    verdictOf: verdictOf,
    treatmentRate: treatmentRate,
    isInvalid: isInvalid,
    legacyUsable: legacyUsable,
    simulatedOf: simulatedOf,
    agentOf: agentOf,
    taskHonestOf: taskHonestOf,
    legacyOf: legacyOf,
    kindMeta: kindMeta,
    privateIndexOf: privateIndexOf,
    privateSummaryOf: privateSummaryOf,
    VERDICT_RULE: VERDICT_RULE,
    VERDICT_LABELS: VERDICT_LABELS,
    computeVerdict: computeVerdict,
    isRunVerdict: isRunVerdict,
    normalizeVerdict: normalizeVerdict,
    agentVerdictOf: agentVerdictOf,
    agentVerdictInputOf: agentVerdictInputOf,
    blockVerdictOf: blockVerdictOf,
    blockVerdictInputOf: blockVerdictInputOf,
    verdictSummary: verdictSummary,
    latestPerModel: latestPerModel,
    simpleRowOf: simpleRowOf,
  };
})();
