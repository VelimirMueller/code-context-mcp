/**
 * Dashboard bearer token (#15b). Injected into the served page by the server
 * in production (window.__DASHBOARD_TOKEN__) — the only source there. In
 * `vite` dev, VITE_DASHBOARD_TOKEN is read only behind import.meta.env.DEV,
 * so a production build can never inline it (#247); normally the dev proxy
 * adds the Authorization header itself and the page needs no token.
 */
export function getDashboardToken(): string {
  const w = window as unknown as { __DASHBOARD_TOKEN__?: string };
  if (w.__DASHBOARD_TOKEN__) return w.__DASHBOARD_TOKEN__;
  if (import.meta.env.DEV) {
    return (import.meta.env as Record<string, string | undefined>).VITE_DASHBOARD_TOKEN ?? '';
  }
  return '';
}

/** Append ?token= to a URL — for EventSource, which cannot send request headers. */
export function withToken(url: string): string {
  const token = getDashboardToken();
  if (!token) return url;
  return `${url}${url.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`;
}
