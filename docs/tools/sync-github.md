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
   | `force` | boolean | no | Re-point a project that already synced (see [Authorization](#authorization)). |

2. Put the key on milestones, sprints, epics or tickets: `create_milestone`, `create_sprint`, `create_epic` and `create_ticket` take `project`; `update_milestone`, `update_sprint`, `update_epic` and `update_ticket` take `project` (`null` unassigns). An unknown key is refused.
3. Give each new ticket a `type` (`feat`, `fix`, `chore`, `infra`, `improvement`) with `create_ticket` or `update_ticket`. `origin: "human"` marks a ticket a person wrote.
4. Optional: link existing GitHub objects by hand. `update_milestone github_milestone=<N>`, `update_ticket github_issue=<N>`.

`list_tickets`, `list_sprints`, `list_milestones` and `list_epics` filter by `project`.

### Which tickets belong to a project

- A ticket's own `project` wins.
- With no own key, the ticket inherits the key of its sprint, milestone, epic, and their milestones. When these name more than one project, the ticket is **ambiguous**: the sync skips it and lists it. Set its own key to fix that.
- Rows created before schema v26 have no key (`NULL`). The upgrade never guesses one.

## Authorization

Any MCP client can call `set_project` and `sync_github`. An agent that read prompt-injected text could point a project at another repo and publish private ticket text there with your `gh` token. So the user allows live writes **outside the MCP channel**:

Each entry pins exact targets. Both env vars are read from the server or CLI process; no tool and no CLI flag sets them.

| Env var | Entry | Allows |
|---|---|---|
| `CODE_CONTEXT_GITHUB_SYNC_REPOS` | `owner/repo` | Issues and milestones in that repo. No Project board. |
| | `owner/repo@board-owner/N` | The same, plus Project board `N` of `board-owner`. Only that board. |
| `CODE_CONTEXT_GITHUB_SYNC_ASSIGNEES` | `login` | That login as issue assignee, in addition to the repo owner. |

- Entries are case-insensitive, comma or space separated. Wildcards and malformed entries are ignored.
- **Repo.** The project's `repo` must be listed.
- **Board.** A project with `github_project_number` needs the exact pair `repo@board-owner/N`. A repo entry never covers a board, and a board entry never covers another board of the same owner. Without the pair the live sync is refused. To sync without a board, set `github_project_number` to `null`.
- **Assignee.** The assignee must be the repo owner or a login in `CODE_CONTEXT_GITHUB_SYNC_ASSIGNEES`. Else the live sync is refused. Assignees already on an issue stay.
- **Labels.** Only the fixed set (`P0`–`P2`, the five type labels, `ai_issue`, `issue`) is sent. GitHub creates a missing label on first use; no other label is ever created.
- **Milestones** are written only in the allowlisted repo.
- **Project ids.** A live run resolves the Project id from the allowed `board-owner/N` in its first read. It never uses the cached id, so a changed db row cannot redirect board writes.
- Anything else is refused before the first GitHub call. The message names the env var and the exact entry to add. Set it in the MCP server config (`env`) and restart the server.
- Dry runs, online and offline, need no allowlist.
- **Re-point rule.** When a project has synced (a ticket holds `github_issue` or a milestone holds `github_milestone`), `set_project` refuses a new `repo`, `github_project_number` or `github_project_owner`. `force: true` lifts this only when the new repo (and the exact board pair, with a board) passes the allowlist. The assignee may change freely; every live sync checks it. An unsynced project can be re-pointed; the allowlist still gates its first live sync.

```json
{ "mcpServers": { "code-context": { "env": {
  "CODE_CONTEXT_GITHUB_SYNC_REPOS": "VelimirMueller/code-context-mcp@VelimirMueller/10"
} } } }
```

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
- **Live writes only to allowlisted targets.** See [Authorization](#authorization).
- **No secrets.** A title, description, acceptance criterion or milestone text that holds a secret is refused, never scrubbed. The ticket is skipped with the reason (a milestone fails the plan). The message names the field and the secret type, never the value. Detected: GitHub tokens (`ghp_`, `gho_`, `ghu_`, `ghs_`, `ghr_`, `github_pat_`), Anthropic keys (`sk-ant-`), OpenAI keys (`sk-`, `sk-proj-`, `sk-svcacct-`, `sk-admin-`), AWS access key ids (`AKIA`, `ASIA`, `ABIA`, `ACCA`) and secret access keys, Slack tokens (`xoxa-`, `xoxb-`, `xoxp-`, `xoxr-`, `xoxe-`, `xoxo-`, `xoxs-`) and webhook URLs, Google API keys (`AIza`), Stripe keys (`sk_`/`rk_`/`pk_` + `live_`/`test_`), JWTs, PEM private key blocks, `Authorization: Bearer|Basic …`, passwords in URLs (`scheme://user:pass@`), `.env`-style `NAME_KEY=…` / `_SECRET` / `_TOKEN` / `_PASSWORD` assignments, and `name=value` / `name: value` where the name holds key, secret, token, password, passwd or api_key and the value is 16+ key-like characters.
  - The check runs on the raw text, on a decoded copy (percent, HTML entities, `\u` / `\x` escapes, NFKC, invisible characters removed) and on that copy without markdown `*` and `` ` `` marks. It runs before the path scrubber, so scrubbing never hides a secret.
  - Not flagged: the words token, key, secret; issue and PR numbers; git SHAs; UUIDs; run ids like `dsk-20261011-090622`; lower-case word values (`token: see-the-vault-entry`); repo file paths; numbers; placeholders (`${VAR}`, `<your-key>`, `changeme`, `xxxx`); values shorter than the threshold.
- **No local paths.** Two independent layers:
  - The scrubber rewrites every title, body and milestone text: a token that holds `/Users/…`, `/home/…`, `/root/…`, `/var/folders/…`, `/private/var…`, `/private/tmp…`, `/tmp/…`, `/Volumes/…`, `C:\Users\…`, `C:/Users/…` or `…\Documents and Settings\…` becomes `…/<last segment>`; a bare user directory (`/Users/<name>`) becomes `…`. This covers `file://` URLs, markdown link targets and autolinks, prefixed roots (`x/Users/…`), escaped slashes (`\/`, `\u002F`), percent-encoding (also double), HTML entities (`&#47;`, `&#x2F;`, `&sol;`, `&amp;#47;`) and invisible characters. In `key=value` text only the value goes (`--db=…/ctx.db`).
  - The guard checks the final text on its own. It normalizes a copy (NFKC, invisible characters dropped, percent / HTML / `\u` / `\x` escapes decoded, `\` → `/`, repeated slashes collapsed) and refuses the text when a local root or a `file:/` URL appears anywhere except in the path of an `http(s)://host/…` URL. A form the scrubber misses is refused, never sent.
  - The scrubber and the guard split tokens at the same characters (whitespace, `` ` `` `'` `"` `<` `>` `(` `)` `[` `]` `{` `}` `|` `,` `*`). So the guard never reads `https://host/a,/Users/…` as one URL while the scrubber sees two tokens.
  - http(s) URLs stay as they are, for example `https://github.com/home/x`. A repo-relative path that contains a root as a segment (`app/home/page.tsx`) is scrubbed to `…/page.tsx`.
  - The token stays inside `gh`.
- **Rate limits.** Reads per run: 1 REST call for the milestone list (only when the project has milestones) and 1 GraphQL call per 50 linked issues. That GraphQL call returns the issues, their board items and Status, and the Project id and Status options. A live run always reads these ids from the allowed board in that call; only dry runs use the copy cached in the `projects` row. Writes: 1 REST call per new or changed issue or milestone; board adds and Status changes go as aliased GraphQL mutations, 20 per request. New issues are paced 1 s apart. On failure the run stops and reports what it did.

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
- A live run (no `--dry-run`) needs the exact target in `CODE_CONTEXT_GITHUB_SYNC_REPOS` (`owner/repo`, plus `@board-owner/N` with `--project-number`) and an allowed assignee (see [Authorization](#authorization)). `--repo`, `--project-number` and `--assignee` register the project but never authorize a write. A refused live run exits 2 and rolls back the setup flags.
- `--force` re-points a project that already synced, only to an allowlisted target. A dry run may re-point its in-memory copy freely.
- A live run (no `--dry-run`) migrates the db to schema v26. An older code-context server refuses a v26 db, so update the installed package first.
- Exit codes: 0 ok, 1 sync failed, 2 bad usage.
