import type Database from "better-sqlite3";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { sprintPulse } from "../cards.js";
import { getSprintById } from "../queries.js";
import {
  autoApplyRetroActions,
  buildSprintPulseData,
  clusterRecurringIssues,
  fenceCard,
  getScopeDeltas,
  truncateFinding,
} from "../tools.js";
import type { BlockerRow, BugRow, RetroFindingRow, SprintRow, TicketRow } from "../rows.js";
import { errorMessage } from "../rows.js";

/** `SELECT * FROM agent_mood_history` joined with the agent and sprint names. */
interface MoodTrendRow {
  id: number;
  agent_id: number;
  sprint_id: number;
  mood: number;
  workload_points: number | null;
  notes: string | null;
  created_at: string;
  agent_name: string;
  sprint_name: string;
}

/** `SELECT * FROM token_usage`. */
interface TokenUsageRow {
  id: number;
  session_id: string | null;
  sprint_id: number | null;
  ticket_id: number | null;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  tool_calls: number;
  duration_sec: number | null;
  label: string | null;
  created_at: string;
}

/** `SELECT * FROM velocity_trends` (view). */
interface VelocityTrendRow {
  sprint_id: number;
  sprint_name: string;
  status: string;
  committed: number | null;
  completed: number | null;
  completion_rate: number;
  tickets_done: number;
  tickets_total: number;
  bugs_found: number;
  bugs_fixed: number;
  start_date: string | null;
  end_date: string | null;
  created_at: string;
}

/**
 * Analytics/reporting MCP tools extracted from registerScrumTools (T-268).
 * Every handler is byte-identical to its prior inline definition; the only
 * dependencies are module-level helpers imported from tools.js and queries.js.
 */
