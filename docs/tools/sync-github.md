# sync_github

One-way sync of **one project's** milestones and tickets to its GitHub repo and GitHub Project (v2) board. GitHub is a mirror: the sync writes to GitHub and never reads changes back into the database.

## Setup: the project key

One database holds the scrum data of several repos. A **project key** tells them apart.

1. Register the project with `set_project`:

   | Name | Type | Required | Description |
   |------|------|----------|-------------|
   | `name` | string | yes | Project key, e.g. `code-context-mcp`. |
   | `repo` | string | no | GitHub repo `owner/name`. |
   | `github_project_number` | number \| null | no | Project board number (`users/<owner>/projects/<N>`). |
   | `github_project_owner` | string \| null | no | Board owner login. Default: repo owner. |
   | `github_assignee` | string \| null | no | Issue assignee. Default: repo owner. |

2. Put the key on milestones, sprints, epics or tickets: `create_milestone`, `create_sprint`, `create_epic` and `create_ticket` take `project`; `update_milestone`, `update_sprint`, `update_epic` and `update_ticket` take `project` (`null` unassigns). An unknown key is refused.
3. Give each new ticket a `type` (`feat`, `fix`, `chore`, `infra`, `improvement`) with `create_ticket` or `update_ticket`. `origin: "human"` marks a ticket a person wrote.
4. Optional: link existing GitHub objects by hand. `update_milestone github_milestone=<N>`, `update_ticket github_issue=<N>`.

`list_tickets`, `list_sprints`, `list_milestones` and `list_epics` filter by `project`.

### Which tickets belong to a project

- A ticket's own `project` wins.
- With no own key, the ticket inherits the key of its sprint, milestone, epic, and their milestones. When these name more than one project, the ticket is **ambiguous**: the sync skips it and lists it. Set its own key to fix that.
- Rows created before schema v26 have no key (`NULL`). The upgrade never guesses one.

## Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `project` | string | yes | Project key. |
| `dry_run` | boolean | no | Print the plan, write nothing. Reads GitHub (2 calls) to show an exact diff. |
| `offline` | boolean | no | With `dry_run`: no GitHub call at all; updates show as `unverified`. |
| `max_writes` | number | no | Refuse a plan with more writes. Default `100`. |

## What it writes

| Local | GitHub |
|-------|--------|
| Milestone with the project key | Milestone: title, description, due date, closed when `completed`. Matched by stored number, else by title, else created. |
| Ticket | Issue `"<ticket_ref>: <title>"`. Body: `## Why` (description before `Done when:`) and `## Done when` (the rest, plus acceptance criteria). |
| `priority` | Label `P0`/`P1`/`P2` (`P3` has none). |
| `type` | Exactly one of `feat`, `fix`, `chore`, `infra`, `improvement`. |
| `origin` | `ai_issue` (default on create) or `issue` (`origin: "human"`). |
| — | Assignee: the project's assignee (others stay). |
| `status`, `review_status` | Board Status: DONE → **Done** (issue closed); review pending → **In review**; IN_PROGRESS / BLOCKED / PARTIAL → **In progress**; TODO in an open sprint → **Ready**; other TODO and NOT_DONE → **Backlog**. A closed issue whose ticket is not DONE is reopened. |

Labels the sync does not own stay on the issue. On an update, the type and origin labels change only when the ticket sets `type` / `origin`. A new ticket without `type` is skipped with a note.

## Safety

- **Idempotent.** A created issue's number goes into `tickets.github_issue` at once; a rerun updates it and never creates a duplicate. A second run with no local change makes no write.
- **One project per run.** Tickets of other projects, ambiguous tickets and tickets whose stored issue belongs to another repo are never sent.
- **No local paths, no tokens.** Every title, body and milestone text is scrubbed: `/Users/…`, `/home/…`, `/var/folders/…`, `/private/…`, `/tmp/…`, `/Volumes/…` and `C:\Users\…` become `…/<last segment>`. A text that still holds a local path or a token-like string (`ghp_…`, `github_pat_…`) is refused. The token stays inside `gh`.
- **Rate limits.** Reads per run: 1 REST call for the milestone list (only when the project has milestones) and 1 GraphQL call per 50 linked issues. That GraphQL call returns the issues, their board items and Status, and, on the first run, the Project id and Status options; these ids are cached in the `projects` row. Writes: 1 REST call per new or changed issue or milestone; board adds and Status changes go as aliased GraphQL mutations, 20 per request. New issues are paced 1 s apart. On failure the run stops and reports what it did.

## Example

```
sync_github project=code-context-mcp dry_run=true
```

```
sync_github code-context-mcp — dry run
Target: VelimirMueller/code-context-mcp, Project #10

Milestones (1):
  = ok     #1 "code-context — Reliably working and verifiably beneficial for development"

Issues (13):
  ~ update #116 CCA-01 — body, labels; status In progress → Done
  = ok     #117 CCA-02
  + create CCA-14 — labels [P1, feat, ai_issue] @VelimirMueller; add to board; status — → Ready
…
Planned writes: 5
```

## CLI

`code-context-sync-github` runs the same sync outside an MCP session:

```bash
code-context-sync-github --db ~/path/to/context.db --project code-context-mcp \
  --repo VelimirMueller/code-context-mcp --project-number 10 --milestone 14=1 \
  --dry-run --offline
```

- `--dry-run` works on an in-memory copy: the db file is opened read-only, never migrated and never written. That is safe while an older server still uses the db.
- `--repo`, `--project-number`, `--project-owner`, `--assignee` and `--milestone <id>[=<github number>]` (repeatable) register the project and link milestones. In a dry run they change the copy only.
- A live run (no `--dry-run`) migrates the db to schema v26. An older code-context server refuses a v26 db, so update the installed package first.
- Exit codes: 0 ok, 1 sync failed, 2 bad usage.
