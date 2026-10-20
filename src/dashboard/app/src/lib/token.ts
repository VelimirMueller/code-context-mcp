/**
 * Dashboard bearer token (#15b). Injected into the served page by the server in
 * production (window.__DASHBOARD_TOKEN__); provided via Vite env (.env.local,
 * written by the dashboard on startup) during `vite` dev.
 */
export function getDashboardToken(): string {
  const w = window as unknown as { __DASHBOARD_TOKEN__?: string };
  const env = (import.meta.env as Record<string, string | undefined>).VITE_DASHBOARD_TOKEN;
  return w.__DASHBOARD_TOKEN__ || env || '';
}

/** Append ?token= to a URL — for EventSource, which cannot send request headers. */
export function withToken(url: string): string {
  const token = getDashboardToken();
  if (!token) return url;
  return `${url}${url.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`;
}