export function registerAnalyticsTools(server: McpServer, db: Database.Database): void {

  server.tool(
    "export_sprint_report",
    "Generate a complete markdown sprint report",
    { sprint_id: z.number().describe("Sprint ID") },
    async ({ sprint_id }) => {
      const sprint = getSprintById(db, sprint_id);
      if (!sprint) return { content: [{ type: "text" as const, text: `Sprint ${sprint_id} not found.` }] };
      const tickets = db.prepare(`SELECT * FROM tickets WHERE sprint_id=? ORDER BY priority, status`).all(sprint_id) as TicketRow[];
      const retro = db.prepare(`SELECT * FROM retro_findings WHERE sprint_id=? ORDER BY category`).all(sprint_id) as RetroFindingRow[];
      const bugs = db.prepare(`SELECT * FROM bugs WHERE sprint_id=?`).all(sprint_id) as BugRow[];
      const blockers = db.prepare(`SELECT * FROM blockers WHERE sprint_id=?`).all(sprint_id) as BlockerRow[];

      const totalPts = tickets.reduce((s: number, t) => s + (t.story_points || 0), 0);
      const donePts = tickets.filter((t) => t.status === 'DONE').reduce((s: number, t) => s + (t.story_points || 0), 0);
      const deltas = getScopeDeltas(db, sprint_id);

      const lines = [
        `# Sprint Report: ${sprint.name}`,
        `**Status:** ${sprint.status} | **Goal:** ${sprint.goal || '—'}`,
        `**Velocity:** ${donePts}/${totalPts} points in scope (${sprint.velocity_completed || 0}/${sprint.velocity_committed || 0} vs frozen commitment)${deltas.addedTickets ? ` | **+${deltas.addedPoints}pt added mid-sprint** (${deltas.addedTickets} tickets)` : ''}${deltas.removedTickets ? ` | ${deltas.removedTickets} removed` : ''}`,
        '',
        `## Tickets (${tickets.length})`,
        '| Ref | Title | Priority | Status | Assignee | Points | QA |',
        '|-----|-------|----------|--------|----------|--------|----|',
        ...tickets.map((t) => `| ${t.ticket_ref || '#' + t.id} | ${t.title} | ${t.priority} | ${t.status} | ${t.assigned_to || '—'} | ${t.story_points || 0} | ${t.qa_verified ? 'Yes' : 'No'} |`),
        '',
      ];

      if (bugs.length) {
        lines.push(`## Bugs (${bugs.length})`);
        bugs.forEach((b) => lines.push(`- [${b.status}] ${b.severity}: ${b.description}`));
        lines.push('');
      }
      if (blockers.length) {
        lines.push(`## Blockers (${blockers.length})`);
        blockers.forEach((b) => lines.push(`- [${b.status}] ${b.description}`));
        lines.push('');
      }
      if (retro.length) {
        lines.push(`## Retrospective (${retro.length} findings)`);
        ['went_well', 'went_wrong', 'try_next'].forEach(cat => {
          const items = retro.filter((f) => f.category === cat);
          if (items.length) {
            lines.push(`### ${cat.replace('_', ' ')}`);
            items.forEach((f) => lines.push(`- ${f.finding} (${f.role || 'team'})`));
          }
        });
      }

      return { content: [{ type: "text" as const, text: lines.join('\n') }] };
    }
  );

  server.tool(
    "analyze_retro_patterns",
    "Analyze retrospective findings across all sprints — category breakdown, recurring issues, and action follow-through rate",
    {},
    async () => {
      try {
        // Total findings count
        const totalRow = db.prepare(`SELECT COUNT(*) as total FROM retro_findings`).get() as { total: number };
        const total = totalRow.total;
        if (total === 0) return { content: [{ type: "text" as const, text: "No retro findings to analyze." }] };

        // Category breakdown
        const categories = db.prepare(`SELECT category, COUNT(*) as count FROM retro_findings GROUP BY category ORDER BY count DESC`).all() as Array<{ category: string; count: number }>;

        // A1: auto-apply adopted findings whose ticket landed, then compute lifecycle stats
        autoApplyRetroActions(db);
        const lc = db.prepare(`
          SELECT
            SUM(CASE WHEN status = 'open' THEN 1 ELSE 0 END) as open,
            SUM(CASE WHEN status = 'adopted' THEN 1 ELSE 0 END) as adopted,
            SUM(CASE WHEN status = 'adopted' AND action_applied = 1 THEN 1 ELSE 0 END) as applied,
            SUM(CASE WHEN status = 'dropped' THEN 1 ELSE 0 END) as dropped,
            COUNT(*) as total
          FROM retro_findings WHERE category = 'try_next'
        `).get() as { open: number; adopted: number; applied: number; dropped: number; total: number }; // SUMs are NULL only when total = 0
        const oldestOpen = db.prepare(`
          SELECT MAX((SELECT COUNT(*) FROM sprints s2 WHERE s2.id > rf.sprint_id AND s2.deleted_at IS NULL)) as age
          FROM retro_findings rf WHERE rf.category = 'try_next' AND rf.status = 'open'
        `).get() as { age: number | null } | undefined;
        const triageRate = lc.total > 0 ? Math.round(((lc.adopted + lc.dropped) / lc.total) * 100) : 0;
        const appliedRate = lc.total > 0 ? Math.round((lc.applied / lc.total) * 100) : 0;

        // A4: recurring-issue clustering — findings (not words), across distinct sprints
        const wrongFindings = db.prepare(`SELECT rf.finding, rf.sprint_id, rf.role, s.name as sprint_name FROM retro_findings rf JOIN sprints s ON rf.sprint_id = s.id WHERE rf.category = 'went_wrong'`).all() as Array<Pick<RetroFindingRow, "finding" | "sprint_id" | "role"> & { sprint_name: string }>;
        const clusters = clusterRecurringIssues(wrongFindings);
        const topWords = clusters.slice(0, 5).map(c =>
          `**${c.term}** — ${c.findingCount} finding(s) across ${c.sprintCount} sprints (${c.sprints.join(", ")})${c.roles.length ? ` [${c.roles.join(", ")}]` : ""}\n   e.g. ${truncateFinding(c.example, 160)}`);

        // Build report
        const lines = [
          `# Retro Pattern Analysis`,
          ``,
          `**Total findings:** ${total}`,
          ``,
          `## Category Breakdown`,
          ...categories.map((c) => `- **${c.category}**: ${c.count} (${Math.round((c.count / total) * 100)}%)`),
          ``,
          `## Action Follow-Through (try_next lifecycle)`,
          `- open: ${lc.open || 0}${lc.open > 0 && oldestOpen?.age != null ? ` (oldest: ${oldestOpen.age} sprints)` : ""} | adopted: ${lc.adopted || 0} (${lc.applied || 0} applied) | dropped: ${lc.dropped || 0}`,
          `- Triage rate (decided): ${triageRate}%`,
          `- Applied rate (adopted & shipped): ${appliedRate}%`,
          ``,
          `## Top Recurring Issues (went_wrong)`,
          wrongFindings.length === 0 ? "No went_wrong findings yet." : (topWords.length > 0 ? topWords.map((t, i) => `${i + 1}. ${t}`).join("\n") : "Not enough data for patterns."),
        ];

        return { content: [{ type: "text" as const, text: lines.join("\n") }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error: ${errorMessage(e)}` }], isError: true };
      }
    }
  );

  server.tool(
    "get_burndown",
    "Get burndown data for a sprint — daily snapshots of remaining vs completed points",
    {
      sprint_id: z.number().describe("Sprint ID"),
      format: z.enum(["text", "card"]).optional().describe("card = diff-fence pulse card (sparkline) above the daily rows"),
      verbose: z.boolean().optional().describe("All daily rows (default: last 5 — C1 token diet)"),
    },
    async ({ sprint_id, format, verbose }) => {
      try {
        const sprint = db.prepare(`SELECT name, velocity_committed FROM sprints WHERE id = ?`).get(sprint_id) as Pick<SprintRow, "name" | "velocity_committed"> | undefined;
        if (!sprint) return { content: [{ type: "text" as const, text: "Sprint not found" }], isError: true };
        const rows = db.prepare(`SELECT date, remaining_points, completed_points, added_points, removed_points FROM sprint_metrics WHERE sprint_id = ? ORDER BY date`).all(sprint_id) as Array<{ date: string; remaining_points: number; completed_points: number; added_points: number; removed_points: number }>;
        if (rows.length === 0) return { content: [{ type: "text" as const, text: `No burndown data for ${sprint.name}. Use snapshot_sprint_metrics to capture data points.` }] };
        const shown = verbose ? rows : rows.slice(-5);
        const lines = shown.map((r) => `${r.date}: ${r.completed_points}pts done, ${r.remaining_points}pts remaining${r.added_points ? ` (+${r.added_points} added)` : ""}${r.removed_points ? ` (-${r.removed_points} removed)` : ""}`);
        if (!verbose && rows.length > shown.length) lines.unshift(`(${rows.length - shown.length} earlier snapshots hidden — verbose=true for all)`);
        const pulse = format === "card" ? buildSprintPulseData(db, sprint_id) : null;
        const cardBlock = pulse ? fenceCard(sprintPulse(pulse)) + "\n" : "";
        return { content: [{ type: "text" as const, text: `${cardBlock}# Burndown: ${sprint.name}\nCommitted: ${sprint.velocity_committed}pts\n\n${lines.join("\n")}` }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error: ${errorMessage(e)}` }], isError: true };
      }
    }
  );

  server.tool(
    "get_time_report",
    "Get time tracking report for a sprint — estimated vs actual hours per agent",
    {
      sprint_id: z.number().describe("Sprint ID"),
    },
    async ({ sprint_id }) => {
      try {
        const rows = db.prepare(`
          SELECT assigned_to, COUNT(*) as tickets,
            SUM(estimated_hours) as total_estimated, SUM(actual_hours) as total_actual,
            CASE WHEN SUM(estimated_hours) > 0 THEN ROUND(SUM(actual_hours) / SUM(estimated_hours) * 100, 1) ELSE NULL END as accuracy_pct
          FROM tickets WHERE sprint_id = ? AND deleted_at IS NULL GROUP BY assigned_to ORDER BY assigned_to
        `).all(sprint_id) as Array<{ assigned_to: string | null; tickets: number; total_estimated: number | null; total_actual: number | null; accuracy_pct: number | null }>;
        if (rows.length === 0) return { content: [{ type: "text" as const, text: "No time data for this sprint." }] };
        const lines = rows.map((r) => `- **${r.assigned_to}**: ${r.tickets} tickets, est ${r.total_estimated || 0}h, actual ${r.total_actual || 0}h${r.accuracy_pct ? ` (${r.accuracy_pct}% accuracy)` : ""}`);
        const totEst = rows.reduce((s: number, r) => s + (r.total_estimated || 0), 0);
        const totAct = rows.reduce((s: number, r) => s + (r.total_actual || 0), 0);
        return { content: [{ type: "text" as const, text: `# Time Report\n\n${lines.join("\n")}\n\n**Total:** est ${totEst}h, actual ${totAct}h` }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error: ${errorMessage(e)}` }], isError: true };
      }
    }
  );

  server.tool(
    "get_mood_trends",
    "Get mood history for an agent or all agents — detects burnout patterns",
    {
      agent_id: z.number().optional().describe("Agent ID (omit for all agents)"),
      last_n_sprints: z.number().optional().describe("Number of recent sprints (default 5)"),
    },
    async ({ agent_id, last_n_sprints }) => {
      try {
        const limit = last_n_sprints || 5;
        let rows: MoodTrendRow[];
        if (agent_id) {
          rows = db.prepare(`
            SELECT m.*, a.name as agent_name, s.name as sprint_name
            FROM agent_mood_history m
            JOIN agents a ON m.agent_id = a.id
            JOIN sprints s ON m.sprint_id = s.id
            WHERE m.agent_id = ?
            ORDER BY s.created_at DESC LIMIT ?
          `).all(agent_id, limit) as MoodTrendRow[];
        } else {
          rows = db.prepare(`
            SELECT m.*, a.name as agent_name, s.name as sprint_name
            FROM agent_mood_history m
            JOIN agents a ON m.agent_id = a.id
            JOIN sprints s ON m.sprint_id = s.id
            ORDER BY a.name, s.created_at DESC
          `).all() as MoodTrendRow[];
        }
        if (rows.length === 0) return { content: [{ type: "text" as const, text: "No mood data recorded. Use record_mood to start tracking." }] };

        // Detect burnout: mood ≤ 2 for 2+ consecutive sprints
        const byAgent = new Map<string, MoodTrendRow[]>();
        rows.forEach((r) => { const arr = byAgent.get(r.agent_name) || []; arr.push(r); byAgent.set(r.agent_name, arr); });
        const alerts: string[] = [];
        byAgent.forEach((moods, name) => {
          const consecutive = moods.filter((m) => m.mood <= 2).length;
          if (consecutive >= 2) alerts.push(`🔴 **${name}** — mood ≤ 2 for ${consecutive} sprints — BURNOUT RISK`);
        });

        const lines = rows.map((r) => `- ${r.agent_name} @ ${r.sprint_name}: mood ${r.mood}/5, ${r.workload_points}pts${r.notes ? ` — ${r.notes}` : ""}`);
        return { content: [{ type: "text" as const, text: `# Mood Trends\n\n${alerts.length > 0 ? alerts.join("\n") + "\n\n" : ""}${lines.join("\n")}` }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error: ${errorMessage(e)}` }], isError: true };
      }
    }
  );

  server.tool(
    "get_token_usage",
    "Get token usage history, optionally filtered by sprint or ticket",
    {
      sprint_id: z.number().optional().describe("Filter by sprint"),
      ticket_id: z.number().optional().describe("Filter by ticket"),
    },
    async ({ sprint_id, ticket_id }) => {
      try {
        let rows: TokenUsageRow[];
        if (ticket_id) {
          rows = db.prepare(`SELECT * FROM token_usage WHERE ticket_id = ? ORDER BY created_at DESC`).all(ticket_id) as TokenUsageRow[];
        } else if (sprint_id) {
          rows = db.prepare(`SELECT * FROM token_usage WHERE sprint_id = ? ORDER BY created_at DESC`).all(sprint_id) as TokenUsageRow[];
        } else {
          rows = db.prepare(`SELECT * FROM token_usage ORDER BY created_at DESC LIMIT 50`).all() as TokenUsageRow[];
        }
        if (rows.length === 0) return { content: [{ type: "text" as const, text: "No token usage recorded. Use log_token_usage to start tracking." }] };
        const totalIn = rows.reduce((s: number, r) => s + r.input_tokens, 0);
        const totalOut = rows.reduce((s: number, r) => s + r.output_tokens, 0);
        const lines = rows.map((r) => `- ${r.label || "unlabeled"}: ${r.total_tokens.toLocaleString()} tokens (${r.input_tokens.toLocaleString()} in + ${r.output_tokens.toLocaleString()} out), ${r.tool_calls} calls${r.duration_sec ? `, ${Math.round(r.duration_sec / 60)}m` : ""}`);
        return { content: [{ type: "text" as const, text: `# Token Usage (${rows.length} records)\nTotal: ${(totalIn + totalOut).toLocaleString()} tokens\n\n${lines.join("\n")}` }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error: ${errorMessage(e)}` }], isError: true };
      }
    }
  );

  server.tool(
    "get_velocity_trends",
    "Get velocity trend data across sprints — committed vs completed, completion rate, bugs",
    {
      last_n_sprints: z.number().optional().describe("Number of recent sprints (default 10)"),
      status: z.string().optional().describe("Filter by sprint status (e.g. 'closed')"),
    },
    async ({ last_n_sprints, status }) => {
      try {
        let sql = `SELECT * FROM velocity_trends`;
        const params: Array<string | number> = [];
        if (status) { sql += ` WHERE status = ?`; params.push(status); }
        sql += ` LIMIT ?`;
        params.push(last_n_sprints || 10);
        const rows = db.prepare(sql).all(...params) as VelocityTrendRow[];
        if (rows.length === 0) return { content: [{ type: "text" as const, text: "No velocity data available." }] };
        // A3: completion is measured against the frozen commitment; scope changes shown explicitly
        const lines = rows.map((r) => {
          const deltas = getScopeDeltas(db, r.sprint_id);
          const scope = deltas.addedTickets > 0 || deltas.removedTickets > 0
            ? ` | scope: +${deltas.addedPoints}pt added (${deltas.addedTickets})${deltas.removedTickets ? `, ${deltas.removedTickets} removed` : ""}`
            : "";
          return `- **${r.sprint_name}** [${r.status}]: ${r.completed}/${r.committed}pts committed (${r.completion_rate}%)${scope}, ${r.tickets_done}/${r.tickets_total} tickets, ${r.bugs_found} bugs (${r.bugs_fixed} fixed)`;
        });
        const avgRate = rows.length > 0 ? Math.round(rows.reduce((s: number, r) => s + r.completion_rate, 0) / rows.length) : 0;
        return { content: [{ type: "text" as const, text: `# Velocity Trends (${rows.length} sprints)\nAvg completion vs frozen commitment: ${avgRate}%\n\n${lines.join("\n")}` }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error: ${errorMessage(e)}` }], isError: true };
      }
    }
  );
}
