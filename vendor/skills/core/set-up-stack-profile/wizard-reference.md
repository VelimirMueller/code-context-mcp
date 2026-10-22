# Wizard Reference

## Rule: Detect first, ask only gaps
**Why:** Asking what the repo answers wastes the user's attention and teaches them to click through. Detection is deterministic; questions should carry judgment.
**How to apply:** Run the audit commands; fill every key you can with a file as evidence; ask only keys that are missing, ambiguous, or that change what skills output.
**Anti-example:** "Which package manager do you use?" while `pnpm-lock.yaml` sits in the root.

## Rule: Recommended option first, with a reason
**Why:** Most users want a good default fast. Putting the recommended option first and naming why makes the default the path of least effort and the deviation a conscious one.
**How to apply:** In each `AskUserQuestion`, option 1 is the Adopt row from [tech-radar.md](../_shared/tech-radar.md) with "(Recommended)" and a one-line reason in its description. Max 4 questions per round, 2–4 options per question.
**When to deviate:** When the repo already uses another tool successfully, put that first as "Keep <tool> (current)".

## Question bank

Ask only those whose key is a gap.

**Round 1 — language and frontend**

| Key | Question | Options (first = recommended) |
|---|---|---|
| `languages` | Which languages does this repo use? (multi-select) | TypeScript; Go; Python; Rust |
| `frontend.framework` | Which UI framework? | Vue (Nuxt or Vite); React (Next or Vite); None |
| `frontend.meta` | Which meta-framework? | Vite SPA; Nuxt (Vue); Next (React); None |

**Round 2 — backend, data, hosting**

| Key | Question | Options |
|---|---|---|
| `backend.track` | Which backend? | Hono (TS); Supabase (Postgres + auth, little server code); Go; FastAPI; Next route handlers; None |
| `database` | Which database and ORM? | Postgres + Drizzle (TS) / sqlc (Go) / SQLAlchemy (Python); SQLite; None |
| `hosting` | Where does it run? (multi-select) | Vercel; Netlify; Hetzner; IONOS; Supabase; None |
| `iac` | Infrastructure as code? | OpenTofu; None |

**Round 3 — tooling**

| Key | Question | Options |
|---|---|---|
| `package_manager` + `runtime_manager` | Package manager and runtime manager? | pnpm + mise; npm + nvm; bun; uv (Python) |
| `lint_format` | Lint and format? | Biome (TS) + ruff (Python) + golangci-lint (Go) + clippy/rustfmt (Rust); ESLint + Prettier; Oxlint |
| `task_runner` | Task runner? | just (polyglot); mise tasks; package scripts; make |
| `tests` + `ci` | Test layout and CI? | tests/ dir + GitHub Actions; colocated + GitHub Actions; GitLab CI |

**Round 4 — observability and AI**

| Key | Question | Options |
|---|---|---|
| `observability` | Telemetry? | OpenTelemetry + SigNoz; OpenTelemetry + Grafana LGTM; Sentry only; None |
| `ai` | Any AI/LLM features? | None; Anthropic; OpenAI; Local models |
| `ai.rag_store` | Vector store? (only if `ai` set) | pgvector; sqlite-vec; Qdrant; None |

Recommended defaults are rooted in [engineering-principles.md](../_shared/engineering-principles.md): boring technology, one seam per vendor, observability as part of the feature.

## Profile → plugins

| Profile signal | Plugin | Install id |
|---|---|---|
| always | `devcore` | `devcore@claude-development-skills` |
| `frontend.framework` is `react` or `vue` | `frontendskills` (also contains the landing skills) | `frontendskills@claude-development-skills` |
| `backend.track` is not `none`, or a `database` is set | `backendskills` | `backendskills@claude-development-skills` |
| `hosting` has `hetzner`/`ionos`, or `iac: opentofu`, or CI/deploy work | `infraskills` | `infraskills@claude-development-skills` |
| `hosting` includes `azure`/`aws` (cloud), or Airtable/SigNoz is used, or alerting work | `opsskills` | `opsskills@claude-development-skills` |
| a Go/Rust/Python/TS CLI is built | `cliskills` | `cliskills@claude-development-skills` |
| `ai.provider` is not `none` | `aiskills` | `aiskills@claude-development-skills` |
| a game or interactive canvas is built | `gameskills` | `gameskills@claude-development-skills` |

Plugins that are not yet published in the marketplace are listed as "planned". Check `.claude-plugin/marketplace.json` for which exist before printing install commands.

## Ordered skill list

Order by dependency, earliest first; include only skills present in an enabled plugin and not already satisfied:

1. `set-up-stack-profile` (this skill, done)
2. Runtime and package manager (scaffold skills of the track)
3. Env validation (`validate-env` or the backend equivalent)
4. Lint and format, then TypeScript config
5. Test stack
6. CI (`configure-ci`)
7. Security: `audit-security`, headers, auth
8. Logging and observability (per [logging-contract.md](../_shared/logging-contract.md), [observability.md](../_shared/observability.md))
9. Feature skills (routing, state, forms, i18n, …)
10. `audit-toolchain` last, as a cross-check against [tech-radar.md](../_shared/tech-radar.md)

Print each as `n. <skill> — <why now>` in one line.

## Rule: Idempotent re-run shows a diff
**Why:** A stack drifts. A silent overwrite loses the user's notes; a full re-interview wastes time.
**How to apply:** On re-run, compute `old → detected` per key; print only differing keys; ask only about changed/unknown ones; preserve the notes section verbatim and append new deviations.

## Rule: Profile is team knowledge
**Why:** It documents decisions, so new contributors and agents stop re-deriving them.
**How to apply:** Recommend committing it. Keep secrets, tokens and URLs out of it: it holds tool names only.

## When to deviate

- A user who says "just pick for me": fill all gaps from the Adopt rows, print the result, and ask for one confirmation.
- A throwaway repo: write no profile; give the plugin list only.
