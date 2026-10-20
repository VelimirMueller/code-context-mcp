/**
 * The bridge actions the PreToolUse hook may forward to the agent (#244, TM-03).
 *
 * Each forwarded action has a strict payload schema: known keys only, typed,
 * every string length-capped, no control characters and no backticks. The
 * dashboard API checks a new action with these schemas, and the hook checks
 * every row again before injection, because a row can also reach
 * `pending_actions` through `execute`, an import or a restore.
 *
 * There is no free-form action: `custom` is gone.
 */
import { z } from 'zod';

/** Upper limit for the JSON text of one payload, in UTF-8 bytes. */
export const MAX_BRIDGE_PAYLOAD_BYTES = 4096;

/** Actions the hook forwards to the agent. */
export const FORWARDED_BRIDGE_ACTIONS = [
  'run_kickoff',
  'advance_sprint',
  'assign_ticket',
  'update_ticket',
  'create_ticket',
  'plan_sprint',
] as const;

/** Actions only the dashboard handles; the hook never forwards them. */
export const UI_ONLY_BRIDGE_ACTIONS = ['run_retro', 'run_review', 'request_input'] as const;

export type ForwardedBridgeActionName = (typeof FORWARDED_BRIDGE_ACTIONS)[number];

export function isForwardedBridgeAction(action: string): action is ForwardedBridgeActionName {
  return (FORWARDED_BRIDGE_ACTIONS as readonly string[]).includes(action);
}

/** UTF-8 byte length of a payload: JSON text as is, any other value as its JSON. */
export function bridgePayloadBytes(payload: unknown): number {
  if (payload === undefined || payload === null) return 0;
  return Buffer.byteLength(typeof payload === 'string' ? payload : JSON.stringify(payload), 'utf8');
}

/** Plain text: no control characters and no backticks (they could close the JSON fence). */
const text = (min: number, max: number) =>
  z
    .string()
    .min(min)
    .max(max)
    .regex(/^[^\x00-\x1f\x7f`]*$/, 'must not contain control characters or backticks');
const ticketRef = z.string().regex(/^[A-Za-z0-9_-]{1,32}$/, 'must be a ticket ref like T-12');
const agentRole = z.string().regex(/^[A-Za-z0-9_. -]{1,64}$/, 'must be an agent role');
const ticketStatus = z.enum(['TODO', 'IN_PROGRESS', 'DONE', 'BLOCKED', 'PARTIAL', 'NOT_DONE']);
const priority = z.enum(['P0', 'P1', 'P2', 'P3']);
const rowId = z.number().int().positive();

const noEntity = { entity_type: z.null().optional(), entity_id: z.null().optional() };
const entity = (type: 'ticket' | 'sprint') => ({
  entity_type: z.literal(type),
  entity_id: rowId,
});

/** The forwarded action with its entity and payload; unknown payload keys are refused. */
export const ForwardedBridgeAction = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('run_kickoff'),
    ...noEntity,
    payload: z.object({}).strict().nullish(),
  }),
  z.object({
    action: z.literal('advance_sprint'),
    ...entity('sprint'),
    payload: z
      .object({ velocity_completed: z.number().int().min(0).max(10_000).optional() })
      .strict()
      .nullish(),
  }),
  z.object({
    action: z.literal('assign_ticket'),
    ...entity('ticket'),
    payload: z
      .object({ ticket_ref: ticketRef.optional(), assigned_to: agentRole.optional() })
      .strict()
      .nullish(),
  }),
  z.object({
    action: z.literal('update_ticket'),
    ...entity('ticket'),
    payload: z
      .object({
        ticket_ref: ticketRef.optional(),
        status: ticketStatus.optional(),
        assigned_to: agentRole.optional(),
      })
      .strict()
      .nullish(),
  }),
  z.object({
    action: z.literal('create_ticket'),
    ...noEntity,
    payload: z
      .object({
        sprint_id: rowId.optional(),
        title: text(1, 200),
        priority: priority.optional(),
        assigned_to: agentRole.optional(),
        story_points: z.number().int().min(0).max(100).optional(),
      })
      .strict(),
  }),
  z.object({
    action: z.literal('plan_sprint'),
    ...noEntity,
    payload: z
      .object({
        name: text(1, 100).optional(),
        goal: text(0, 300).optional(),
        ticket_ids: z.array(rowId).max(50).optional(),
        velocity_committed: z.number().int().min(0).max(10_000).optional(),
      })
      .strict()
      .nullish(),
  }),
]);
export type ForwardedBridgeAction = z.infer<typeof ForwardedBridgeAction>;

export type BridgeActionCheck =
  | { ok: true; value: ForwardedBridgeAction }
  | { ok: false; error: string };

/** Check one action, with its parsed payload, before it is queued or forwarded. */
export function checkForwardedBridgeAction(input: {
  action: string;
  entity_type?: string | null;
  entity_id?: number | null;
  payload?: unknown;
}): BridgeActionCheck {
  if (!isForwardedBridgeAction(input.action)) {
    return { ok: false, error: `action ${JSON.stringify(input.action)} is not forwarded` };
  }
  if (bridgePayloadBytes(input.payload) > MAX_BRIDGE_PAYLOAD_BYTES) {
    return { ok: false, error: `payload: over ${MAX_BRIDGE_PAYLOAD_BYTES} bytes` };
  }
  const r = ForwardedBridgeAction.safeParse(input);
  if (r.success) return { ok: true, value: r.data };
  const error = r.error.issues
    .map((i) => (i.path.length ? `${i.path.join('.')}: ${i.message}` : i.message))
    .join('; ');
  return { ok: false, error };
}

/** Check a `pending_actions` row: the size cap on the raw JSON text first, then the schema. */
export function checkForwardedBridgeRow(row: {
  action: string;
  entity_type: string | null;
  entity_id: number | null;
  payload: string | null;
}): BridgeActionCheck {
  if (row.payload !== null && bridgePayloadBytes(row.payload) > MAX_BRIDGE_PAYLOAD_BYTES) {
    return { ok: false, error: `payload: over ${MAX_BRIDGE_PAYLOAD_BYTES} bytes` };
  }
  let payload: unknown = null;
  if (row.payload !== null) {
    try {
      payload = JSON.parse(row.payload);
    } catch {
      return { ok: false, error: 'payload: not valid JSON' };
    }
  }
  return checkForwardedBridgeAction({ ...row, payload });
}
