import { defineConfig, devices } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { E2E_TOKEN } from './test/e2e/helpers';

// Visual regression gate for the Tailwind migration (#293). Every refactor PR
// must render the dashboard pixel for pixel like the baselines.
// - Run it only inside the pinned Playwright image (pnpm run test:visual):
//   fonts and anti-aliasing differ per OS, so a baseline from another
//   machine is worthless. CI runs the same image (ci.yml, job `visual`).
// - Two servers: one with the e2e seed, one with no scrum data (empty states).
//   Both run in visual mode (test/e2e/serve.mjs): frozen code index, frozen
//   benchmark data, every timestamp set to one instant.
const SEEDED_PORT = Number(process.env.VISUAL_PORT ?? 4327);
const EMPTY_PORT = SEEDED_PORT + 1;
const dbIn = (name: string) =>
  path.join(mkdtempSync(path.join(tmpdir(), `cc-visual-${name}-`)), 'context.db');

const server = (port: number, seed: 'full' | 'empty') => ({
  command: `node test/e2e/serve.mjs "${dbIn(seed)}" ${port}`,
  url: `http://localhost:${port}/health`,
  reuseExistingServer: false,
  timeout: 30_000,
  env: { CODE_CONTEXT_DASHBOARD_TOKEN: E2E_TOKEN, E2E_VISUAL: '1', E2E_SEED: seed },
});

const base = {
  ...devices['Desktop Chrome'],
  deviceScaleFactor: 1,
  colorScheme: 'dark' as const,
  locale: 'en-US',
  timezoneId: 'UTC',
  // A context option, not a top-level `use` option: there it is silently ignored.
  contextOptions: { reducedMotion: 'reduce' as const },
  // Deterministic raster: one software raster thread, no GPU, no compositor-thread
  // animations. Without these, antialiased edges vary by a few pixels per run.
  launchOptions: {
    args: [
      '--disable-gpu',
      '--disable-gpu-rasterization',
      '--disable-partial-raster',
      '--num-raster-threads=1',
      '--disable-threaded-animation',
      '--disable-threaded-scrolling',
      '--disable-zero-copy',
      '--force-color-profile=srgb',
    ],
  },
};

export default defineConfig({
  testDir: './test/visual',
  // Platform-free names: a baseline belongs to the pinned image, not to an OS.
  snapshotPathTemplate: '{testDir}/__snapshots__/{projectName}/{arg}{ext}',
  timeout: 60_000,
  workers: 1,
  retries: 0,
  reporter: process.env.CI ? [['list'], ['github'], ['html', { open: 'never' }]] : 'list',
  expect: {
    toHaveScreenshot: {
      maxDiffPixels: 0,
      threshold: 0,
      animations: 'disabled',
      caret: 'hide',
      scale: 'css',
    },
  },
  projects: [
    {
      name: 'desktop',
      use: {
        ...base,
        viewport: { width: 1440, height: 900 },
        baseURL: `http://localhost:${SEEDED_PORT}`,
      },
    },
    {
      name: 'narrow',
      use: {
        ...base,
        viewport: { width: 390, height: 844 },
        baseURL: `http://localhost:${SEEDED_PORT}`,
      },
    },
    {
      name: 'empty',
      testMatch: /pages\.spec\.ts/,
      use: {
        ...base,
        viewport: { width: 1440, height: 900 },
        baseURL: `http://localhost:${EMPTY_PORT}`,
      },
    },
  ],
  webServer: [server(SEEDED_PORT, 'full'), server(EMPTY_PORT, 'empty')],
});
