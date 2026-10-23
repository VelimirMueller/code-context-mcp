import { describe, expect, it } from 'vitest';
// @ts-expect-error -- plain .mjs script, no types
import { decide, BASELINE_DIR, APPROVAL_LABEL } from '../scripts/check-visual-change.mjs';

describe('visual baseline gate (#293)', () => {
  const png = `${BASELINE_DIR}desktop/dashboard-board.png`;

  it('passes when no baseline changed', () => {
    expect(decide({ changed: ['src/x.ts'], labels: [] }).ok).toBe(true);
  });

  it('fails on a changed baseline without the label', () => {
    const r = decide({ changed: [png, 'src/x.ts'], labels: [] });
    expect(r.ok).toBe(false);
    expect(r.files).toEqual([png]);
  });

  it('passes on a changed baseline with the label', () => {
    expect(decide({ changed: [png], labels: [APPROVAL_LABEL] }).ok).toBe(true);
  });
});
