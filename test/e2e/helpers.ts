import { randomUUID } from 'node:crypto';
import { expect, type APIRequestContext, type Page } from '@playwright/test';

/**
 * Open the dashboard with the landing animation and the first-run tour
 * already dismissed (their flags live in session/local storage).
 */
export async function openApp(page: Page, hash = ''): Promise<void> {
  await page.addInitScript(() => {
    sessionStorage.setItem('landing-played', 'true');
    localStorage.setItem('tour-completed', 'true');
  });
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
