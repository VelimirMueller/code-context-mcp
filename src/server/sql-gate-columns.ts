// Gate columns for the `execute` escape hatch (CCA-37, #181).
//
// The sprint process sets some columns only through tools that run gates:
// `update_ticket` (sprint phase, commit-format QA gate), `update_sprint` /
// `advance_sprint` (phase transitions and their automation), `sync_github`
// (ownership checks on GitHub ids). A free UPDATE through `execute` skipped all
// of them, so `execute` now refuses any write that names one of these columns.
//
// The check is a token-level parse of the one statement `validateWriteStatement`
// already accepted (single statement, no comments, INSERT/UPDATE/DELETE first).
// It reads the target table and every column the statement writes: the INSERT
// column list, the UPDATE SET list (row values too) and an upsert's
// DO UPDATE SET list. Quoted names ("x", `x`, [x], 'x'), schema prefixes and
// aliases resolve to the plain name. Anything it cannot read on a gated table
// is refused, never let through.

import type { SqlGuardResult } from './sql-guard.js';

type TokKind = 'word' | 'quoted' | 'string' | 'number' | 'param' | 'op';
interface Tok {
  kind: TokKind;
  /** Identifier/keyword/string value: unquoted, unescaped. */
  value: string;
}

/** Thrown when the statement cannot be read; the gate refuses on a gated table. */
class ParseError extends Error {}

const OPS = ['->>', '->', '||', '<=', '>=', '<>', '!=', '==', '<<', '>>'];

export function tokenize(sql: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  const n = sql.length;
  const quoted = (close: string, kind: TokKind, doubled: boolean): void => {
    let j = i + 1;
    let out = '';
    for (;;) {
      if (j >= n) throw new ParseError('unterminated quote');
      const c = sql[j];
      if (c === close) {
        if (doubled && sql[j + 1] === close) {
          out += close;
          j += 2;
          continue;
        }
        break;
      }
      out += c;
      j++;
    }
    toks.push({ kind, value: out });
    i = j + 1;
  };
  while (i < n) {
    const c = sql[i];
    if (/\s/.test(c)) {
      i++;
    } else if (c === '-' && sql[i + 1] === '-') {
      const end = sql.indexOf('\n', i);
      i = end === -1 ? n : end + 1;
    } else if (c === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i + 2);
      if (end === -1) throw new ParseError('unterminated comment');
      i = end + 2;
    } else if (c === "'") {
      quoted("'", 'string', true);
    } else if (c === '"') {
      quoted('"', 'quoted', true);
    } else if (c === '`') {
      quoted('`', 'quoted', true);
    } else if (c === '[') {
      quoted(']', 'quoted', false);
    } else if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(sql[i + 1] ?? ''))) {
      let j = i + 1;
      while (j < n && /[0-9A-Za-z_.]/.test(sql[j])) j++;
      toks.push({ kind: 'number', value: sql.slice(i, j) });
      i = j;
    } else if (/[A-Za-z_\u0080-\uffff]/.test(c)) {
      let j = i + 1;
      while (j < n && /[A-Za-z0-9_$\u0080-\uffff]/.test(sql[j])) j++;
      toks.push({ kind: 'word', value: sql.slice(i, j) });
      i = j;
    } else if (c === '?' || c === ':' || c === '@' || c === '$') {
      let j = i + 1;
      while (j < n && /[A-Za-z0-9_$:]/.test(sql[j])) j++;
      toks.push({ kind: 'param', value: sql.slice(i, j) });
      i = j;
    } else {
      const op = OPS.find((o) => sql.startsWith(o, i)) ?? c;
      toks.push({ kind: 'op', value: op });
      i += op.length;
    }
  }
  return toks;
}

// ─── Gated tables and columns ───────────────────────────────────────────────

interface TableGate {
  /** Tool hint for a gated column, or null when the column is free. */
  column(col: string): string | null;
  /** Tool hint when DELETE is refused on this table, or null when allowed. */
  remove: string | null;
}

