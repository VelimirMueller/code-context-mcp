import { describe, it, expect } from 'vitest';
import { cx } from '@/lib/utils';

describe('cx', () => {
  it('joins the class names it gets', () => {
    expect(cx('px-2', 'text-fg')).toBe('px-2 text-fg');
  });

  it('drops false, null, undefined and empty parts', () => {
    expect(cx('px-2', false, null, undefined, '', 'text-accent')).toBe('px-2 text-accent');
  });

  it('returns an empty string without parts', () => {
    expect(cx()).toBe('');
  });
});
