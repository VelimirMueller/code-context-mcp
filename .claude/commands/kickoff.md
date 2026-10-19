# Full Project Kickoff — Interactive Guided Sprint Lifecycle

Run the complete scrum lifecycle from product vision through sprint rest. Use native question UI for every structured choice, render server-built cards verbatim, enforce all QA gates and the planning gate.

## Step 0a — Check the Tool Profile

The sprint tools are opt-in since 3.0.0: the server's default profile is `code` (6 reading tools). Kickoff needs the `full` profile (toolsets `code`, `code-admin`, `scrum`).

- If `health` is in your tool list, call `health()` and read `profile` and `toolsets`.
- Stop here when `health` is not listed, or `toolsets` lacks `scrum` or `code-admin`. Tell the user, then wait:

```yaml
sprint_tools: off # profile: <profile from health, or code>
fix: CODE_CONTEXT_PROFILE=full
where: .mcp.json → mcpServers["code-context"].env
or: npx code-context-mcp setup . --profile full
then: restart the AI client, run /kickoff again
```

## Step 0 — Load Context (2 calls)

```
index_directory({ freshness_check: true })   # skip if <5 min old
get_resume_state()                           # single-call resume detection
```

That's it. `get_resume_state()` returns vision, sprints, discoveries, milestones, epics, agents, and next_phase in ~150 tokens.

### Phase context — load with `load_phase_context()` when entering each phase

| Phase      | Call                                                                           |
| ---------- | ------------------------------------------------------------------------------ |
| Phase 2    | `load_phase_context({ phase: "discovery" })`                                   |
| Phase 4    | `load_phase_context({ phase: "epics" })`                                       |
| Phase 5+5b | `load_phase_context({ phase: "tickets" })` — includes the planning-gate blocks |
| Phase 7    | `load_phase_context({ phase: "implementation", sprint_id, ticket_id })`        |
| Phase 8    | `load_phase_context({ phase: "retro", sprint_id })`                            |

### Display summary

Render the resume state as a phase banner + yaml data card:

## ◈ Context Loaded

```yaml
vision: set # from get_resume_state()
sprints: 21 completed · none active
discoveries: 9 active
milestone: '#21 Process 2.0' # [active] 40%
skill_sets: fe ✓ · la ✗ · wf ✗ # "(defaults — not configured yet)" → Phase 1b will ask
next_phase: tickets
```

---

## Output Contract — Design Language 2.0

1. **Server cards are verbatim.** Tools called with `format: "card"` (`update_ticket`, `advance_sprint`, `start_sprint`, `get_sprint_playbook`, `get_burndown`) return pre-rendered card lines. Print them **unchanged inside a ```diff fence**. Never redraw, restyle, re-align, or wrap them.
2. **Phase banners** are a `## ◈ <Phase Title>` markdown heading followed by a ```yaml data card (keys lowercase, aligned values, `# comments` for context). Never hand-draw ASCII boxes.
3. **Use `format: "card"`** on every status-changing call during ceremonies — each card includes compact state, so skip follow-up `get_ticket`/`get_sprint` calls.

## Question Protocol

Priority order for asking the user anything:

1. **Dashboard wizard** — if the dashboard is up, `request_user_input` (it returns `fallback: true` when down; then descend).
2. **AskUserQuestion tool** — for every _enumerable_ choice: discovery type, backlog confirmation, gate triage resolutions, phase-advance confirmations, archive decisions. Use `multiSelect` where choices aren't exclusive. Mark your recommended option "(Recommended)" and put it first.
3. **Plain text question** — only for genuinely free-form input: vision, sprint goal, epic descriptions, retro reflections.

**Rules:**