const GATES: Record<string, TableGate> = {
  tickets: {
    column: (c) => {
      if (c === 'status') return 'update_ticket (status)';
      if (c === 'qa_verified' || c === 'verified_by')
        return 'update_ticket (qa_verified, verified_by)';
      if (c === 'github_issue') return 'update_ticket (github_issue) or sync_github';
      if (c.startsWith('github_')) return 'sync_github';
      if (c === 'deleted_at')
        return 'update_ticket (status NOT_DONE) or the dashboard delete; tickets are not soft-deleted through execute';
      return null;
    },
    remove: 'update_ticket (status NOT_DONE); tickets are not deleted through execute',
  },
  sprints: {
    column: (c) => {
      if (c === 'status') return 'update_sprint or advance_sprint';
      if (c === 'deleted_at')
        return 'the dashboard sprint delete; sprints are not soft-deleted through execute';
      if (c === 'archived_at')
        return 'the dashboard sprint archive (it checks that the sprint is finished)';
      return null;
    },
    remove:
      'update_sprint or advance_sprint; sprints (and their tickets) are not deleted through execute',
  },
  milestones: {
    column: (c) => {
      if (c === 'github_milestone') return 'update_milestone (github_milestone) or sync_github';
      if (c.startsWith('github_')) return 'sync_github';
      if (c === 'archived_at')
        return 'update_milestone (archived; it checks that the milestone is completed)';
      // The archive check reads status (src/scrum/archive.ts), so status is gated too (#263).
      if (c === 'status') return 'update_milestone (status)';
      return null;
    },
    remove:
      'update_milestone (archived); milestones are not deleted through execute (the delete sets tickets.milestone_id to NULL)',
  },
  epics: {
    column: (c) => {
      if (c === 'archived_at')
        return 'update_epic (archived; it checks that the epic is completed)';
      if (c === 'status') return 'update_epic (status)';
      return null;
    },
    remove:
      'update_epic (archived); epics are not deleted through execute (the delete sets tickets.epic_id to NULL)',
  },
  projects: {
    // sync_github resolves its target from these columns (syncTargetOf in
    // src/scrum/github-sync.ts): name is the lookup key, repo / github_project_owner /
    // github_project_number / github_assignee the target. set_project keeps an
    // already-synced project on its repo unless force=true and allowlisted (#263).
    column: (c) => {
      if (c === 'repo') return 'set_project (repo)';
      if (c === 'name')
        return 'set_project; a project key is not renamed through execute (sync_github looks the project up by it)';
      if (c.startsWith('github_')) return 'set_project or sync_github';
      return null;
    },
    remove:
      'set_project; projects are not deleted through execute (a deleted and re-created key skips the set_project re-point check)',
  },
};

/** Lower-case "table.column" list of every gated column, for docs and tests. */
export const GATE_COLUMN_SUMMARY =
  'tickets.status, tickets.qa_verified, tickets.verified_by, tickets.github_*, tickets.deleted_at, ' +
  'sprints.status, sprints.deleted_at, sprints.archived_at, milestones.status, milestones.github_*, ' +
  'milestones.archived_at, epics.status, epics.archived_at, projects.name, projects.repo, projects.github_*';

// ─── Parser ─────────────────────────────────────────────────────────────────

class Cursor {
  i = 0;
  constructor(readonly toks: Tok[]) {}
  peek(off = 0): Tok | undefined {
    return this.toks[this.i + off];
  }
  done(): boolean {
    return this.i >= this.toks.length;
  }
  isWord(kw: string, off = 0): boolean {
    const t = this.peek(off);
    return t !== undefined && t.kind === 'word' && t.value.toLowerCase() === kw;
  }
  isOp(op: string, off = 0): boolean {
    const t = this.peek(off);
    return t !== undefined && t.kind === 'op' && t.value === op;
  }
  expectWord(kw: string): void {
    if (!this.isWord(kw)) throw new ParseError(`expected ${kw.toUpperCase()}`);
    this.i++;
  }
  expectOp(op: string): void {
    if (!this.isOp(op)) throw new ParseError(`expected "${op}"`);
    this.i++;
  }
  /** One name in a name position: bare word, "quoted", `quoted`, [quoted] or 'string'. */
  name(): string {
    const t = this.peek();
    if (!t || (t.kind !== 'word' && t.kind !== 'quoted' && t.kind !== 'string')) {
      throw new ParseError('expected a name');
    }
    this.i++;
    return t.value.toLowerCase();
  }
  /** A possibly qualified name (schema.table or alias.column): the last part. */
  qualifiedName(): string {
    let last = this.name();
    while (this.isOp('.')) {
      this.i++;
      last = this.name();
    }
    return last;
  }
}

interface WriteShape {
  table: string;
  /** Columns the statement writes; null = every column (INSERT without a column list). */
  columns: string[] | null;
  replace: boolean;
  remove: boolean;
}

/** Read `(a, b, c)` at the cursor (cursor on "("). */
function nameList(cur: Cursor): string[] {
  cur.expectOp('(');
  const out: string[] = [];
  for (;;) {
    out.push(cur.qualifiedName());
    if (cur.isOp(',')) {
      cur.i++;
      continue;
    }
    cur.expectOp(')');
    return out;
  }
}

/**
 * Read a SET list (`a = expr, (b, c) = expr …`) and return the target columns.
 * Stops at a top-level keyword in `stops` or at the end.
 */
