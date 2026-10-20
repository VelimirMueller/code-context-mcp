/**
 * #180: the CI gate on contract snapshots (scripts/check-contract-change.mjs).
 */
import { describe, it, expect } from 'vitest';
import { decide, major, APPROVAL_LABEL } from '../../scripts/check-contract-change.mjs';

const SNAP = 'test/contract/snapshots/';
const input = (over: Partial<Parameters<typeof decide>[0]> = {}) => ({
  baseHasSnapshots: true,
  changed: [`${SNAP}tools-code.json`],
  baseVersion: '3.0.0',
  headVersion: '3.1.0',
  labels: [] as string[],
  ...over,
});

describe('check-contract-change: decide (#180)', () => {
  it('fails on a changed snapshot without a major bump or the label', () => {
    const r = decide(input());
    expect(r.ok).toBe(false);
    expect(r.contractFiles).toEqual([`${SNAP}tools-code.json`]);
  });

  it('passes with a major bump', () => {
    expect(decide(input({ headVersion: '4.0.0' })).ok).toBe(true);
    expect(decide(input({ baseVersion: '2.13.0', headVersion: '3.0.0' })).ok).toBe(true);
  });

  it('passes with the approval label', () => {
    expect(decide(input({ labels: ['infra', APPROVAL_LABEL] })).ok).toBe(true);
  });

  it('ignores description hashes and files outside the snapshot dir', () => {
    expect(decide(input({ changed: [`${SNAP}descriptions.json`, 'src/server/index.ts'] })).ok).toBe(
      true,
    );
  });

  it('a deleted or added snapshot counts as a change', () => {
    expect(decide(input({ changed: [`${SNAP}tools-new.json`] })).ok).toBe(false);
  });

  it('passes when the base has no snapshots yet (the PR that adds the contract)', () => {
    expect(decide(input({ baseHasSnapshots: false })).ok).toBe(true);
  });

  it('a minor or patch bump, or a downgrade, is not a major bump', () => {
    expect(decide(input({ headVersion: '3.0.1' })).ok).toBe(false);
    expect(decide(input({ baseVersion: '4.0.0', headVersion: '3.9.0' })).ok).toBe(false);
    expect(major('v12.3.4')).toBe(12);
    expect(major('nope')).toBeNaN();
  });
});
