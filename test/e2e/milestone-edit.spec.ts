import type { Page } from '@playwright/test';
import { test, expect, openApp } from './helpers';

/**
 * #205: a milestone edit on the Planning page saves the status and the
 * target date, and the change is still there after a reload.
 */
const openPlanning = async (page: Page) => {
  await page
    .locator('nav[role="tablist"] button[role="tab"]')
    .filter({ hasText: 'Planning' })
    .click();
};

test('a milestone edit from the dashboard saves status and target date', async ({
  page,
  request,
}) => {
  const name = `E2E edit ${Date.now()}`;
  const created = await request.post('/api/milestones', {
    data: { name, target_date: '2026-12-01' },
  });
  expect(created.status()).toBe(200);
  const { id } = (await created.json()) as { id: number };

  await openApp(page);
  await openPlanning(page);
  await page.getByRole('button', { name: `Edit ${name}` }).click();
  await page.getByLabel(`Status of ${name}`).selectOption('active');
  await page.getByLabel(`Target date of ${name}`).fill('2026-12-15');
  const saved = page.waitForResponse(
    (r) => r.url().endsWith(`/api/milestone/${id}`) && r.request().method() === 'PUT',
  );
  await page.getByRole('button', { name: 'Save' }).click();
  const res = await saved;
  expect(res.status()).toBe(200);
  expect(res.request().postDataJSON()).toEqual({ status: 'active', target_date: '2026-12-15' });
  await expect(page.getByLabel(`Status of ${name}`)).toBeHidden();

  // Persistence: the API list and a fresh page both show the change.
  const rows = (await (await request.get('/api/milestones')).json()) as {
    id: number;
    status: string;
    target_date: string | null;
  }[];
  expect(rows.find((m) => m.id === id)).toMatchObject({
    status: 'active',
    target_date: '2026-12-15',
  });

  await page.reload();
  await openPlanning(page);
  await page.getByRole('button', { name: `Edit ${name}` }).click();
  await expect(page.getByLabel(`Status of ${name}`)).toHaveValue('active');
  await expect(page.getByLabel(`Target date of ${name}`)).toHaveValue('2026-12-15');
});
