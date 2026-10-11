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

  function agentOf(run) {
    var r = isObj(run) && isObj(run.raw) ? run.raw : run;
    var kind = kindOf(r);
    if (!isAgentKind(kind)) return null;
    var agg = isObj(r.aggregate) ? r.aggregate : {};
    var arms = isObj(r.arms) ? r.arms : {};
    var cc = isObj(arms.cc) ? arms.cc : {};
    var h = isObj(r.headline) ? r.headline : {};
    var sr = isObj(agg.success_rate) ? agg.success_rate : {};
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
    headlineOf: headlineOf,
    verdictOf: verdictOf,
    treatmentRate: treatmentRate,
    isInvalid: isInvalid,
    legacyUsable: legacyUsable,
    simulatedOf: simulatedOf,
    agentOf: agentOf,
    legacyOf: legacyOf,
    kindMeta: kindMeta,
  };
})();