- One decision point at a time. Wait for the answer before proceeding.
- Lists longer than 4 options: show a ```yaml summary card of ALL items first, then batch AskUserQuestion calls (≤4 options each, ≤4 questions per call); spill the remainder into a follow-up call or conversational handling.
- Never batch unrelated decisions into one question. Never assume answers.
- After each answer, execute the MCP calls, confirm what was saved (card or one-liner), then move on.

---

## Resume Logic

Using the data already loaded in Step 0, determine where to pick up:

- If a vision already exists (non-empty) → skip Phase 1, confirm the existing vision to the user
- If `skill_sets` carries no "(defaults — not configured yet)" marker → skip Phase 1b (the project already chose)
- If active/planned discoveries exist → skip Phase 2, show them and ask if more are needed
- If an active milestone exists → skip Phase 3, show it
- If epics already linked to the milestone → skip Phase 4, show them
- If a sprint is in progress (not `rest`) → skip to Phase 7 (implementation loop)
- Always start from the earliest phase that has NOT been completed yet

Announce the resume point as a banner + yaml card:

## ◈ Resuming Project

```yaml
vision: set # ✓
discovery: 2 active # ✓
milestone: none yet # ← picking up here
```

---

## Phase 1 — Product Vision

Plain-text question (free-form input). Explain: the vision anchors every sprint, ticket, and priority decision. Ask for: what are you building, who is it for, what does success look like. Give one short example.

→ `update_vision({ vision: "<cleaned up response>" })`

---

## Phase 1b — Skill Sets

Only when the resume state marks skill sets "(defaults — not configured yet)". Explain in one line: the server ships predefined skill libraries it can inject into sprints. Then **AskUserQuestion (multiSelect)** — "Enable predefined skill sets for this project?":

- **Frontend (Recommended)** — 22 React/Vue skills + editable house-style primer (`fe:*`)
- **Landing pages** — landing structure, SEO, lead capture, content audits (`la:*`)
- **Workflow: PRs & commits** — write-pull-requests, write-commit-messages (`wf:*`)

→ `update_skill_sets({ frontend, landing, workflow })` with the booleans the user chose. Confirm with the returned one-liner. Enabled sets index into Phase 7 context automatically; any skill is pullable via `get_skill`.

---

## Phase 2 — Discovery

```
load_phase_context({ phase: "discovery" })
```

Use the discoveries, decisions, and coverage data to suggest discoveries the user might not have thought of. Ask for the discovery description as free text, then classify the type via **AskUserQuestion** (spike / feature_scope / risk / architecture — with one-line descriptions).

→ `create_discovery({ title, description, discovery_type })`

---

## Phase 3 — Milestone

Plain-text question: name, "done looks like…", optional target date. Milestones span multiple sprints ("v1.0", "beta launch") — not individual features.

→ `create_milestone({ title, description, target_date })`
→ Link discoveries to milestone where relevant

---

## Phase 4 — Epics

```
load_phase_context({ phase: "epics" })
```

Free-text: 2–4 workstreams (name + one-liner each). Confirm the parsed epic list via **AskUserQuestion** (confirm / adjust) before creating.

→ For each: `create_epic({ name, description, milestone_id })`

---

## Phase 5 — Sprint Tickets

```
load_phase_context({ phase: "tickets" })
```

This returns velocity trends, backlog, active epics, **and the planning-gate blocks (open try_next + open discoveries + triage directive)**. Use codebase knowledge to suggest realistic point estimates; target the velocity average from trends.

Collect tickets (free text or proposals), auto-generate a QA verification ticket (1–2pts, `qa`) for every feature ticket, then confirm the backlog:

## ◈ Confirm Backlog

```yaml
tickets: 10 # 5 feature + 5 QA
points: 24 # target was 19 (avg velocity)
epics: 'Loop Gates (4) · Cockpit (6)'
```

Then **AskUserQuestion**: confirm / adjust points / add more / remove some.

---

## Phase 5b — Planning Gate Triage

The gate blocks `start_sprint` while untriaged try_next findings or escalated discoveries exist. Work through the blocks loaded in Phase 5:

1. Show the ```yaml summary card of all open items (id, age, owner, one-liner).
2. For each batch of ≤4 items, **AskUserQuestion (multiSelect)**: which to **adopt** this sprint? Then for the rest: drop or defer (one question per batch).
3. Execute: adopt → create the ticket first, then `triage_retro_finding({ finding_id, resolution: "adopt", ticket_id })`; drop → `triage_retro_finding({ ..., resolution: "drop", dropped_reason })`; defer → `triage_retro_finding({ ..., resolution: "defer" })`.
4. Escalated discoveries: pull in (`link_discovery_to_ticket`) or defer/drop (`update_discovery`).

Aim to adopt **at least one** try_next per sprint. `acknowledge_open_items: true` on `start_sprint` is an escape hatch, not a habit — say so if the user reaches for it.

---

## Phase 6 — Start Sprint

Plain-text: sprint name + one-line measurable goal (give an example).

→ `start_sprint({ name, goal, milestone_id, velocity, tickets: [...], format: "card" })`
→ `advance_sprint({ sprint_id, format: "card" })` to move planning → implementation

