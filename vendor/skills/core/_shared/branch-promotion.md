# Branch Promotion Contract

Three long-lived branches, one environment each: `develop` → `dev`, `stage` → `stg`, `main` → `prd`.
Promotion is a fast-forward of a verified SHA, never a merge or squash, and all three branches stay in
sync. **This is the norm for every deploy** — every repo with environments follows this contract unless a
deviation at the end applies. Procedure: [promote-release](../promote-release/SKILL.md); full commands:
[promotion-recipes](../promote-release/promotion-recipes.md). The fleet standard (`VelimirMueller/fleet-standard`,
rules `CI-*`, `CI-COST-*`, `GOV-*`) builds on this contract and makes it checkable with `fleet check`.

Every deploy starts by hand (fleet standard CI-COST-01): `dev` by `deploy.yml` dispatched on `develop`, `stg` and
`prd` by `promote.yml`, which fast-forwards the branch and deploys in the same run. A merge or a push deploys
nothing. When `promote.yml` exists, every stg and prd deploy goes through it, so the `promote-stg`/`promote-prd`
approvals apply; a direct `infra.yml` dispatch is only for repos that do not have `promote.yml` yet.

| Branch | Environment | GitHub env (deploy) | Gets changes by |
|---|---|---|---|
| `develop` (default branch) | `dev` | `dev` | PR merge (feature, fix and chore PRs; squash allowed) |
| `stage` | `stg` | `stg` | fast-forward push only, by the promotion workflow after the `promote-stg` approval |
| `main` | `prd` | `prd` | fast-forward push only, by the promotion workflow after the `promote-prd` approval |

## Rule: every change enters at `develop`

**Why:** One entry point keeps the invariant true and makes every promotion a known, reviewable SHA. A
change that bypasses `develop` never ran the dev checks before it reached an environment.
**How to apply:** Open feature, fix and chore PRs against `develop`. Never open a PR into `stage` or
`main` (exception: the hotfix rule).
**Anti-example:** A "quick fix" PR against `main` because "it is only one line".

## Rule: promotion is a fast-forward, never a merge or squash

**Why:** `stage := develop@<sha>`, then `main := stage@<sha>`. A merge commit or a squash on
`stage`/`main` creates a commit `develop` lacks, so the next fast-forward fails with a lineage gap.
Squash is the worst: new SHA, same content, permanent divergence.
**How to apply:**
```bash
git fetch origin
SHA=$(git rev-parse origin/develop)     # the verified SHA, resolved once
git push origin "$SHA:refs/heads/stage" # fast-forward only, no --force
# later, after stg deployed that SHA green:
SHA=$(git rev-parse origin/stage)
git push origin "$SHA:refs/heads/main"
```
Git rejects a push that is not a fast-forward. That rejection is the safety net — never bypass it with
`--force`.
**Anti-example:** Merging `develop` into `stage` in the web UI, or squash-merging a "promotion" PR.

## Rule: order is fixed — dev → stg → prd

**Why:** Each environment is the proof the next one needs. Skipping `stg` ships to `prd` a SHA that only
ran on `dev`, where the stg-only config never executed.
**How to apply:** Promote to `stg` only a SHA that deployed green on `dev` (deployment status `success`
for that exact SHA). Promote to `prd` only a SHA that deployed green on `stg` (status `success` plus the
smoke test). Never skip `stg`.
**Anti-example:** Promoting straight from `develop` to `main` "to save time".

## Rule: same SHA everywhere ⇒ same artifact everywhere

**Why:** A rebuild per environment ships different bytes to `prd` than `stg` tested. The same SHA is the
only guarantee that "it worked in stg" still means anything in prd.
**How to apply:** Because promotion is a fast-forward, `prd` runs the exact commit that ran on `stg` and
`dev`. The image built for that SHA on `dev` is the image `stg` and `prd` deploy — build once, promote
the digest, look it up by SHA. After a full release with no new merges, `develop == stage == main` (same
SHA).
**Anti-example:** Rebuilding the image per environment so `prd` runs bytes `stg` never tested.

## Rule: the invariant — check it often

