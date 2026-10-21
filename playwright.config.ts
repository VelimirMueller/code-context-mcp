import { defineConfig } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { E2E_TOKEN } from './test/e2e/helpers';

// The e2e specs drive the built dashboard (pnpm run build) against a seeded
// throwaway database (test/e2e/serve.mjs). Never 3333 and never a reused
// server: a developer's real dashboard listens there on their real context.db.
// Override the port with E2E_PORT; a busy port fails the run.
const PORT = Number(process.env.E2E_PORT ?? 4317);
const DB = path.join(mkdtempSync(path.join(tmpdir(), 'cc-e2e-')), 'context.db');

export default defineConfig({
  testDir: './test/e2e',
  timeout: 30_000,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['github']] : 'list',
  use: {
    baseURL: `http://localhost:${PORT}`,
    headless: true,
    // No extra headers (#243): the browser logs in through the launch URL
    // (openApp), the `request` fixture in helpers.ts sends the bearer token.
  },
  webServer: {
    command: `node test/e2e/serve.mjs "${DB}" ${PORT}`,
    url: `http://localhost:${PORT}/health`,
    reuseExistingServer: false,
    timeout: 30_000,
    env: { CODE_CONTEXT_DASHBOARD_TOKEN: E2E_TOKEN },
  },
});
