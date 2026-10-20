# Sprint Connect — Bridge UI to Claude Session

Connect the dashboard UI to this Claude session. Spawns a background agent that polls for dashboard actions and executes them using MCP tools. Re-spawns automatically when the agent times out.

## Step 0 — Load Context (2 calls)

```
get_resume_state()                     # project state + active sprint
get_sprint_playbook()                  # current phase, gates, next actions
```

---

## How It Works

1. Spawn a background agent that polls `pending_actions` in context.db every second
2. When an action arrives (button click in UI), the agent executes the corresponding MCP tool
3. The main session gets notified of completed actions
4. If the agent exits (timeout), re-spawn it automatically
5. Continue until the user says "quit" or "disconnect"

## Instructions

When the user runs `/sprint-connect`, execute this loop:

### Step 1: Announce connection

Tell the user:

```
Sprint Connect active. Dashboard actions will be handled automatically.
Run /ccui, or open the launch URL the dashboard printed at startup, to use the UI.
Say "disconnect" to stop listening.
```

### Step 2: Spawn the polling agent

The spawned agent MUST load context before handling actions. Include these instructions in the agent prompt:

```
You are a bridge agent polling for dashboard actions in the MCP server project.

BEFORE handling any action, load context from the MCP database:
- get_sprint_playbook() — know the current phase and gates
- list_agents() — know who's on the team
- get_sprint({ sprint_id: <current> }) — know ticket state

Your job:
1. Read the pending_actions table from context.db using a bash command every second
2. When you find a pending action, claim it and execute the corresponding MCP tool
3. Before executing implement_ticket actions, ALWAYS load code context first:
   - get_ticket({ ticket_id: <id> }) — understand the ticket
   - search_files({ query: "<ticket keywords>" }) — find related code
   - get_file_context({ path: "<relevant file>", include_changes: false }) — deps only, skip diff history
   - Only THEN read actual files and implement
4. After executing, mark the action as completed in the database
5. Report what you did back to the main session
6. Continue polling until 3 minutes have passed with no actions, then exit

Polling command (run this in a loop):
node -e '
const Database = require("better-sqlite3");
const db = new Database("context.db");
const rows = db.prepare("SELECT id, action, entity_type, entity_id, payload, status FROM pending_actions WHERE status = ? ORDER BY created_at ASC LIMIT 1").all("pending");
if (rows.length > 0) {
  const r = rows[0];
  db.prepare("UPDATE pending_actions SET status = '\''claimed'\'', claimed_at = datetime('\''now'\'') WHERE id = ?").run(r.id);
  console.log(JSON.stringify(r));
} else {
  console.log("NONE");
}
db.close();
'

Action mapping — when you find an action, call the MCP tool:
- advance_sprint → call advance_sprint({ sprint_id: <entity_id> })
- update_ticket → call update_ticket({ ticket_id: <entity_id>, ...JSON.parse(payload) })
- create_ticket → call create_ticket({ ...JSON.parse(payload) })
- run_kickoff → call handle_run_kickoff() if available, otherwise report "kickoff requested"
- implement_ticket → Load ticket + code context from DB first, then implement

After executing, mark completed:
node -e '
const Database = require("better-sqlite3");
const db = new Database("context.db");
db.prepare("UPDATE pending_actions SET status = '\''completed'\'', completed_at = datetime('\''now'\'') WHERE id = ?").run(<ACTION_ID>);
db.close();
'

IMPORTANT: After each action, report back what you did. Keep polling until 3 minutes of no activity.
```

### Step 3: Monitor and re-spawn

When the background agent finishes (timeout or completion):

1. Check if the user said "disconnect" — if so, stop
2. Otherwise, tell the user: "Listener timed out after 3 min idle. Re-spawning..."
3. Go back to Step 2

### Step 4: Handle disconnect

When the user says "disconnect", "quit", or "stop":

1. Let any running background agent finish its current action
2. Say: "Sprint Connect disconnected. Dashboard buttons will use direct API only."

## Rules

1. **Context first.** Load project state before connecting so the bridge agent understands what it's operating on.
2. **Code context before file reads.** Bridge agents implementing tickets must use `search_files()` and `get_file_context({ include_changes: false })` before reading source files.
3. **Re-load on each action.** For implement_ticket actions, always refresh ticket and code context — state may have changed since last poll.
