# vlm-code-context-mcp — User Guide

Complete guide to using the Code Context MCP server with your AI coding assistant.

---

## Table of Contents

1. [Quick Start](#quick-start)
2. [Installation](#installation)
3. [First-Time Setup](#first-time-setup)
4. [Understanding the Dashboard](#understanding-the-dashboard)
5. [Your First Sprint](#your-first-sprint)
6. [Common Workflows](#common-workflows)
7. [Troubleshooting](#troubleshooting)
8. [Best Practices](#best-practices)

---

## Quick Start

Get up and running in under 5 minutes:

```bash
# 1. Install
npm install vlm-code-context-mcp

# 2. Set up your project
npx code-context-mcp setup .

# 3. Start the dashboard
npx code-context-dashboard ./context.db

# Dashboard opens at http://localhost:3333
```

That's it! Your codebase is now indexed and ready for AI-assisted development.

---

## Installation

### Prerequisites

- Node.js 20, 22, or 24
- npm or yarn
- An AI client that supports MCP (Claude Code, Cline, Continue.dev, etc.)

### Install via npm

```bash
npm install vlm-code-context-mcp
```

### Verify Installation

```bash
npx code-context-mcp --help
```

You should see the setup and dashboard commands listed.

---

## First-Time Setup

### Step 1: Initialize Your Project

Run the setup command in your project root:

```bash
npx code-context-mcp setup .
```

This creates:

- `context.db` — SQLite database with indexed code
- `.mcp.json` — MCP client configuration
- `.claude/settings.json` — bridge hook (PreToolUse) so slash commands work
- `.claude/commands/*.md` — slash command definitions (`/kickoff`, `/sprint`, `/ticket`, `/milestone`, `/retro`)

**Expected output:**

```
=== Code Context MCP — Setup (my-project) ===

[1/6] Initializing database...
[2/6] Indexing target directory...
  Indexed 174 files, 328 exports, 59 dependencies.
[3/6] Seeding factory defaults...
  Seeded 9 agents, 5 skills
[4/6] Configuring MCP client...
  Wrote .mcp.json
[5/6] Configuring bridge hook...
  Bridge hook configured in .claude/settings.json
[6/6] Installing Claude commands...
  Commands installed to .claude/commands/

=== Setup complete! (my-project) ===
```

### Step 2: Restart Your AI Client

After setup, **restart your AI client** (Claude Code, VS Code, etc.) to load the new MCP tools.

### Step 3: Verify Tools Are Loaded

Ask your AI assistant:

> "Call `get_project_status`"

You should see a response like:

```
Files indexed: 174
Agents: 9
Sprints: 0
Tickets: 0
Skills: 5
Project is set up and ready.
```

---

## Understanding the Dashboard

The dashboard provides a live view of your project's scrum process. Open it with:

```bash
npx code-context-dashboard ./context.db
```

Navigate to `http://localhost:3333`

### Dashboard Tabs

| Tab           | Description                                                                                        |
| ------------- | -------------------------------------------------------------------------------------------------- |
| **Dashboard** | Sprint overview and activity feed; includes a Kanban board sub-tab for tickets organized by status |
| **Planning**  | Interactive wizard for sprint planning                                                             |
| **Code**      | Codebase explorer — indexed files, symbols, and dependencies                                       |
| **Team**      | Agent roster, roles, model assignments, and mood trends                                            |
| **Retro**     | Retrospective findings, patterns, and action follow-through                                        |
| **Benchmark** | Velocity trends, burndown charts, and team performance metrics                                     |

### Benchmark data sources

The Benchmark tab reads published runs from `CODE_CONTEXT_BENCH_DIR` (a dir with `index.json` + `runs/`), then `<db dir>/bench/`, then `origin/bench-results` in a code-context checkout.

To also see the runs of your **private suites** (see [BENCHMARK-GUIDE.md](https://github.com/VelimirMueller/code-context-mcp/blob/main/BENCHMARK-GUIDE.md#private-suites)), list their dirs in `CODE_CONTEXT_BENCH_PRIVATE_DIRS` when you start the dashboard. Separate entries with `:` (`;` on Windows). An entry is a suite dir (with `suite.json`) or its `data/` dir:

```bash
CODE_CONTEXT_BENCH_PRIVATE_DIRS=~/bench/suite-a:~/bench/suite-b \
  npx code-context-dashboard ./context.db
```

- Private runs show a **private** chip with the suite alias, and a filter switches between All, Public and Private.
- The run detail of a redacted run lists tasks by id; prompts, answers and source names are not in the run file.
- The dashboard reads these files from disk only and sends them nowhere. Only `npm run bench:publish -- --private-summary <dir>` publishes anything, and only a redacted summary.

### Real-Time Updates

The dashboard uses Server-Sent Events (SSE) to update in real-time. When you or an AI agent makes changes via MCP tools, the dashboard refreshes instantly without page reload.

---

## Your First Sprint

### Option 1: Guided Walkthrough (Recommended)

Use the `/kickoff` command for a fully guided experience:

```
/kickoff
```

Your AI assistant will:

1. Ask about your product vision
2. Help you create a milestone
3. Break down work into epics
4. Plan your first sprint with tickets
5. Guide you through implementation
6. Run a retrospective
7. Archive completed work

**Advantages:**

- No prior knowledge needed
- AI enforces all QA gates
- Best practices applied automatically
- Nothing gets left dangling

### Option 2: Manual Sprint Creation

If you prefer manual control:

#### 1. Create a Milestone

```javascript
await create_milestone({
  name: 'M1 — MVP',
  description: 'Minimum viable product with core features',
  status: 'active',
});
```

#### 2. Create Epics

```javascript
await create_epic({
  name: 'User Authentication',
  description: 'Login, signup, and password recovery',
  milestone_id: 1,
  priority: 1,
  color: '#3b82f6',
});
```

#### 3. Start a Sprint

```javascript
await start_sprint({
  name: 'Sprint 1 — Auth',
  goal: 'Complete user authentication flow',
  milestone_id: 1,
  epic_id: 1,
  velocity: 19,
  tickets: [
    {
      title: 'Create login form',
      description: 'Build login UI with email/password',
      assigned_to: 'fe-engineer',
      story_points: 5,
      priority: 'P1',
    },
    {
      title: 'Implement login API',
      description: 'POST /api/auth/login endpoint',
      assigned_to: 'be-engineer',
      story_points: 5,
      priority: 'P1',
    },
    {
      title: 'QA: Test login flow',
      description: 'Verify login works end-to-end',
      assigned_to: 'qa',
      story_points: 1,
      priority: 'P1',
    },
  ],
});
```

#### 4. Advance to Implementation

```javascript
await advance_sprint({ sprint_id: 1 });
```

#### 5. Work Through Tickets

For each ticket:

```javascript
// Start work
await update_ticket({ ticket_id: 1, status: 'IN_PROGRESS' });

// ... do the work ...

// Mark complete
await update_ticket({
  ticket_id: 1,
  status: 'DONE',
  qa_verified: true,
  verified_by: 'qa',
});
```

#### 6. Complete Sprint

```javascript
await advance_sprint({ sprint_id: 1 });
```

This moves the sprint to `done` phase, then to `rest`.

---

## Common Workflows

### Finding Code

**Search for a specific symbol:**

```javascript
await find_symbol({ name: 'useAuth' });
// Returns: Files exporting useAuth with summaries
```

**Get full context for a file:**

```javascript
await get_file_context({ path: '/home/user/project/src/hooks/useAuth.ts' });
// Returns: Exports, imports, dependents, metadata, change history
```

**Search files by pattern:**

```javascript
await search_files({ query: '%test%' });
// Returns: All files with "test" in path or summary
```

### Managing Tickets

**Create a new ticket:**

```javascript
await create_ticket({
  sprint_id: 1,
  title: 'Add password reset',
  description: 'User can reset password via email',
  assigned_to: 'be-engineer',
  story_points: 3,
  priority: 'P2',
});
```

**Link ticket to epic:**

```javascript
await link_ticket_to_epic({
  ticket_id: 5,
  epic_id: 2,
});
```

**Set up ticket dependencies:**

```javascript
await add_dependency({
  source_ticket_id: 5,
  target_ticket_id: 1,
  dependency_type: 'blocked_by',
});
// Ticket 5 is now blocked by ticket 1
```

### Blockers and Bugs

**Report a blocker:**

```javascript
await create_blocker({
  sprint_id: 1,
  description: 'API rate limiting preventing testing',
  ticket_id: 3,
  escalated_to: 'devops',
});
```

**Log a bug:**

```javascript
await log_bug({
  sprint_id: 1,
  severity: 'HIGH',
  description: 'Login fails with special characters in password',
  ticket_id: 2,
  steps_to_reproduce: '1. Enter password with !@#\n2. Click login',
  expected: 'User is logged in',
  actual: 'Error: Invalid password',
});
```

### Retrospective

**Add retro findings:**

```javascript
await add_retro_finding({
  sprint_id: 1,
  category: 'went_well',
  finding: 'Frontend and backend synced perfectly on API contract',
  role: 'fe-engineer',
});

await add_retro_finding({
  sprint_id: 1,
  category: 'try_next',
  finding: 'Set up API contract testing before implementation',
  role: 'qa',
  action_owner: 'qa',
});
```

**Analyze patterns across sprints:**

```javascript
await analyze_retro_patterns();
// Returns: Category breakdown, recurring issues, action follow-through rate
```

---

## Troubleshooting

### "No MCP tools available"

**Cause:** AI client not connected to MCP server.

**Solutions:**

1. Restart your AI client completely
2. Verify `.mcp.json` exists in your project root
3. Check that `context.db` exists

### "File not in index"

**Cause:** Trying to query a file that hasn't been indexed.

**Solution:**

```javascript
await index_directory({ path: '/home/user/my-project' });
```

### "Stale dist" errors

**Cause:** Compiled JavaScript doesn't match TypeScript source.

**Solution:**

```bash
npm run build
```

Then restart your AI client.

### Dashboard shows no data

**Cause:** Wrong database path or database not initialized.

**Solution:**

```bash
# Verify database exists
ls -la context.db

# Re-run setup if needed
npx code-context-mcp setup .
```

### High memory usage

**Cause:** Large codebases with many files.

**Solutions:**

1. Index only the directories you need:

```javascript
await index_directory({ path: '/home/user/project/src' });
```

2. Exclude node_modules and build artifacts (automatic by default)

### Sprint gate warnings

**Cause:** Trying to advance sprint phase with incomplete work.

**Common warnings:**

- "No tickets assigned" → Add tickets with `create_ticket`
- "Tickets still in progress" → Mark them DONE or BLOCKED
- "Tickets need QA verification" → Set `qa_verified: true`

**Solution:** Address the specific warnings, then retry `advance_sprint`.

---

## Best Practices

### 1. Index Before Querying

Always index your codebase before querying:

```javascript
// First time or after big changes
await index_directory({ path: '/home/user/project' });

// Then query
await find_symbol({ name: 'useAuth' });
```

### 2. Set Descriptive File Descriptions

Help your AI (and yourself) by adding descriptions:

```javascript
await set_description({
  path: '/home/user/project/src/auth.ts',
  description: 'Authentication utilities: login, logout, session management',
});
```

### 3. Link Tickets to Epics

Keep work organized by linking tickets:

```javascript
await link_ticket_to_epic({
  ticket_id: 5,
  epic_id: 2,
});
```

### 4. Use QA Gates

Don't skip QA verification:

```javascript
await update_ticket({
  ticket_id: 5,
  status: 'DONE',
  qa_verified: true, // Always verify
  verified_by: 'qa',
});
```

### 5. Track Time

Enable better velocity forecasting:

```javascript
await log_time({
  ticket_id: 5,
  estimated_hours: 4,
  actual_hours: 5,
});
```

### 6. Document Discoveries

In discovery sprints, log findings:

```javascript
await create_discovery({
  sprint_id: 2,
  finding: 'Authentication state management needs refactoring',
  resolution_plan: 'Migrate to React Context with useReducer',
  category: 'architecture',
  priority: 'P1',
});
```

### 7. Monitor Agent Mood

Track burnout risk:

```javascript
await record_mood({
  agent_id: 3,
  sprint_id: 5,
  mood: 2, // Low mood = potential burnout
  workload_points: 13,
  notes: 'Heavy backend load, consider redistribution',
});
```

### 8. Regular Backups

Export your database periodically:

```javascript
await export_to_file({ output_path: './backup/context-$(date +%Y%m%d).json' });
```

---

## Advanced Usage

### Custom SQL Queries

For complex queries not covered by built-in tools:

```javascript
await query({
  sql: `
    SELECT s.name, COUNT(t.id) as ticket_count,
           SUM(CASE WHEN t.status = 'DONE' THEN 1 ELSE 0 END) as done_count
    FROM sprints s
    LEFT JOIN tickets t ON t.sprint_id = s.id
    GROUP BY s.id
    ORDER BY s.id DESC
  `,
});
```

### Bulk Updates

Update multiple tickets efficiently. `execute` refuses the gate columns (`tickets.status`, `qa_verified`, `verified_by`, `github_*`, `deleted_at`, `sprints.status`, `archived_at`); change those with `update_ticket` or `update_sprint`, which run the gates (#181).

```javascript
await execute({
  sql: 'UPDATE tickets SET assigned_to = ? WHERE sprint_id = ? AND assigned_to = ?',
  params: ['backend-dev', 5, 'developer'],
});
```

### Integration with CI/CD

Add to your CI pipeline:

```bash
# Index code
npx code-context-mcp index . || echo "Index failed"

# Run tests
npm test

# Export results for analysis
npx code-context-dashboard export context.db > results.json
```

---

## Getting Help

- **API Reference:** See `docs/api-reference.md` for complete tool documentation
- **GitHub Issues:** https://github.com/VelimirMueller/code-context-mcp/issues
- **Examples:** Check `examples/` directory for sample projects

---

### Frontend skills on `/kickoff`

When a sprint has tickets assigned to the `fe-engineer` role, `/kickoff` automatically surfaces a Frontend Playbook — a house-style primer plus an index of available frontend skills. As you start a frontend ticket, ask for the full guidance with `get_skill({ name: "fe:<slug>" })`. The skills live in your project database — edit them (or the `fe:_house-style` primer) to encode your team's preferred ways of working; your edits survive updates.

---

## Next Steps

1. ✅ Install and set up your project
2. ✅ Explore the dashboard
3. ✅ Run your first `/kickoff` sprint
4. ✅ Integrate into your daily workflow

Happy building!