**Why:** The invariant is the one-line proof that no environment is ahead of the one it feeds. A broken
chain means a future fast-forward will fail at the worst time.
**How to apply:**
```bash
git merge-base --is-ancestor origin/main origin/stage \
  && git merge-base --is-ancestor origin/stage origin/develop
```
Both must exit 0. If either fails, stop promoting and repair first (the broken-chain rule).
**Anti-example:** Noticing the invariant is broken and promoting anyway "to unblock the release".

## Rule: push the verified SHA, not the branch name

**Why:** A branch name re-resolves at push time. A merge that lands on `develop` during the approval wait
would be promoted by accident — unapproved and unverified.
**How to apply:** Resolve `SHA=$(git rev-parse origin/develop)` once, run every check on that SHA, then
push `git push origin "$SHA:refs/heads/stage"` (no `--force`). The promotion workflow does exactly this.
**Anti-example:** `git push origin develop:stage` after another merge landed on `develop` during the wait.

## Rule: hotfix

**Why:** A production break cannot always wait for the full dev → stg → prd lane, but a hotfix that
diverges `main` from `develop` breaks the chain if it is not re-synced immediately.
**How to apply:** Default — the fix goes to `develop` by PR and is promoted through `stg` to `prd` on the
fast lane (same gates, minutes not days). Only when `develop` holds unreleased work that must not reach
`prd` **and** `stage == main`:
1. Cut `hotfix/<id>` from `main`.
2. PR into `main` (merge commit, never squash; the branch-policy check allows only `hotfix/*` heads into
   `main`).
3. Immediately (a) fast-forward `stage` to `main` with the promotion workflow
   (`gh workflow run promote.yml -f target=stg-hotfix`), and (b) merge the back-merge PR `main → develop`
   (merge commit, never squash). The branch-sync workflow opens that PR automatically and stays red until
   both are done.
4. Deploy the merged hotfix to `prd`: `gh workflow run promote.yml -f target=prd`. `main` already holds the
   SHA, so the run skips the fast-forward and asks only the `promote-prd` approval.

If `stage != main` (a release is in flight on stg), do not hotfix on `main`: promote or reset the
in-flight release first, or go through `develop`.
**Anti-example:** Cutting a hotfix from `main` while `stage` is one commit ahead of `main`.

## Rule: repair a broken chain by content, not by tree

**Why:** Two kinds of break look identical if you only diff trees. The wrong fix for a content break
silently reverts a hotfix and passes every check.
**How to apply:** First the discriminator:
```bash
MB=$(git merge-base origin/main origin/develop)
git diff --stat "$MB" origin/main
```
- **Empty** → lineage-only gap (promotion merge/squash commits) → content-free reconcile commit:
```bash
MERGE=$(git commit-tree 'origin/develop^{tree}' -p origin/develop -p origin/main -m "chore(promote): reconcile develop lineage with main")
git diff --stat origin/develop "$MERGE"            # must be empty
git merge-base --is-ancestor origin/main "$MERGE"  # must exit 0
# push to develop via PR
```
- **Non-empty** → `main` holds real content (a hotfix) → ordinary `git merge origin/main` into a branch
  off `develop`, resolve, PR with merge commit.

Never use the commit-tree recipe when the discriminator is non-empty — it silently reverts the hotfix and
every check still passes. `git diff origin/develop origin/main` is NOT the discriminator.
**Anti-example:** Running the commit-tree reconcile because "the diff looks small" while the discriminator
is non-empty.

## Rule: a revert adds commits

**Why:** A revert restores the tree but keeps the bad commit and adds the revert commit. Trees look equal,
history does not, and the next fast-forward fails.
**How to apply:** Compare history, not trees: `git rev-list --count origin/stage..origin/main` must be 0.
A mistaken push to `stage`/`main` that was reverted there leaves extra commits on those branches — repair
with the broken-chain rule above.
**Anti-example:** Checking `git diff --stat origin/stage origin/main` (empty, because the revert made the
trees equal) and concluding the branches are in sync.

## Rule: before merging a PR into `develop`, be up to date

