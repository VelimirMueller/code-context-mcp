# ADR-001: Claude Code Integration Bridge

**Status:** Accepted
**Date:** 2026-03-30
**Sprint:** 68 — Claude Code Integration Bridge

## Context

The dashboard app and Claude Code run as isolated OS processes. The app can display data Claude produces (via SSE over shared SQLite), but cannot trigger Claude to act. This makes the system read-only from the UI's perspective — users must switch to the terminal to ask Claude to advance sprints, assign tickets, or run retros.

For the app to become agentic workflow infrastructure, it needs bidirectional communication: App -> Claude (trigger actions) and Claude -> App (report results).

## Decision

**Use PreToolUse hooks + shared SQLite `pending_actions` table as the IPC bridge.**

### How It Works

```
Dashboard UI                  SQLite (context.db)              Claude Code
     |                              |                              |
     |-- POST /api/bridge/actions ->|                              |
     |   (writes pending_actions)   |                              |
     |   <bridge_action SSE --------|                              |
     |                              |                              |
     |                              |<-- PreToolUse hook fires ----|
     |                              |    claims + completes rows   |
     |                              |    (pending→claimed→done)    |
     |                              |                              |
     |                              |--- additionalContext -------->|
     |                              |    (sanitized, injected)      |
     |                              |                              |
     |                              |<-- Claude executes MCP tool --|
     |                              |    (work effect in DB)        |
     |                              |                              |
     |<-- SSE notification ---------|                              |
     |    (WAL watcher fires)       |                              |
```

1. **Dashboard -> SQLite**: User clicks action in UI, dashboard POSTs to `/api/bridge/actions`. The action is validated against a 9-entry `ALLOWED_BRIDGE_ACTIONS` allowlist (`advance_sprint`, `assign_ticket`, `update_ticket`, `create_ticket`, `run_kickoff`, `plan_sprint` are forwarded; `run_retro`, `run_review`, `request_input` are UI-only; 3.0.0 removed `custom`, #244). Each forwarded action is checked against its strict payload schema in `src/bridge/actions.ts`, and every payload is capped at 4 KB. A row is inserted into `pending_actions`, and an immediate `bridge_action` SSE event (or `input_requested` for `request_input` actions) is pushed to all connected dashboard clients.
2. **SQLite -> Claude**: PreToolUse hook (`src/bridge/hook.ts`) fires on every tool call. It reads pending rows of the forwarded actions only, checks each row again against its schema (a row can also come from `execute` or an import; a row that fails is marked `failed`), and marks the rest `claimed` — never `completed`, because the agent has not acted yet. The resulting action list is injected as `additionalContext`, framed as data, with the instruction to confirm each action with the user before acting (#244).
3. **Claude executes work**: Claude receives the injected context and calls the appropriate MCP tool to carry out the requested operation (e.g. `advance_sprint`, `update_ticket`). The DB lifecycle for the `pending_actions` row is already closed by the hook; this step produces the actual work effect.
4. **SQLite -> Dashboard**: WAL watcher fires SSE notification, dashboard refreshes (existing path).

### pending_actions Schema

```sql
CREATE TABLE pending_actions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  action TEXT NOT NULL,           -- e.g. 'advance_sprint', 'assign_ticket'
  entity_type TEXT,               -- e.g. 'sprint', 'ticket'
  entity_id INTEGER,              -- target entity ID
  payload TEXT,                   -- JSON with additional params
  status TEXT NOT NULL DEFAULT 'pending',  -- pending|claimed|completed|failed|expired
  source TEXT NOT NULL DEFAULT 'dashboard',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  claimed_at TEXT,
  completed_at TEXT,
  result TEXT,                    -- JSON result from Claude
  error TEXT                      -- error message if failed
);
```

### Action Lifecycle

```
pending -> claimed -> completed
                   -> expired (claim unresolved after 1 hour)
pending -> failed  (refused by the hook schema check)
pending -> expired (after 1 hour TTL)
```

## Alternatives Considered

### MCP Resource Subscriptions

- **Rejected.** Claude Code explicitly does not support `notifications/resources/updated` (GitHub issue #7252, closed as "Not Planned").

### MCP Channels (`notifications/claude/channel`)

- **Deferred.** Official push mechanism but in research preview, requires `--channels` CLI flag and claude.ai auth. Good future upgrade path when it stabilizes.

### Named Pipes / Unix Sockets / FIFO

- **Rejected.** Adds platform-specific complexity. Doesn't work on Windows. Our existing SQLite + hooks primitive covers the same ground with zero new dependencies.

### Localhost HTTP Webhook

- **Rejected.** Requires Claude Code to expose an HTTP server, which it doesn't. The hook system is the sanctioned way to inject context.

### CLI Resume (`claude -c -p "instruction"`)

- **Complementary.** Good for one-shot triggers from CI/scripts, but doesn't integrate with the in-session experience. Can be used alongside the hook bridge.

## Consequences

### Positive

- **Zero new dependencies** — uses SQLite (already have) + hooks (built into Claude Code)
- **Works today** — no experimental features, no version requirements beyond hooks support
- **Atomic** — SQLite transactions ensure dashboard and hook never see partial state
- **Observable** — pending_actions table is queryable, debuggable, has full audit trail
- **Portable** — ships as part of the npm package, no daemon processes

### Negative

- **Not real-time push** — hook only fires when Claude makes a tool call. If Claude is idle, actions queue until the next interaction.
- **Polling frequency** — depends on how often Claude calls tools. In an active session this is sub-second; in idle it could be minutes.
- **Single-session** — hook only reads for the session that owns the DB. Multi-session coordination needs additional work.

### Mitigations

- For idle sessions: combine with `claude -c -p "check pending actions"` as a fallback nudge
- For multi-session: future Channels upgrade provides true push across sessions

## References

- [Claude Code Hooks Reference](https://code.claude.com/docs/en/hooks)
- [Claude Code Channels](https://code.claude.com/docs/en/channels)
- [MCP Specification — Notifications](https://modelcontextprotocol.io/specification/2025-11-25)
- [GitHub #7252 — Resource subscriptions not planned](https://github.com/anthropics/claude-code/issues/7252)
