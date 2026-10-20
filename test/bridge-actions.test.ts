/**
 * #244 (TM-03): the strict payload schemas of the forwarded bridge actions.
 */
import { describe, it, expect } from 'vitest';
import {
  checkForwardedBridgeAction,
  checkForwardedBridgeRow,
  FORWARDED_BRIDGE_ACTIONS,
  MAX_BRIDGE_PAYLOAD_BYTES,
} from '../src/bridge/actions.js';

describe('checkForwardedBridgeAction', () => {
  it('has no free-form action', () => {
    expect(FORWARDED_BRIDGE_ACTIONS).not.toContain('custom');
    expect(checkForwardedBridgeAction({ action: 'custom', payload: {} }).ok).toBe(false);
  });

  it('accepts the bodies the dashboard app sends', () => {
    for (const payload of [{ ticket_ref: 'T-1' }, { status: 'DONE', ticket_ref: 'T-1' }]) {
      const r = checkForwardedBridgeAction({
        action: 'status' in payload ? 'update_ticket' : 'assign_ticket',
        entity_type: 'ticket',
        entity_id: 3,
        payload,
      });
      expect(r.ok).toBe(true);
    }
    expect(checkForwardedBridgeAction({ action: 'run_kickoff' }).ok).toBe(true);
    expect(
      checkForwardedBridgeAction({ action: 'create_ticket', payload: { title: 'Fix bug' } }).ok,
    ).toBe(true);
  });

  it('refuses unknown keys, wrong types, long strings and fence-breaking text', () => {
    const ticket = { action: 'update_ticket', entity_type: 'ticket', entity_id: 3 };
    const bad: unknown[] = [
      { status: 'DONE', extra: 1 },
      { status: 'done' },
      { assigned_to: 'a'.repeat(65) },
      { assigned_to: 'dev; rm -rf ~' },
    ];
    for (const payload of bad) {
      expect(checkForwardedBridgeAction({ ...ticket, payload }).ok, JSON.stringify(payload)).toBe(
        false,
      );
    }
    for (const title of ['', 'x'.repeat(201), 'a```b', 'line\nbreak']) {
      expect(checkForwardedBridgeAction({ action: 'create_ticket', payload: { title } }).ok).toBe(
        false,
      );
    }
    expect(checkForwardedBridgeAction({ action: 'run_kickoff', payload: { go: true } }).ok).toBe(
      false,
    );
  });

  it('needs the right entity', () => {
    expect(checkForwardedBridgeAction({ action: 'update_ticket', payload: {} }).ok).toBe(false);
    expect(
      checkForwardedBridgeAction({ action: 'advance_sprint', entity_type: 'ticket', entity_id: 1 })
        .ok,
    ).toBe(false);
    expect(
      checkForwardedBridgeAction({ action: 'run_kickoff', entity_type: 'ticket', entity_id: 1 }).ok,
    ).toBe(false);
  });

  it('caps the payload at 4 KB', () => {
    const r = checkForwardedBridgeAction({
      action: 'plan_sprint',
      payload: { ticket_ids: [], goal: 'x'.repeat(MAX_BRIDGE_PAYLOAD_BYTES) },
    });
    expect(r).toEqual({ ok: false, error: 'payload: over 4096 bytes' });
  });
});

describe('checkForwardedBridgeRow', () => {
  const row = { action: 'create_ticket', entity_type: null, entity_id: null };

  it('parses the stored JSON text', () => {
    expect(checkForwardedBridgeRow({ ...row, payload: '{"title":"Fix bug"}' }).ok).toBe(true);
    expect(checkForwardedBridgeRow({ ...row, payload: '{bad' })).toEqual({
      ok: false,
      error: 'payload: not valid JSON',
    });
  });

  it('checks the size of the raw text before it parses it', () => {
    const payload = `{"title":"x"}${' '.repeat(MAX_BRIDGE_PAYLOAD_BYTES)}`;
    expect(checkForwardedBridgeRow({ ...row, payload }).ok).toBe(false);
  });
});
