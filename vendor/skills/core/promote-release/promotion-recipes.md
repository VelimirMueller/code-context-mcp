# Promotion Recipes

Full commands for [promote-release](./SKILL.md). Contract and rules:
[../_shared/branch-promotion.md](../_shared/branch-promotion.md).

## Fast-forward promotion (manual)

```bash
git fetch origin --prune
SHA=$(git rev-parse origin/develop)
git merge-base --is-ancestor origin/stage origin/develop || exit 1   # ff possible only
git merge-base --is-ancestor origin/main origin/stage || exit 1      # invariant holds
git log --oneline origin/stage..$SHA
git push origin "$SHA:refs/heads/stage"                              # no --force
gh workflow run infra.yml --ref stage -f environment=stg -f mode=apply  # only without promote.yml
```

Wait for stg green, then:

```bash
SHA=$(git rev-parse origin/stage)
git merge-base --is-ancestor origin/main origin/stage || exit 1
git log --oneline origin/main..$SHA
git push origin "$SHA:refs/heads/main"                               # no --force
gh workflow run infra.yml --ref main -f environment=prd -f mode=apply    # only without promote.yml
```

## Hotfix on main — both paths

**Default path:** the fix goes to `develop` by PR and is promoted through `stg` to `prd` on the fast lane.
Same gates, minutes not days. No special commands.

**Main path** — only when `develop` holds unreleased work that must not reach `prd` **and**
`stage == main`:

```bash
git fetch origin --prune
test "$(git rev-parse origin/stage)" = "$(git rev-parse origin/main)" || exit 1   # stage == main required
git checkout -b hotfix/<id> origin/main
# ... make the fix, commit, push ...
gh pr create --base main --head hotfix/<id>
# merge it as a MERGE COMMIT, never squash; branch-policy allows only hotfix/* heads into main
# then immediately (a) fast-forward stage to main:  gh workflow run promote.yml -f target=stg-hotfix
# and (b) back-merge main into develop (below; branch-sync opens this PR for you),
# and (c) deploy it: gh workflow run promote.yml -f target=prd   (skips the fast-forward, asks promote-prd)
```

If `stage != main` (a release is in flight on stg), do not hotfix on `main`: promote or reset the
in-flight release first, or go through `develop`.

## Back-merge main → develop (merge commit, never squash)

```bash
git fetch origin --prune
git checkout -b sync/main-into-develop origin/develop
git merge origin/main -m "chore(sync): back-merge main into develop"   # merge commit; never --squash, never --ff-only
git push -u origin sync/main-into-develop
gh pr create --base develop --head sync/main-into-develop
```

Never squash: a squash re-creates the hotfix under a new SHA that `main` still lacks, so the chain stays
broken. The branch-sync workflow opens this PR automatically.

## Reconcile with the content discriminator

```bash
MB=$(git merge-base origin/main origin/develop)
git diff --stat "$MB" origin/main
```

> **WARNING:** never use the commit-tree recipe when the discriminator is non-empty — it silently reverts
> the hotfix and every check still passes. `git diff origin/develop origin/main` is NOT the discriminator.

**Discriminator empty** (lineage-only gap — promotion merge/squash commits):

```bash
MERGE=$(git commit-tree 'origin/develop^{tree}' -p origin/develop -p origin/main -m "chore(promote): reconcile develop lineage with main")
git diff --stat origin/develop "$MERGE"            # must be empty
git merge-base --is-ancestor origin/main "$MERGE"  # must exit 0
git checkout -b reconcile-develop origin/develop
git push origin "${MERGE}:refs/heads/reconcile-develop"   # see the zsh note below
gh pr create --base develop --head reconcile-develop
```

**Discriminator non-empty** (`main` holds real content — a hotfix):

```bash
git checkout -b reconcile-develop origin/develop
git merge origin/main -m "chore(sync): merge main into develop"   # resolve conflicts; merge commit
git push -u origin reconcile-develop
gh pr create --base develop --head reconcile-develop
```

**zsh note:** quote the refspec — `git push origin "${MERGE}:refs/heads/reconcile-develop"`. Unquoted, zsh
reads `$MERGE:r…` as the `:r` history modifier on `MERGE`, and the push fails with `src refspec … does not match any`.
Merge the reconcile PR with a **merge commit** (or fast-forward), never a squash — a squash drops the second parent
and the lineage gap stays.

## Revert-on-main repair

A mistaken push to `stage`/`main` that is reverted there leaves the same tree but extra commits, so the
next fast-forward fails. Detect it by history, not trees:

```bash
git rev-list --count origin/stage..origin/main   # extra commits on main; must be 0
git diff --stat origin/stage origin/main         # may be EMPTY — that is the trap
```

The trees are equal (the revert restored them) but history diverges. Repair with the reconcile recipe
above: the discriminator is empty, so the commit-tree reconcile gives `develop` the missing lineage. Never
force-push — the rulesets forbid it, and it rewrites history you would have to reconcile anyway.

## Stale lock / stale waiting run

**Stale waiting run** — a run waiting at an approval blocks every later run of that environment. Reject
superseded pending deployments instead of approving a days-old plan:

```bash
for b in stage main; do gh run list --branch "$b" --status waiting --json databaseId,displayTitle,headSha; done
gh api "repos/{owner}/{repo}/actions/runs/<id>/pending_deployments" --jq '.[].environment | {id, name}'
gh api -X POST "repos/{owner}/{repo}/actions/runs/<id>/pending_deployments" \
  -F 'environment_ids[]=<env-id>' -f state=rejected -f comment="superseded by $SHA"
```

**Stale Terraform lock** — a cancelled run can leave the state lock (the blob lease is never released):

```bash
# 1. confirm no run is in progress; 2. match the lock's created time to a cancelled run
terraform force-unlock <lock-id>            # or: az storage blob lease break <blob> ...
```

Keep `timeout-minutes` on plan/apply jobs so a hung job releases the lock instead of holding it forever.

## Release scope by content

Cherry-picks and back-merges make `main..develop` overstate the release. Run this loop to print every
non-merge commit whose files no longer differ between `main` and `develop` — those are already in prd and
belong out of the release notes:

```bash
for c in $(git rev-list --no-merges origin/main..origin/develop); do
  d=0
  while read -r f; do
    [ -z "$f" ] && continue
    git diff --quiet origin/main origin/develop -- "$f" || d=$((d+1))
  done <<< "$(git show --name-only --format= "$c")"
  [ "$d" -eq 0 ] && echo "ALREADY-IN-PRD $(git log -1 --format=%s "$c")"
done
```

A commit with no file that differs is already live; drop it from the release notes and the changelog.

## When to deviate

- **Two-environment repos:** drop `stage` and keep the same rules for `main`; promotion is
  `main := develop@<sha>`.
- **A trunk-only repo with tag deploys is NOT this contract.** Migrate it before using these recipes; do
  not bolt promotion onto tags.
- **A solo repo:** the reviewer is the author. Keep the gate as a pause for the plan output and say so —
  it is not a second pair of eyes.
