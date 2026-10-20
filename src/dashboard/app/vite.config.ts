import { defineConfig, loadEnv, searchForWorkspaceRoot } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { existsSync, readFileSync } from 'node:fs';
import path from 'path';

/**
 * Dev-server bearer token (#247). The dashboard no longer writes the token to
 * .env.local (`vite build` inlined it into the published assets), so this
 * proxy adds the Authorization header itself. Same sources as the dashboard
 * (`dashboardTokenRoot` in src/dashboard/auth.ts): CODE_CONTEXT_DASHBOARD_TOKEN
 * wins, else .code-context/dashboard.token beside the db — the path from
 * VITE_DASHBOARD_DB or the default ../../../context.db. With the header on the
 * proxy, the page needs no token and no session cookie in dev (#243): fetch
 * and the EventSource both pass the bearer check through it.
 */
function devDashboardToken(): string {
  const fromEnv = process.env.CODE_CONTEXT_DASHBOARD_TOKEN;
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();
  const db = process.env.VITE_DASHBOARD_DB
    ? path.resolve(process.env.VITE_DASHBOARD_DB)
    : path.resolve(__dirname, '../../../context.db');
  const file = path.join(path.dirname(db), '.code-context', 'dashboard.token');
  if (existsSync(file)) {
    const token = readFileSync(file, 'utf-8').trim();
    if (token) return token;
  }
  console.warn(
    `[vite] No dashboard token at ${file}; start the dashboard first (npm run dashboard) or /api answers 401.`,
  );
  return '';
}

export default defineConfig(({ mode }) => {
  // The dashboard writes the port to .env.local; loadEnv reads it for the
  // proxy target (process.env alone does not see .env files).
  const env = loadEnv(mode, __dirname, '');
  const port = env.VITE_DASHBOARD_PORT || process.env.VITE_DASHBOARD_PORT || '3333';
  const token = devDashboardToken();
  return {
    plugins: [react(), tailwindcss()],
    root: __dirname,
    resolve: {
      alias: {
        '@': path.resolve(__dirname, 'src'),
        // CCA-20: the bench verdict rule (pure, no imports) is shared with scripts/bench.
        '@bench': path.resolve(__dirname, '../../../scripts/bench/lib'),
      },
    },
    server: {
      // The dev server may serve the shared verdict module from outside the app root.
      fs: {
        allow: [
          searchForWorkspaceRoot(__dirname),
          path.resolve(__dirname, '../../../scripts/bench/lib/verdict.mts'),
        ],
      },
      proxy: {
        '/api': {
          target: `http://localhost:${port}`,
          changeOrigin: true,
          // Dev only (#247): the token never reaches the browser bundle.
          ...(token ? { headers: { Authorization: `Bearer ${token}` } } : {}),
        },
      },
    },
    build: {
      outDir: path.resolve(__dirname, '../../../dist/dashboard'),
      emptyOutDir: false,
    },
  };
});