function setList(cur: Cursor, stops: Set<string>): string[] {
  const cols: string[] = [];
  for (;;) {
    if (cur.isOp('(')) cols.push(...nameList(cur));
    else cols.push(cur.qualifiedName());
    cur.expectOp('=');
    // Skip the expression up to the next top-level comma or stop keyword.
    let depth = 0;
    let sawExpr = false;
    for (;;) {
      const t = cur.peek();
      const prev = cur.peek(-1);
      if (!t) {
        if (depth !== 0) throw new ParseError('unbalanced parentheses');
        if (!sawExpr) throw new ParseError('expected an expression');
        return cols;
      }
      if (t.kind === 'op' && t.value === '(') depth++;
      else if (t.kind === 'op' && t.value === ')') {
        depth--;
        if (depth < 0) throw new ParseError('unbalanced parentheses');
      } else if (depth === 0 && t.kind === 'op' && t.value === ',') {
        if (!sawExpr) throw new ParseError('expected an expression');
        cur.i++;
        break;
      } else if (
        depth === 0 &&
        t.kind === 'word' &&
        stops.has(t.value.toLowerCase()) &&
        // A stop word ends the list only when it is clause-shaped: it follows a
        // complete expression. `a IS [NOT] DISTINCT FROM b`, `= returning`,
        // `x AND returning` keep it inside the expression. The tail scan in
        // assertNoHiddenSetItems still checks whatever follows.
        endsExpression(prev)
      ) {
        if (!sawExpr) throw new ParseError('expected an expression');
        return cols;
      }
      sawExpr = true;
      cur.i++;
    }
  }
}

const UPDATE_STOPS = new Set(['from', 'where', 'returning', 'order', 'limit']);

/** Keywords that need a right operand: a stop word right after one is part of the expression. */
const OPERAND_KEYWORDS = new Set([
  'and',
  'or',
  'not',
  'is',
  'in',
  'like',
  'glob',
  'regexp',
  'match',
  'between',
  'case',
  'when',
  'then',
  'else',
  'collate',
  'escape',
  'distinct',
  'exists',
  'cast',
  'select',
  'set',
]);

/** True when `prev` can be the last token of a complete expression. */
function endsExpression(prev: Tok | undefined): boolean {
  if (!prev) return false;
  if (prev.kind === 'op') return prev.value === ')';
  if (prev.kind === 'word') return !OPERAND_KEYWORDS.has(prev.value.toLowerCase());
  return true;
}

/**
 * Fail-closed tail check on a gated table, after a SET list ended (CCA-37).
 * A hand-written tokenizer cannot match SQLite's parser exactly: a word it read
 * as the end of the SET list may be an identifier to SQLite (RETURNING, for
 * one, is also a valid column name). Every SET item after the first needs a
 * top-level comma, so scan every remaining token to `until` (or the end) and
 * refuse on a top-level comma anywhere. Before a real WHERE (a reserved word,
 * never an identifier unquoted) a `<name> =` is refused too; after WHERE it is
 * a comparison. Over-refusal (comma joins, ORDER BY a, b, RETURNING lists) is
 * accepted on gated tables.
 */
function assertNoHiddenSetItems(cur: Cursor, until?: (j: number) => boolean): void {
  let depth = 0;
  let afterWhere = false;
  for (let j = cur.i; j < cur.toks.length; j++) {
    if (until?.(j)) return;
    const t = cur.toks[j];
    if (t.kind === 'op' && t.value === '(') depth++;
    else if (t.kind === 'op' && t.value === ')') depth--;
    else if (depth !== 0) continue;
    else if (t.kind === 'word' && t.value.toLowerCase() === 'where') afterWhere = true;
    else if (t.kind === 'op' && t.value === ',') {
      throw new ParseError('a top-level comma after the SET list');
    } else if (!afterWhere && t.kind !== 'op' && t.kind !== 'number' && t.kind !== 'param') {
      const next = cur.toks[j + 1];
      if (next?.kind === 'op' && next.value === '=') {
        throw new ParseError('an assignment after the SET list');
      }
    }
  }
}
const UPSERT_STOPS = new Set(['where', 'on', 'returning']);
const CONFLICT_ALGOS = new Set(['rollback', 'abort', 'replace', 'fail', 'ignore']);

function isWordAt(cur: Cursor, j: number, kw: string): boolean {
  const t = cur.toks[j];
  return t !== undefined && t.kind === 'word' && t.value.toLowerCase() === kw;
}

/** `OR <algorithm>` after INSERT/UPDATE; returns true for OR REPLACE. */
function conflictAlgo(cur: Cursor): boolean {
  if (!cur.isWord('or')) return false;
  cur.i++;
  const algo = cur.name();
  if (!CONFLICT_ALGOS.has(algo)) throw new ParseError('unknown conflict algorithm');
  return algo === 'replace';
}

