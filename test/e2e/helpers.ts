import { randomUUID } from 'node:crypto';
import { test as base, expect, type APIRequestContext, type Page } from '@playwright/test';

/** Token the e2e dashboard runs with (playwright.config.ts passes it to serve.mjs). */
export const E2E_TOKEN = 'e2e-token-0123456789abcdef0123456789';
const BEARER = { Authorization: `Bearer ${E2E_TOKEN}` };

/**
 * Specs import `test` from here (#243): the `request` fixture sends the bearer
 * header like the MCP server does, while the browser carries no header and
 * logs in through the launch URL (openApp), like a user after /ccui.
 */
export const test = base.extend({
  request: async ({ playwright, baseURL }, use) => {
    const ctx = await playwright.request.newContext({ baseURL, extraHTTPHeaders: BEARER });
    await use(ctx);
    await ctx.dispose();
  },
});
export { expect };

/** Log the browser in: mint a one-time launch URL (bearer) and open it (sets the cookie). */
export async function login(page: Page): Promise<void> {
  const minted = await page.request.post('/api/auth/launch', { headers: BEARER });
  expect(minted.ok(), await minted.text()).toBe(true);
  const { url } = (await minted.json()) as { url: string };
  await page.goto(url);
}

/**
 * Log in, then open the dashboard with the landing animation and the first-run
 * tour already dismissed (their flags live in session/local storage).
 */
export async function openApp(page: Page, hash = ''): Promise<void> {
  await page.addInitScript(() => {
    sessionStorage.setItem('landing-played', 'true');
    localStorage.setItem('tour-completed', 'true');
  });
  await login(page);
  await page.goto(`/${hash}`);
  await page.waitForSelector('[role="tablist"]', { timeout: 10_000 });
}

/**
 * Create a sprint that only the calling spec uses (#220, #229), so specs and
 * repeats never share a board. Open it with `#dashboard/board/<id>`.
 * - The sprint goes planning -> implementation -> done. The dashboard
 *   auto-selects the newest planning, implementation or active sprint; a
 *   done sprint never becomes the default sprint of another spec.
 * - `run` is a UUID: parallel workers can read one Date.now(), and two
 *   cards with one title break strict-mode locators.
 */
export async function createOwnSprint(
  request: APIRequestContext,
  label: string,
): Promise<{ sprintId: number; run: string }> {
  const run = randomUUID();
  const plan = await request.post('/api/sprints/plan', {
    data: { name: `E2E ${label} sprint ${run}`, ticket_ids: [] },
  });
  expect(plan.ok(), await plan.text()).toBe(true);
  const { id: sprintId } = (await plan.json()) as { id: number };
  for (const phase of ['implementation', 'done']) {
    const advanced = await request.post(`/api/sprint/${sprintId}/advance`);
    expect(advanced.ok(), await advanced.text()).toBe(true);
    expect(((await advanced.json()) as { to: string }).to).toBe(phase);
  }
  return { sprintId, run };
}
