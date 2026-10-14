/**
 * zod schemas for the dashboard write routes (#190).
 *
 * Every POST/PUT/PATCH handler parses its JSON body with one of these before it
 * touches the database. A body that does not match gets a 400 with the field
 * path and the reason, instead of a TypeError or a bad row.
 *
 * The schemas check types only: they accept every body the dashboard app and
 * the bridge send today. Value rules that existed before (enums, colours,
 * phase transitions) stay in the handlers, with their old messages.
 * Unknown keys are dropped; the handlers never read them.
 */
import { z } from 'zod';
import { badRequest } from './validation.js';

/** Parse `body` with `schema`, or throw a 400 that names each bad field. */
export function parseBody<S extends z.ZodType>(schema: S, body: unknown): z.infer<S> {
  const r = schema.safeParse(body);
  if (r.success) return r.data;
  const msg = r.error.issues
    .map((i) => (i.path.length ? `${i.path.join('.')}: ${i.message}` : i.message))
    .join('; ');
  throw badRequest(msg || 'invalid request body');
}

const id = z.number().int();
const optId = id.nullable().optional();
const optText = z.string().nullable().optional();
/** A required non-empty string; `message` is the error for missing or empty. */
const required = (message: string) => z.string({ error: message }).min(1, message);
/** Booleans, or 0/1 from older clients. */
const flag = z.union([z.boolean(), z.literal(0), z.literal(1)]);

const object = <T extends z.ZodRawShape>(shape: T) =>
  z.object(shape, { error: 'request body must be a JSON object' });

// ─── Agents ─────────────────────────────────────────────────────────────────
export const AgentCreateBody = object({
  role: required('role and name are required'),
  name: required('role and name are required'),
  description: optText,
  model: optText,
});
export const AgentUpdateBody = object({
  name: z.string().optional(),
  description: optText,
  model: optText,
});

// ─── Milestones / vision ────────────────────────────────────────────────────
export const MilestoneCreateBody = object({
  name: required('name is required'),
  description: optText,
  target_date: optText,
  status: optText,
});
export const MilestoneUpdateBody = object({
  status: optText,
  description: optText,
  progress: z.number().optional(),
  target_date: optText,
});
export const VisionBody = object({ content: required('content is required') });

// ─── Discoveries ────────────────────────────────────────────────────────────
export const DiscoveryLinkBody = object({ ticket_id: id });
export const DiscoveryUpdateBody = object({
  status: optText,
  priority: optText,
  drop_reason: optText,
});

// ─── Sprint stuck / blockers / bugs / retro findings ───────────────────────
export const SprintStuckBody = object({ phase: optText });
export const BlockerCreateBody = object({
  description: required('description required'),
  ticket_id: optId,
  reported_by: optText,
  escalated_to: optText,
});
export const StatusOnlyBody = object({ status: optText });
export const BugCreateBody = object({
  description: required('description and severity required'),
  severity: required('description and severity required'),
  ticket_id: optId,
  steps_to_reproduce: optText,
  expected: optText,
  actual: optText,
});
export const RetroFindingCreateBody = object({
  category: required('category and finding required'),
  finding: required('category and finding required'),
  role: optText,
  action_owner: optText,
});
export const RetroFindingUpdateBody = object({
  action_applied: flag.optional(),
  action_owner: optText,
  linked_ticket_id: optId,
});

// ─── Sprints ────────────────────────────────────────────────────────────────
export const PlanSprintBody = object({
  name: required('name is required'),
  goal: optText,
  ticketIds: z.array(id).optional(),
  ticket_ids: z.array(id).optional(),
  targetVelocity: z.number().optional(),
  velocity_committed: z.number().optional(),
  startDate: optText,
  start_date: optText,
  endDate: optText,
  end_date: optText,
}).refine((b) => b.ticketIds !== undefined || b.ticket_ids !== undefined, {
  message: 'ticket_ids array is required',
});
export const SprintUpdateBody = object({
  status: z.string().optional(),
  goal: optText,
  velocity_committed: z.number().nullable().optional(),
  velocity_completed: z.number().nullable().optional(),
});
export const MilestoneLinkBody = object({ milestone_id: optId });

// ─── Epics ──────────────────────────────────────────────────────────────────
export const EpicCreateBody = object({
  name: required('name is required'),
  description: optText,
  milestone_id: optId,
  priority: z.number().int().optional(),
  status: optText,
  color: optText,
});
export const EpicUpdateBody = object({
  name: optText,
  description: optText,
  milestone_id: optId,
  priority: z.number().int().optional(),
  status: optText,
  color: optText,
});
export const EpicLinkBody = object({ epic_id: optId });

// ─── Tickets ────────────────────────────────────────────────────────────────
export const TicketCreateBody = object({
  title: required('title is required'),
  description: optText,
  priority: optText,
  sprint_id: optId,
  epic_id: optId,
  milestone_id: optId,
  assigned_to: optText,
  story_points: z.number().nullable().optional(),
});
export const TicketUpdateBody = object({
  title: z.string().optional(),
  description: optText,
  priority: z.string().optional(),
  status: z.string().optional(),
  assigned_to: optText,
  story_points: z.number().nullable().optional(),
  qa_verified: flag.optional(),
  review_status: optText,
  epic_id: optId,
  milestone_id: optId,
});
/**
 * PATCH /api/ticket/:id keeps its own field rules and messages (D1b); the
 * schema only makes sure the body is an object.
 */
export const TicketPatchBody = z.record(z.string(), z.unknown(), {
  error: 'request body must be a JSON object',
});

// ─── Bridge / restore / sprint process ─────────────────────────────────────
export const BridgeActionBody = object({
  action: required('action is required'),
  entity_type: optText,
  entity_id: optId,
  payload: z.unknown().optional(),
  source: optText,
});
export const BridgeRespondBody = object({
  result: z.unknown().refine((v) => !!v, { message: 'result is required' }),
});
export const RestoreBody = object({
  version: z.union([z.string(), z.number()]),
  tables: z.record(z.string(), z.unknown()),
  // #230: a clash with an existing row aborts the restore unless "skip".
  on_conflict: z.enum(['abort', 'skip']).optional(),
  dry_run: z.boolean().optional(),
});
export const SprintProcessBody = object({
  phases: z
    .array(
      z.object(
        {
          name: required('Each phase requires a name'),
          criteria: z.array(z.string(), { error: 'criteria must be an array' }),
          actions: z.array(z.string(), { error: 'actions must be an array' }),
          duration: z.string().default(''),
        },
        { error: 'Each phase requires a name' },
      ),
      { error: 'phases array is required' },
    )
    .min(1, 'phases array is required'),
});
