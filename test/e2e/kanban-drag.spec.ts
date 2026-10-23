import type { Page } from '@playwright/test';
import { test, expect, createOwnSprint, openApp } from './helpers';

/**
 * #198: dragging a card to another Kanban column changes the ticket status,
 * and the new status survives a reload.
 *
 * #220: the spec owns its data, so it is stable without retries, after the
 * other specs and with --repeat-each. Earlier it added its ticket to the
 * shared seeded sprint. Every other spec and repeat added cards there too,
 * so the board grew, the card moved below the fold, and each write elsewhere
 * re-rendered the board over SSE during the drag.
 * - Each run creates its own sprint and one ticket, and opens the board on
 *   that sprint (#dashboard/board/<id>). The sprint is done, so it never
 *   becomes the default sprint of the other specs.
 * - The drop point is on the card's own row in the In Progress column, so
 *   both points are in the viewport and nothing scrolls during the drag.
 * - The drag uses the mouse directly: `locator.dragTo` re-checks the target
 *   and retries with a scroll while the button is down.
 * - Names carry a UUID, because parallel workers can read one Date.now().
 */
// KanbanBoard renders each column with data-testid="kanban-column" (#313).
const column = (page: Page, label: string) =>
  page.locator(`xpath=//span[text()="${label}"]/ancestor::div[@data-testid="kanban-column"][1]`);

const openBoard = async (page: Page) => {
  await page
    .locator('nav[role="tablist"] button[role="tab"]')
    .filter({ hasText: 'Dashboard' })
    .click();
};

test('dragging a Kanban card changes the ticket status', async ({ page, request }) => {
  const { sprintId, run } = await createOwnSprint(request, 'drag');
  const title = `E2E drag ticket ${run}`;
  const created = await request.post('/api/tickets', {
    data: { title, priority: 'P2', sprint_id: sprintId },
  });
  expect(created.ok(), await created.text()).toBe(true);
  const { id } = (await created.json()) as { id: number };

  await openApp(page, `#dashboard/board/${sprintId}`);
  const card = page.locator('div[draggable="true"]').filter({ hasText: title });
  await expect(column(page, 'To Do').getByText(title)).toBeVisible();
  await expect(page.locator('div[draggable="true"]')).toHaveCount(1);

  const saved = page.waitForResponse(
    (r) => r.url().endsWith(`/api/ticket/${id}`) && r.request().method() === 'PATCH',
  );
  await card.scrollIntoViewIfNeeded();
  const from = await card.boundingBox();
  const to = await column(page, 'In Progress').boundingBox();
  if (!from || !to) throw new Error('the card or the In Progress column has no box');
  const y = from.y + from.height / 2;
  await page.mouse.move(from.x + from.width / 2, y);
  await page.mouse.down();
  // The grid gives all columns one height; the clamp keeps the drop inside
  // the In Progress column even if that ever changes.
  const dropY = Math.min(Math.max(y, to.y + 10), to.y + to.height - 10);
  await page.mouse.move(to.x + to.width / 2, dropY, { steps: 5 });
  await page.mouse.up();
  expect((await saved).status()).toBe(200);
  await expect(column(page, 'In Progress').getByText(title)).toBeVisible();

  // Persistence: the API row and a fresh page both show IN_PROGRESS.
  const rows = (await (await request.get(`/api/sprint/${sprintId}/tickets`)).json()) as {
    id: number;
    status: string;
  }[];
  expect(rows.find((t) => t.id === id)?.status).toBe('IN_PROGRESS');

  await page.reload();
  await openBoard(page);
  await expect(column(page, 'In Progress').getByText(title)).toBeVisible();
});
