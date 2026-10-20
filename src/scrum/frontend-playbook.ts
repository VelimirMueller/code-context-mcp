import type Database from 'better-sqlite3';
import { execFileSync } from 'node:child_process';
import { getEnabledSkillSets, SKILL_SETS, type SkillSetDef } from './skill-sets.js';

/** Read one skill's full content by name. Returns null if the skill is absent or has no content. */
export function getSkillContent(db: Database.Database, name: string): string | null {
  const row = db.prepare(`SELECT content FROM skills WHERE name = ?`).get(name) as
    | { content: string | null }
    | undefined;
  return row?.content ?? null;
}

/** Pull the `description:` line out of a SKILL.md YAML frontmatter block. */
export function parseSkillSummary(content: string): string {
  const fm = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!fm) return '';
  const m = fm[1].match(/^description:\s*(.+)$/m);
  if (!m) return '';
  const val = m[1].trim().replace(/\r$/, '');
  if (val === '|' || val === '>') return ''; // YAML block-scalar indicator, not a summary
  return val.replace(/^["']|["']$/g, '').slice(0, 120);
}

/**
 * Index lines for one skill set: top-level skills only. Companion docs
 * (`<prefix>:<skill>/<file>`), shared docs (`<prefix>:_shared/...`) and the
 * primer are excluded — they are reachable on demand via get_skill.
 * Returns [] when the set has no skills seeded.
 */
export function buildSkillSetIndex(db: Database.Database, set: SkillSetDef): string[] {
  const rows = db
    .prepare(
      `SELECT name, content FROM skills
       WHERE name LIKE ? AND name NOT LIKE ?
       ORDER BY name`,
    )
    .all(`${set.prefix}:%`, `${set.prefix}:%/%`) as { name: string; content: string }[];
  // `_`-prefixed entries are meta (primer, _shared); LIKE can't exclude them without
  // an ESCAPE clause (`_` is a wildcard), so filter here.
  const skills = rows.filter((r) => !r.name.startsWith(`${set.prefix}:_`));
  return skills.map((r) => {
    const summary = parseSkillSummary(r.content);
    return `- \`${r.name}\`${summary ? ` — ${summary}` : ''}`;
  });
}

/**
 * Build the Frontend Playbook markdown injected into the session: the editable
 * house-style primer plus an index of top-level frontend skills — and, when the
 * landing set is enabled, the landing index (landing work is fe-engineer work).
 * Returns null when the frontend set is disabled or nothing is seeded.
 */
export function buildFrontendPlaybook(db: Database.Database): string | null {
  const enabled = getEnabledSkillSets(db);
  if (!enabled.frontend) return null;

  const primer = db.prepare(`SELECT content FROM skills WHERE name = 'fe:_house-style'`).get() as
    | { content: string }
    | undefined;
  const feSet = SKILL_SETS.find((s) => s.id === 'frontend')!;
  const index = buildSkillSetIndex(db, feSet);

  if (!primer?.content && index.length === 0) return null;

  const sections: string[] = ['', '## Frontend Playbook'];
  if (primer?.content) sections.push(primer.content.trim());
  if (index.length) {
    sections.push(
      '',
      '### Available frontend skills',
      'Load full guidance with `get_skill({ name })`:',
      ...index,
    );
  }
  if (enabled.landing) {
    const laSet = SKILL_SETS.find((s) => s.id === 'landing')!;
    const laIndex = buildSkillSetIndex(db, laSet);
    if (laIndex.length) {
      sections.push(
        '',
        '### Available landing-page skills',
        'Load full guidance with `get_skill({ name })`:',
        ...laIndex,
      );
    }
  }
  return sections.join('\n');
}

/**
 * Workflow (PRs & commits) index for implementation-phase context. Role-agnostic:
 * applies to every implementer, not just fe tickets. Returns null when the
 * workflow set is disabled or nothing is seeded.
 */
export function buildWorkflowPlaybook(db: Database.Database): string | null {
  const enabled = getEnabledSkillSets(db);
  if (!enabled.workflow) return null;
  const wfSet = SKILL_SETS.find((s) => s.id === 'workflow')!;
  const index = buildSkillSetIndex(db, wfSet);
  if (index.length === 0) return null;
  return [
    '',
    '## Core Skills',
    'Use these for commits, pull requests, security and toolchain audits, and the stack profile — load with `get_skill({ name })`:',
    ...index,
  ].join('\n');
}

/** The skill row the Commit contract block is distilled from. */
export const COMMIT_SKILL_NAME = 'wf:write-commit-messages';

/**
 * Compact "Commit contract" derived live from the `wf:write-commit-messages`
 * skill so a delegated subagent prompt carries the contract verbatim instead of
 * relying on the agent pulling the skill. Single-sourced: every line below is
 * extracted from the stored SKILL.md, so editing the skill (→ regenerate
 * defaults → reseed) updates the injected block — there is no second copy.
 *
 * Extraction targets, all stable structural anchors in the skill:
 *  - subject rule: the first sentence of the first paragraph under `## 3. Draft the subject`
 *    (a paragraph, not a line: re-wrapping the markdown must not cut the rule in half)
 *  - body template: the fenced ```text Why/What/How block under `## 4.`
 *  - trailer note: emitted when the skill still names a `Co-Authored-By:` trailer
 *
 * Returns null if the skill row is absent or either anchor is missing (workflow
 * set enabled but content not seeded / restructured) — caller omits the block
 * rather than ship a stale paraphrase. The block is intentionally ≤ ~15 lines:
 * it rides in every delegated prompt, so token diet matters (see C1 comments).
 */
export function buildCommitContract(db: Database.Database): string | null {
  // Skill CONTENT is always seeded; only SERVE it when the project opted into
  // the workflow set — mirrors buildWorkflowPlaybook's enablement gate (AC1).
  if (!getEnabledSkillSets(db).workflow) return null;
  const content = getSkillContent(db, COMMIT_SKILL_NAME);
  if (!content) return null;

  // Step 3 → the subject rule: the first sentence of the first paragraph after the heading.
  const subjectSection = content.split(/^## 3\. Draft the subject\s*$/m)[1];
  const firstParagraph = subjectSection
    ?.trim()
    .split(/\r?\n\s*\r?\n/)[0]
    ?.split(/\r?\n/)
    .map((l) => l.trim())
    .join(' ');
  const subjectRule = firstParagraph?.match(/^.*?[.!?](?=\s|$)/)?.[0] ?? firstParagraph;

  // Step 4 → the fenced ```text Why/What/How template (the canonical body shape).
  const bodySection = content.split(/^## 4\./m)[1];
  const bodyTemplate = bodySection?.match(/```text\r?\n([\s\S]*?)\r?\n```/)?.[1];

  if (!subjectRule || !bodyTemplate) return null; // skill restructured → omit, don't fabricate

  const trailerNote = /Co-Authored-By:/.test(content)
    ? 'Preserve the house trailer(s) the audit detects (e.g. `Co-Authored-By:`) after the three groups.'
    : null;

  const lines = [
    '',
    '### Commit contract',
    `Apply this when committing — distilled from \`${COMMIT_SKILL_NAME}\`; load it with \`get_skill\` for the full discipline.`,
    `- **Subject:** ${subjectRule}`,
    // "exactly three": the QA commit gate (COMMIT_BODY_LABELS) enforces Why/What/How, so the contract must not promise less
    '- **Body:** exactly three labeled bullet groups, every bullet derived from the diff:',
    '```text',
    bodyTemplate,
    '```',
  ];
  if (trailerNote) lines.push(`- ${trailerNote}`);
  return lines.join('\n');
}

// ─── T-274: QA-gate commit-format check ──────────────────────────────────────

/** The three labeled body groups the house commit contract requires, in order. */
const COMMIT_BODY_LABELS = ['Why:', 'What:', 'How:'] as const;

/** One commit on the branch that references the ticket and the labels it is missing. */
export interface CommitFormatViolation {
  /** Short hash (git's abbreviated %h). */
  hash: string;
  /** First line of the commit (for the operator to recognise it). */
  subject: string;
  /** Which of Why:/What:/How: the body lacks (order-aware — see checker). */
  missing: string[];
}

export interface CommitFormatResult {
  /** True when every referencing commit conforms (or there were none / the check was skipped). */
  ok: boolean;
  /** Non-conforming commits. Empty when ok. */
  violations: CommitFormatViolation[];
  /** Number of referencing commits inspected (merges excluded). */
  inspected: number;
  /** True when no commit referenced the ref — the ticket is exempt (docs/process work). */
  exempt: boolean;
  /** True when the check could not run (no git / no `main` / not a repo) — fail-open. */
  skipped: boolean;
  /** Human-readable reason when skipped or exempt; null otherwise. */
  note: string | null;
}

/**
 * AC: the body must contain all three labels `Why:` / `What:` / `How:` at the
 * start of a line (leading whitespace tolerated), in that order. Returns the
 * labels that are missing or out of order; an empty array means conforming.
 *
 * Order matters: a body listing How: before Why: is malformed even if all three
 * tokens appear, so we walk the labels in sequence and require each to occur at
 * or after the previous one's position.
 */
export function missingCommitBodyLabels(body: string): string[] {
  const missing: string[] = [];
  let cursor = 0; // earliest line index a still-unmatched label may appear at
  const lines = body.split(/\r?\n/);
  for (const label of COMMIT_BODY_LABELS) {
    // line-start, leading whitespace tolerated, label is its own token (case-sensitive).
    const idx = lines.findIndex((line, i) => i >= cursor && new RegExp(`^\\s*${label}`).test(line));
    if (idx === -1) missing.push(label);
    else cursor = idx + 1; // next label must come strictly after this one (enforces order)
  }
  return missing;
}

/**
 * T-274: inspect the branch commits that reference `ref` (git log --grep on the
 * exact ticket token, e.g. "T-274") and verify each body carries the three
 * labeled groups Why:/What:/How:. Synchronous (execFileSync, 5s cap) to match
 * the codebase's sync git style (checkDistFreshness / defaults.ts).
 *
 * Range: `main..HEAD` — commits on the current branch not yet on the default
 * branch. Merge commits (2+ parents) are exempt from the body check.
 *
 * FAIL-OPEN (AC3): any failure to resolve git, the repo, or the `main` base
 * (missing binary, detached/empty repo, no default branch) returns
 * `{ ok:true, skipped:true, note }` — a missing git binary must never strand a
 * ticket. Likewise a ref with zero referencing commits returns
 * `{ ok:true, exempt:true }` so docs/process tickets close unhindered (AC1).
 */
export function checkCommitFormat(
  ref: string,
  opts: { cwd?: string; base?: string; timeoutMs?: number } = {},
): CommitFormatResult {
  const cwd = opts.cwd ?? process.cwd();
  const base = opts.base ?? 'main';
  const timeout = opts.timeoutMs ?? 5000;
  const pass = (extra: Partial<CommitFormatResult>): CommitFormatResult => ({
    ok: true,
    violations: [],
    inspected: 0,
    exempt: false,
    skipped: false,
    note: null,
    ...extra,
  });

  const git = (args: string[]): string =>
    execFileSync('git', args, {
      cwd,
      timeout,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 4 * 1024 * 1024,
    });

  // Resolve the range base. If `main` does not exist (or this is not a repo),
  // degrade gracefully rather than block.
  let range: string;
  try {
    git(['rev-parse', '--verify', '--quiet', `${base}^{commit}`]);
    range = `${base}..HEAD`;
  } catch {
    return pass({
      skipped: true,
      note: `commit-format check skipped — '${base}' not resolvable here (not a git repo, or '${base}' missing); failing open`,
    });
  }

  // Collect the referencing commits (hash + parent count) NUL-delimited so
  // subjects with odd characters can't corrupt parsing.
  let raw: string;
  try {
    // %h short-hash | %P parent hashes | %s subject — record-separated by \x1e.
    // Merges are NOT filtered out here; we include them so parent-count can mark
    // them exempt below (and so a merge can't hide a referencing commit).
    raw = git(['log', range, '--grep', ref, '--format=%h%x1f%P%x1f%s%x1e']);
  } catch (e) {
    const err = e instanceof Error ? (e as NodeJS.ErrnoException) : undefined;
    const why = err ? (err.code ?? err.message) : String(e);
    return pass({
      skipped: true,
      note: `commit-format check skipped — git log failed (${why || 'unknown'}); failing open`,
    });
  }

  const records = raw
    .split('\x1e')
    .map((r) => r.trim())
    .filter(Boolean);
  if (records.length === 0) {
    return pass({
      exempt: true,
      note: `no commits reference ${ref} on ${range} — exempt from the commit-format gate`,
    });
  }

  const violations: CommitFormatViolation[] = [];
  let inspected = 0;
  for (const rec of records) {
    const [hash, parents, subject] = rec.split('\x1f');
    if (!hash) continue;
    // Merge commits (2+ parents) are exempt from the body check.
    if ((parents ?? '').trim().split(/\s+/).filter(Boolean).length >= 2) continue;
    inspected++;
    let body: string;
    try {
      body = git(['log', '-1', '--format=%B', hash]);
    } catch {
      // Couldn't read this commit's body — fail-open for this one rather than block.
      continue;
    }
    const missing = missingCommitBodyLabels(body);
    if (missing.length > 0) violations.push({ hash, subject: subject ?? '', missing });
  }

  return pass({ ok: violations.length === 0, violations, inspected });
}

/**
 * T-274: render the ⛔ blocked-close message (house planning-gate style) when
 * `qa_verified` is gated by non-conforming commits. Names every offending hash
 * and gives the amend-vs-note-for-squash remediation hint.
 */
export function formatCommitFormatBlock(ref: string, result: CommitFormatResult): string {
  const lines = [
    `⛔ QA VERIFY BLOCKED — commit format (${ref})`,
    ``,
    `${result.violations.length} commit(s) referencing ${ref} lack the required Why:/What:/How: body groups:`,
  ];
  for (const v of result.violations) {
    const subj = v.subject
      ? ` ${v.subject.length > 60 ? v.subject.slice(0, 57) + '…' : v.subject}`
      : '';
    lines.push(`- ${v.hash}${subj} — missing ${v.missing.join(', ')}`);
  }
  lines.push(
    ``,
    `Fix each commit so its body carries the three labeled groups (\`Why:\` / \`What:\` / \`How:\`), then re-verify:`,
    `- unpushed → \`git rebase -i\` / \`git commit --amend\` to rewrite the body;`,
    `- already pushed → add a squash note in the PR so the merge commit carries the groups (don't rewrite published history).`,
    `Load \`get_skill({ name: "${COMMIT_SKILL_NAME}" })\` for the full discipline.`,
  );
  return lines.join('\n');
}
