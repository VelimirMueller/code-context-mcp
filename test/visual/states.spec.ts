import { expect, open, prepare, settle, shot, styles, test } from './visual';

// Overlays and interaction states on the seeded db (desktop and narrow).
// Every test leaves the db as it found it: the projects share one server.

test('ticket detail modal', async ({ page }, info) => {
  await prepare(page);
  await open(page, '#dashboard/board');
  await page.getByText('Seed ticket in progress').first().click();
  await expect(page.getByLabel('Ticket status')).toBeVisible();
  await settle(page);
  await shot(page, 'modal-ticket-detail');
  if (info.project.name === 'desktop') await styles(page, 'modal-ticket-detail');
});

test('team management modal', async ({ page }, info) => {
  await prepare(page);
  await open(page, '#team/grid');
  await page.getByRole('button', { name: /Add Member/ }).click();
  await settle(page);
  await shot(page, 'modal-team-management');
  if (info.project.name === 'desktop') await styles(page, 'modal-team-management');
});

test('alert dialog: delete agent', async ({ page }) => {
  await prepare(page);
  await open(page, '#team/grid');
  await page.getByTitle('Delete agent').first().click();
  await expect(page.getByText('Delete Team Member?')).toBeVisible();
  await settle(page);
  await shot(page, 'dialog-delete-agent');
});

test('wizard modal', async ({ page, request }, info) => {
  await prepare(page);
  await open(page, '#dashboard/board');
  // The wizard opens on the SSE event, so the stream must be up first.
  await expect(page.getByTitle('SSE: connected')).toBeAttached();
  const created = await request.post('/api/bridge/actions', {
    data: {
      action: 'request_input',
      // An object: the server stores JSON.stringify(payload) itself.
      payload: {
        step: 'vision',
        title: 'Product vision',
        description: 'Describe what the product does and for whom.',
        fields: [
          {
            name: 'vision',
            label: 'Vision',
            type: 'textarea',
            placeholder: 'One paragraph',
            required: true,
          },
          { name: 'team', label: 'Team size', type: 'number', placeholder: '5' },
          { name: 'stack', label: 'Stack', type: 'select', options: ['TypeScript', 'Python'] },
        ],
        hints: ['Keep it short.'],
      },
    },
  });
  expect(created.ok(), await created.text()).toBe(true);
  const { id } = (await created.json()) as { id: number };
  try {
    await expect(page.getByText('Product vision').first()).toBeVisible();
    await settle(page);
    await shot(page, 'modal-wizard');
    if (info.project.name === 'desktop') await styles(page, 'modal-wizard');
  } finally {
    // Close the pending action, or the next tests see a waiting wizard.
    await request.patch(`/api/bridge/actions/${id}/respond`, {
      data: { result: { dismissed: true } },
    });
  }
});

test('dashboard tour, every step', async ({ page }) => {
  await prepare(page, { tour: true });
  await open(page, '#dashboard/board');
  for (let step = 1; ; step++) {
    const next = page.getByRole('button', { name: /^(Next|Get Started)$/ });
    await expect(next).toBeVisible();
    await settle(page);
    await shot(page, `tour-step-${step}`);
    if ((await next.textContent())?.trim() === 'Get Started') break;
    await next.click();
  }
});

test('nav states: hover, focus', async ({ page }) => {
  await prepare(page);
  await open(page, '#dashboard/board');
  const tabs = page.getByRole('tab');
  await tabs.nth(1).hover();
  await shot(page, 'nav-hover', { keepPointer: true });
  await page.mouse.move(0, 0);
  await page.keyboard.press('Tab');
  await shot(page, 'nav-focus', { keepPointer: true });
});
