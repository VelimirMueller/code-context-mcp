import { test, expect, type Page } from '@playwright/test';
import { openApp } from './helpers';

/**
 * #198: dragging a card to another Kanban column changes the ticket status,
 * and the new status survives a reload. The spec creates its own TODO ticket
 * in the seeded implementation sprint.
 */
const column = (page: Page, label: string) =>
  page.locator(`xpath=//span[text()="${label}"]/ancestor::div[contains(@style,"min-height")][1]`);

const openBoard = async (page: Page) => {
  await page
    .locator('nav[role="tablist"] button[role="tab"]')
    .filter({ hasText: 'Dashboard' })
    .click();
};

test('dragging a Kanban card changes the ticket status', async ({ page, request }) => {
  const sprints = (await (await request.get('/api/sprints')).json()) as {
    id: number;
    name: string;
  }[];
  const sprint = sprints.find((s) => s.name === 'E2E Sprint 1');
  expect(sprint).toBeDefined();
  const title = `E2E drag ticket ${Date.now()}`;
  const created = await request.post('/api/tickets', {
    data: { title, priority: 'P2', sprint_id: sprint!.id },
  });
  expect(created.ok(), await created.text()).toBe(true);
  const { id } = (await created.json()) as { id: number };

  await openApp(page);
  await openBoard(page);
  const card = page.locator('div[draggable="true"]').filter({ hasText: title });
  await expect(column(page, 'To Do').getByText(title)).toBeVisible();

  const saved = page.waitForResponse(
    (r) => r.url().endsWith(`/api/ticket/${id}`) && r.request().method() === 'PATCH',
  );
  await card.dragTo(column(page, 'In Progress'));
  expect((await saved).status()).toBe(200);
  await expect(column(page, 'In Progress').getByText(title)).toBeVisible();

  // Persistence: the API row and a fresh page both show IN_PROGRESS.
  const rows = (await (await request.get(`/api/sprint/${sprint!.id}/tickets`)).json()) as {
    id: number;
    status: string;
  }[];
  expect(rows.find((t) => t.id === id)?.status).toBe('IN_PROGRESS');

  await page.reload();
  await openBoard(page);
  await expect(column(page, 'In Progress').getByText(title)).toBeVisible();
});
