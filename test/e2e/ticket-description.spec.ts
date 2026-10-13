import { test, expect, type Page } from '@playwright/test';
import { openApp } from './helpers';

/**
 * #206: a ticket description emptied in the editor is cleared, and it stays
 * cleared after a reload. The spec creates its own ticket in the seeded
 * implementation sprint.
 */
const openTicket = async (page: Page, title: string) => {
  await page
    .locator('nav[role="tablist"] button[role="tab"]')
    .filter({ hasText: 'Dashboard' })
    .click();
  await page.getByText(title).click();
};

test('a ticket description can be cleared from the editor', async ({ page, request }) => {
  const sprints = (await (await request.get('/api/sprints')).json()) as {
    id: number;
    name: string;
  }[];
  const sprint = sprints.find((s) => s.name === 'E2E Sprint 1');
  expect(sprint).toBeDefined();
  const title = `E2E description ticket ${Date.now()}`;
  const description = 'Text that the spec clears';
  const created = await request.post('/api/tickets', {
    data: { title, description, sprint_id: sprint!.id },
  });
  expect(created.ok(), await created.text()).toBe(true);
  const { id } = (await created.json()) as { id: number };

  await openApp(page);
  await openTicket(page, title);
  await page.getByText(description).click();
  const textarea = page.getByLabel('Ticket description');
  await textarea.fill('');
  const saved = page.waitForResponse(
    (r) => r.url().endsWith(`/api/ticket/${id}`) && r.request().method() === 'PATCH',
  );
  await textarea.blur();
  const res = await saved;
  expect(res.status()).toBe(200);
  expect(res.request().postDataJSON()).toEqual({ description: null });
  await expect(page.getByText('Add description…')).toBeVisible();

  // Persistence: the API row and a fresh page both show no description.
  const rows = (await (await request.get(`/api/sprint/${sprint!.id}/tickets`)).json()) as {
    id: number;
    description: string | null;
  }[];
  expect(rows.find((t) => t.id === id)?.description).toBeNull();

  await page.reload();
  await openTicket(page, title);
  await expect(page.getByText('Add description…')).toBeVisible();
  await expect(page.getByText(description)).toHaveCount(0);
});
