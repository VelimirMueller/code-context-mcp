import type { Page } from '@playwright/test';
import { test, expect, openApp } from './helpers';

/**
 * #199: a milestone created from the Planning page is saved with its name
 * and target date, and it is still listed after a reload.
 */
const openPlanning = async (page: Page) => {
  await page
    .locator('nav[role="tablist"] button[role="tab"]')
    .filter({ hasText: 'Planning' })
    .click();
};

test('a new milestone from the dashboard is saved', async ({ page, request }) => {
  const name = `E2E milestone ${Date.now()}`;

  await openApp(page);
  await openPlanning(page);
  await page.getByRole('button', { name: 'New milestone' }).click();
  await page.getByLabel('Milestone name').fill(name);
  await page.getByLabel('Milestone target date').fill('2026-12-01');
  const saved = page.waitForResponse(
    (r) => r.url().endsWith('/api/milestones') && r.request().method() === 'POST',
  );
  await page.getByRole('button', { name: 'Create' }).click();
  expect((await saved).status()).toBe(200);
  await expect(page.getByText(name)).toBeVisible();

  // Persistence: the API list and a fresh page both show the milestone.
  const rows = (await (await request.get('/api/milestones')).json()) as {
    name: string;
    target_date: string | null;
  }[];
  expect(rows.find((m) => m.name === name)?.target_date).toBe('2026-12-01');

  await page.reload();
  await openPlanning(page);
  await expect(page.getByText(name)).toBeVisible();
});
