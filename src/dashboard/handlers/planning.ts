/**
 * Planning API handlers — milestones (first step of the handlers/planning.ts
 * migration planned in ./index.ts). Each function takes the shared read-write
 * connection and returns plain data; the router in dashboard.ts calls
 * `notifyClients()` after a write.
 */
import type Database from 'better-sqlite3';
import type { MilestoneRow } from '../../scrum/rows.js';
import { validateEnum } from './validation.js';
import { parseBody, MilestoneUpdateBody } from './schemas.js';

const notFound = () => Object.assign(new Error('milestone not found'), { status: 404 });

/**
 * PUT /api/milestone/:id. The UPDATE itself requires a live row
 * (`deleted_at IS NULL`) and returns it, so a milestone deleted after the
 * first check gets 404, never a 200 for a write that changed nothing (#214).
 */
export function apiMilestoneUpdate(db: Database.Database, id: number, raw: unknown): MilestoneRow {
  const body = parseBody(MilestoneUpdateBody, raw);
  // Early check: a missing milestone gets 404 before the body rules (400).
  const existing = db
    .prepare('SELECT id FROM milestones WHERE id = ? AND deleted_at IS NULL')
    .get(id);
  if (!existing) throw notFound();
  const sets: string[] = [];
  const vals: (string | number | null)[] = [];
  if (body.status != null) {
    validateEnum(body.status, ['planned', 'active', 'completed'], 'milestone status');
    sets.push('status=?');
    vals.push(body.status);
  }
  // Clearable text: a string sets the value, null or '' clears it, absent keeps it.
  if (body.description !== undefined) {
    sets.push('description=?');
    vals.push(body.description || null);
  }
  if (body.progress !== undefined) {
    sets.push('progress=?');
    vals.push(body.progress);
  }
  if (body.target_date !== undefined) {
    sets.push('target_date=?');
    vals.push(body.target_date || null);
  }
  if (sets.length === 0) throw Object.assign(new Error('nothing to update'), { status: 400 });
  sets.push("updated_at=datetime('now')");
  vals.push(id);
  // Check and write in one statement; RETURNING gives the saved row (#205).
  const saved = db
    .prepare(
      `UPDATE milestones SET ${sets.join(',')} WHERE id = ? AND deleted_at IS NULL RETURNING *`,
    )
    .get(...vals) as MilestoneRow | undefined;
  if (!saved) throw notFound();
  return saved;
}
