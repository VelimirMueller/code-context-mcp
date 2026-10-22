import { describe, it, expect } from 'vitest';

describe('Frontend test infrastructure', () => {
  it('vitest runs with jsdom environment', () => {
    expect(typeof document).toBe('object');
    expect(typeof window).toBe('object');
  });

  it('can import testing-library', async () => {
    const { render } = await import('@testing-library/react');
    expect(typeof render).toBe('function');
  });
});