Print both returned cards verbatim in ```diff fences. If the gate blocks, return to Phase 5b — do not silently acknowledge.

---

## Phase 7 — Implementation Loop

Before working on each ticket:

```
load_phase_context({ phase: "implementation", sprint_id: <id>, ticket_id: <id> })
```

This returns sprint progress, ticket detail, open blockers, and a **Model routing** directive. If a `⚠ CHANGED TICKETS` block appears, re-read those tickets, state the plan adjustment (or that none is needed), then `acknowledge_ticket_changes`.

**Delegate by model.** Implement every ticket by spawning a subagent via the **Task tool with the `model` tier from the routing directive** (`opus`/`sonnet`/`haiku`) — pass the ticket's title, description, and acceptance criteria. Let the subagent implement and report back; then run the QA gate and mark the ticket DONE.

**Multi-agent tickets:** when the directive says `Model routing (multi-agent)`, the **lead** assignment implements first (one subagent at its resolved model); then spawn the **supporting** assignments as parallel reviewer/verifier subagents at their resolved models, each judging the lead's diff from its role's perspective. Every supporting verdict must pass before `qa_verified: true` — a failed verdict means `log_bug()` and back to the lead.

**Frontend work:** if the sprint has `fe-engineer` tickets, `load_phase_context` also injects the Frontend Playbook (house-style primer + skill index; the landing-page index too when that set is enabled). Give delegated frontend tickets that guidance — pull specific skills with `get_skill({ name: "fe:<slug>" })`.

**Workflow skills:** when the workflow set is enabled, `load_phase_context` injects the `wf:*` index once per sprint — use `wf:write-commit-messages` / `wf:write-pull-requests` when committing or opening PRs for ticket work.

For each completed ticket:

1. `update_ticket({ ticket_id, status: "IN_PROGRESS" })`
2. The work happens (subagent or user)
3. `update_ticket({ ticket_id, status: "DONE", qa_verified: true, verified_by: "qa", format: "card" })` — print the returned pulse card verbatim in a ```diff fence
4. Also close the matching QA ticket

**QA gate is mandatory.** Never mark `qa_verified: true` without verifying the work. If verification fails → `log_bug()` and keep the ticket in progress.

Once all tickets are DONE + QA-verified:

→ `advance_sprint({ sprint_id, format: "card" })` moves implementation → done

---

## Phase 8 — Retrospective

```
load_phase_context({ phase: "retro", sprint_id: <id> })
```

Returns sprint state, burndown, mood, retro patterns (incl. try_next lifecycle), and velocity comparison. Ask the three reflections as free text — went_well, went_wrong, try_next — one at a time, and make them **specific and data-backed** (quote velocity/burndown/mood numbers).

→ `add_retro_finding` × 3 (one per category; set `action_owner` on try_next)

Remind: new try_next items enter the planning gate — they will demand a decision at the next sprint's Phase 5b.

---

## Phase 9 — Close & Archive

→ `advance_sprint({ sprint_id, format: "card" })` moves done → rest (print the sprint-complete card verbatim)

**Archive everything tied to this sprint:**

1. Discoveries → `update_discovery({ discovery_id, status: "implemented" })` if ticket DONE, else `status: "dropped"` with `drop_reason` — confirm batch via **AskUserQuestion** when ambiguous
2. Epics with all tickets DONE → `update_epic({ epic_id, status: "completed" })`
3. Milestone: all epics completed → `update_milestone({ milestone_id, status: "completed", progress: 100 })`; otherwise update `progress` to the calculated %

Close with the sprint-complete card (from step above) plus a one-line pointer: `/kickoff` for the next cycle, `/sprint` to jump straight to planning.

---

## Rules

1. **Context first.** Always load from MCP DB before acting. Never assume state.
2. **Code context before file reads.** Use `search_files()` and `get_file_context({ include_changes: false })` before any `Read` tool call. Only include change history when debugging.
3. **One decision at a time.** Never skip ahead. Never batch unrelated questions.
4. **Wait for user input** before calling any write MCP tool.
5. **Never assume answers.** Ambiguous → ask a follow-up.
6. **Server cards are verbatim** — always ```diff fences, never redrawn (Output Contract above).
7. **QA gates are mandatory.** Every ticket must be `qa_verified: true`.
8. **The planning gate is real.** Triage every open try_next and escalated discovery in Phase 5b; adopt ≥1 try_next per sprint when feasible; treat `acknowledge_open_items` as an exception to be called out.
9. **Auto-generate QA tickets** for every feature ticket.
10. **Link everything** — tickets→epics, epics→milestones, discoveries→tickets.
11. **Archive on close** — discoveries, epics, milestones all get their final status.
12. **Resume from where you left off** — check existing state before asking redundant questions.
13. **Full profile first.** Step 0a runs before any other call; never work around missing sprint tools.
14. **Surface anomalies.** If retro patterns, mood trends, or velocity suggest a problem, highlight it.
