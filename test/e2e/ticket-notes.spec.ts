import { test, expect } from '@playwright/test';
import { openApp } from './helpers';

/**
 * #197: notes typed in the ticket editor are saved and survive a reload.
 * The spec creates its own ticket in the seeded implementation sprint.
 */
test('ticket notes from the edit form are saved', async ({ page, request }) => {
  const sprints = (await (await request.get('/api/sprints')).json()) as {
    id: number;
    name: string;
  }[];
  const sprint = sprints.find((s) => s.name === 'E2E Sprint 1');
  expect(sprint).toBeDefined();
  const title = `E2E notes ticket ${Date.now()}`;
  const created = await request.post('/api/tickets', {
    data: { title, priority: 'P2', sprint_id: sprint!.id },
  });
  expect(created.ok(), await created.text()).toBe(true);
  const { id } = (await created.json()) as { id: number };

  await openApp(page);
  await page
    .locator('nav[role="tablist"] button[role="tab"]')
    .filter({ hasText: 'Dashboard' })
    .click();
  await page.getByText(title).click();
  const notes = page.getByLabel('Ticket notes');
  await notes.fill('Check the retry path');
  const saved = page.waitForResponse(
    (r) => r.url().endsWith(`/api/ticket/${id}`) && r.request().method() === 'PATCH',
  );
  await notes.blur();
  expect((await saved).status()).toBe(200);

  // Persistence: the API row and a fresh page both show the new notes.
  const rows = (await (await request.get(`/api/sprint/${sprint!.id}/tickets`)).json()) as {
    id: number;
    notes: string | null;
  }[];
  expect(rows.find((t) => t.id === id)?.notes).toBe('Check the retry path');

  await page.reload();
  await page
    .locator('nav[role="tablist"] button[role="tab"]')
    .filter({ hasText: 'Dashboard' })
    .click();
  await page.getByText(title).click();
  await expect(page.getByLabel('Ticket notes')).toHaveValue('Check the retry path');
});