/** Every column named by an upsert `DO UPDATE SET` clause after the cursor. */
function upsertColumns(cur: Cursor): string[] {
  const cols: string[] = [];
  while (!cur.done()) {
    if (cur.isWord('do') && cur.isWord('update', 1) && cur.isWord('set', 2)) {
      cur.i += 3;
      cols.push(...setList(cur, UPSERT_STOPS));
      // Up to the next ON CONFLICT clause (which upsertColumns reads itself).
      assertNoHiddenSetItems(
        cur,
        (j) => isWordAt(cur, j, 'on') && isWordAt(cur, j + 1, 'conflict'),
      );
    } else {
      cur.i++;
    }
  }
  return cols;
}

function parseInsert(cur: Cursor, replaceVerb: boolean): WriteShape {
  const replace = conflictAlgo(cur) || replaceVerb;
  cur.expectWord('into');
  const table = cur.qualifiedName();
  if (!GATES[table]) return { table, columns: [], replace, remove: false };
  if (cur.isWord('as')) {
    cur.i++;
    cur.name();
  }
  let columns: string[] | null;
  if (
    cur.isOp('(') &&
    !cur.isWord('select', 1) &&
    !cur.isWord('with', 1) &&
    !cur.isWord('values', 1)
  ) {
    columns = nameList(cur);
  } else if (cur.isWord('default') && cur.isWord('values', 1)) {
    cur.i += 2;
    columns = [];
  } else {
    columns = null;
  }
  const upsert = upsertColumns(cur);
  return {
    table,
    columns: columns === null ? null : [...columns, ...upsert],
    replace,
    remove: false,
  };
}

function parseUpdate(cur: Cursor): WriteShape {
  const replace = conflictAlgo(cur);
  const table = cur.qualifiedName();
  if (!GATES[table]) return { table, columns: [], replace, remove: false };
  if (cur.isWord('as')) {
    cur.i++;
    cur.name();
  } else if (!cur.isWord('set') && !cur.isWord('indexed') && !cur.isWord('not')) {
    cur.name(); // bare alias
  }
  if (cur.isWord('indexed')) {
    cur.i++;
    cur.expectWord('by');
    cur.name();
  } else if (cur.isWord('not')) {
    cur.i++;
    cur.expectWord('indexed');
  }
  cur.expectWord('set');
  const columns = setList(cur, UPDATE_STOPS);
  assertNoHiddenSetItems(cur);
  return { table, columns, replace, remove: false };
}

function parseDelete(cur: Cursor): WriteShape {
  cur.expectWord('from');
  return { table: cur.qualifiedName(), columns: [], replace: false, remove: true };
}

function refuse(error: string): SqlGuardResult {
  return { ok: false, error };
}

const REFUSED = 'execute refused:';

/**
 * Refuse a write statement that writes a gate column (or deletes/replaces a
 * gated row). `sql` is the normalized single statement validateWriteStatement
 * accepted. Returns ok for every write that leaves the gate columns alone.
 */
export function checkGateColumns(sql: string): SqlGuardResult {
  let shape: WriteShape;
  try {
    const cur = new Cursor(tokenize(sql));
    const verb = cur.done() ? '' : cur.name();
    if (verb === 'insert') shape = parseInsert(cur, false);
    else if (verb === 'replace') shape = parseInsert(cur, true);
    else if (verb === 'update') shape = parseUpdate(cur);
    else if (verb === 'delete') shape = parseDelete(cur);
    else return refuse(`${REFUSED} only INSERT, UPDATE, or DELETE are allowed.`);
  } catch (err) {
    // Parse errors come only from the verb/table prefix or from a gated table: refuse.
    return refuse(
      `${REFUSED} statement shape not understood (${(err as Error).message}), so it could not be checked ` +
        `for gate columns (${GATE_COLUMN_SUMMARY}). Use update_ticket, update_sprint or the other gate tools ` +
        `for those columns, or rewrite it as one plain INSERT, UPDATE or DELETE.`,
    );
  }

  const gate = GATES[shape.table];
  if (!gate) return { ok: true, sql };

  if (shape.remove) {
    if (gate.remove) {
      return refuse(
        `${REFUSED} DELETE on ${shape.table} would bypass the gates. Use ${gate.remove}.`,
      );
    }
    return { ok: true, sql };
  }
  if (shape.replace) {
    return refuse(
      `${REFUSED} REPLACE on ${shape.table} deletes and re-inserts the row, which resets its gate columns. ` +
        `Use a plain INSERT or UPDATE without gate columns.`,
    );
  }
  if (shape.columns === null) {
    return refuse(
      `${REFUSED} INSERT into ${shape.table} without a column list writes every column, gate columns too. ` +
        `Name the columns and leave out the gate columns (${GATE_COLUMN_SUMMARY}).`,
    );
  }
  for (const col of shape.columns) {
    const tool = gate.column(col);
    if (tool) {
      return refuse(
        `${REFUSED} ${shape.table}.${col} is a gate column. Use ${tool}; it runs the gates.`,
      );
    }
  }
  return { ok: true, sql };
}
