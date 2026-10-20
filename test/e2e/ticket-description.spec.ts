import { test, expect, createOwnSprint, openApp } from './helpers';

/**
 * #206: a ticket description emptied in the editor is cleared, and it stays
 * cleared after a reload.
 *
 * #229: the spec owns its data, so it is stable without retries, next to the
 * other specs and with --repeat-each. Each run creates its own done sprint
 * and one ticket, and opens the board on that sprint (#dashboard/board/<id>).
 * Earlier all runs added tickets to the seeded sprint, and two workers could
 * read one Date.now() (strict-mode violation on two cards with one title).
 */
test('a ticket description can be cleared from the editor', async ({ page, request }) => {
  const { sprintId, run } = await createOwnSprint(request, 'description');
  const title = `E2E description ticket ${run}`;
  const description = `Text that the spec clears ${run}`;
  const created = await request.post('/api/tickets', {
    data: { title, description, sprint_id: sprintId },
  });
  expect(created.ok(), await created.text()).toBe(true);
  const { id } = (await created.json()) as { id: number };

  await openApp(page, `#dashboard/board/${sprintId}`);
  await page.getByText(title).click();
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
  const rows = (await (await request.get(`/api/sprint/${sprintId}/tickets`)).json()) as {
    id: number;
    description: string | null;
  }[];
  expect(rows.find((t) => t.id === id)?.description).toBeNull();

  // A full reload keeps the #dashboard/board/<id> hash.
  await page.reload();
  await page.getByText(title).click();
  await expect(page.getByText('Add description…')).toBeVisible();
  await expect(page.getByText(description)).toHaveCount(0);
});