**Why:** Two PRs that each pass CI in isolation can conflict semantically and merge cleanly, then break
`develop` for everyone after.
**How to apply:** `strict` required checks. Re-merge `origin/develop` and wait for CI on that exact commit
when several PRs merge in one sitting.
**Anti-example:** Merging three PRs back-to-back from stale heads on a green status from before the first
one landed.

## Rule: stacked PRs — re-merge after the base merges

**Why:** A stacked PR diff includes its base's commits. After the base merges, the stack's branch is stale
and its "merge" would conflict or repeat the base's work.
**How to apply:** Merge `develop` into the stacked PR right after its base merged; diff the merge commit
against its first parent before pushing.
**Anti-example:** Pushing the stack as-is after the base merged, carrying a duplicate of the base's commits.

## Rule: release scope is content, not commit list

**Why:** Cherry-picks and back-merges make `main..develop` overstate the release: commits whose content is
already in `main` still appear in the range.
**How to apply:** Check per commit whether its files still differ before writing release notes. The
release-scope-by-content loop in [promotion-recipes](../promote-release/promotion-recipes.md) does this and
prints only the commits already in prd.
**Anti-example:** Writing release notes from `git log origin/main..origin/develop` and shipping entries for
commits that are already live.

## Enforcement

Server-side, so a workflow edit cannot remove it:

- **One ruleset per branch, named after the branch.** `stage` and `main`: pull request required, required
  status check `branch-policy` (plus `conclusion` on `main`), allowed merge method `merge` only, block force push (`non_fast_forward`), block deletion. The promotion GitHub App
  is the only bypass actor: it skips the pull-request rule for its fast-forward push, and Git still rejects
  anything that is not a fast-forward. `branch-policy` fails every PR into `stage` and every PR into `main`
  whose head is not `hotfix/*`, so the only human path into `main` is a reviewed hotfix PR. Do not use
  "restrict updates" — it blocks the hotfix merge too. No human bypass by default; repo admins documented
  as break-glass only.
- **`develop`:** PR required, 0 approvals (one maintainer), dismiss stale, `strict` required checks
  (`conclusion` from `ci.yml`, and `fleet-check` once the repo has it), conversation resolution, no bypass.
  Allow squash **and** merge commits:
  feature PRs squash, the back-merge PR `sync/main-into-develop` must use a merge commit (a squash keeps
  `main` ahead forever).
- **GitHub environments:** `promote-stg`, `promote-prd`, `tf-apply-prd` (required reviewers, no admin bypass,
  `prevent_self_review: false` while the repo has one maintainer — fleet standard CI-GATE-03; `true` would
  deadlock every gate — and `true` once a second maintainer joins), `dev`/`stg`/`prd` (deploy credentials, NO reviewers, deployment branch policy =
  `develop`/`stage`/`main` respectively), `dev-plan`/`stg-plan`/`prd-plan` (read-only plan credentials, no
  reviewers, no branch policy — the drift job plans every env from one ref, and the identity cannot change
  anything; used by plan-only dispatches and the drift job).
- An environment without `required_reviewers` never waits — the setup script asserts reviewers are non-empty
  on every gate environment.
- **App token, not `GITHUB_TOKEN`:** only the promotion App is a bypass actor on the `stage`/`main`
  rulesets, so the fast-forward push uses its installation token. The deploy after the push is a
  `workflow_dispatch` from the same promotion run (a `GITHUB_TOKEN` dispatch does start a run; a
  `GITHUB_TOKEN` push would not).

## When to deviate

- **Two-environment repos:** drop `stage` and keep the same rules for `main`. The fixed order still applies;
  `main` gets changes by fast-forward only, and promotion is `main := develop@<sha>`.
- **A trunk-only repo with tag deploys is NOT this contract.** One branch, deploys by tag. If it needs
  environment promotion, migrate it to this contract; do not bolt promotion onto tags.
- **A solo repo:** the reviewer is the author (`prevent_self_review: false`, above). Keep the gate as a pause
  for the plan output and say so — it is not a second pair of eyes.
- **A private repo on GitHub Free:** no rulesets, no environments, no reviewers. The dispatch is the approval
  (fleet standard GOV-PRV-02); the `private-free` variant in
  [set-up-terraform-pipeline](../../infra/set-up-terraform-pipeline/workflow-templates.md) shows the changes.
