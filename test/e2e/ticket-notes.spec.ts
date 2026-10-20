import { test, expect, createOwnSprint, openApp } from './helpers';

/**
 * #197: notes typed in the ticket editor are saved and survive a reload.
 *
 * #229: the spec owns its data, so it is stable without retries, next to the
 * other specs and with --repeat-each. Each run creates its own done sprint
 * and one ticket, and opens the board on that sprint (#dashboard/board/<id>).
 * Earlier all runs added tickets to the seeded sprint, and two workers could
 * read one Date.now() (strict-mode violation on two cards with one title).
 */
test('ticket notes from the edit form are saved', async ({ page, request }) => {
  const { sprintId, run } = await createOwnSprint(request, 'notes');
  const title = `E2E notes ticket ${run}`;
  const created = await request.post('/api/tickets', {
    data: { title, priority: 'P2', sprint_id: sprintId },
  });
  expect(created.ok(), await created.text()).toBe(true);
  const { id } = (await created.json()) as { id: number };

  await openApp(page, `#dashboard/board/${sprintId}`);
  await page.getByText(title).click();
  const notes = page.getByLabel('Ticket notes');
  await notes.fill('Check the retry path');
  const saved = page.waitForResponse(
    (r) => r.url().endsWith(`/api/ticket/${id}`) && r.request().method() === 'PATCH',
  );
  await notes.blur();
  expect((await saved).status()).toBe(200);

  // Persistence: the API row and a fresh page both show the new notes.
  const rows = (await (await request.get(`/api/sprint/${sprintId}/tickets`)).json()) as {
    id: number;
    notes: string | null;
  }[];
  expect(rows.find((t) => t.id === id)?.notes).toBe('Check the retry path');

  // A full reload keeps the #dashboard/board/<id> hash.
  await page.reload();
  await page.getByText(title).click();
  await expect(page.getByLabel('Ticket notes')).toHaveValue('Check the retry path');
});
