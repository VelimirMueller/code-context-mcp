import { afterEach, describe, expect, it, vi } from 'vitest';
import { getDashboardToken, withToken } from '@/lib/token';

// #247: VITE_DASHBOARD_TOKEN is read only behind import.meta.env.DEV, so a
// production build never inlines it; production uses window.__DASHBOARD_TOKEN__
// only, and the dev proxy normally adds the Authorization header itself.

const w = window as unknown as { __DASHBOARD_TOKEN__?: string };

afterEach(() => {
  delete w.__DASHBOARD_TOKEN__;
  vi.unstubAllEnvs();
});

describe('getDashboardToken (#247)', () => {
  it('reads VITE_DASHBOARD_TOKEN in dev', () => {
    vi.stubEnv('VITE_DASHBOARD_TOKEN', 'dev-token');
    expect(getDashboardToken()).toBe('dev-token');
  });

  it('never reads VITE_DASHBOARD_TOKEN when DEV is false (production build)', () => {
    vi.stubEnv('DEV', false);
    vi.stubEnv('VITE_DASHBOARD_TOKEN', 'a'.repeat(64));
    expect(getDashboardToken()).toBe('');
  });

  it('prefers the injected window token over the env token', () => {
    w.__DASHBOARD_TOKEN__ = 'from-page';
    vi.stubEnv('VITE_DASHBOARD_TOKEN', 'from-env');
    expect(getDashboardToken()).toBe('from-page');
  });

  it('uses the injected window token in production', () => {
    vi.stubEnv('DEV', false);
    w.__DASHBOARD_TOKEN__ = 'from-page';
    expect(getDashboardToken()).toBe('from-page');
  });
});

describe('withToken', () => {
  it('appends ?token= for an EventSource URL', () => {
    vi.stubEnv('VITE_DASHBOARD_TOKEN', 'a b');
    expect(withToken('/api/stream')).toBe('/api/stream?token=a%20b');
  });

  it('keeps the URL unchanged without a token (dev proxy adds the header)', () => {
    expect(withToken('/api/stream')).toBe('/api/stream');
  });
});
