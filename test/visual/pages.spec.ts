import { expect, open, prepare, shot, styles, test } from './visual';

// Every route and sub-tab (useHashRouter.ts). Runs in all three projects:
// desktop and narrow on the seeded db, `empty` on a db without scrum data.
const ROUTES = [
  'dashboard/board',
  'dashboard/overview',
  'planning',
  'code/files',
  'code/graph',
  'code/stats',
  'team/grid',
  'team/workload',
  'team/mood',
  'retro/insights',
  'retro/history',
  'retro/patterns',
  'benchmark/overview',
  'benchmark/simulated',
];

for (const route of ROUTES) {
  const name = route.replace('/', '-');
  test(`page ${route}`, async ({ page }, info) => {
    await prepare(page);
    await open(page, `#${route}`);
    await shot(page, name);
    // One style dump per view is enough: the desktop project.
    if (info.project.name === 'desktop') await styles(page, name);
  });
}

// A selected file with its three in-page tabs.
for (const tab of ['Detail', 'Graph', 'Changes']) {
  test(`page code/files with a file, ${tab}`, async ({ page }, info) => {
    await prepare(page);
    const files = (await (await page.request.get('/api/files')).json()) as {
      id: number;
      path: string;
    }[];
    const file = files.find((f) => f.path.endsWith('/api/server.ts'));
    expect(file, 'fixture file api/server.ts is indexed').toBeTruthy();
    await open(page, `#code/files/${file!.id}`);
    await expect(page.locator('.detail-title')).toBeVisible();
    if (tab !== 'Detail') await page.getByText(tab, { exact: true }).first().click();
    const name = `code-file-${tab.toLowerCase()}`;
    await shot(page, name);
    if (info.project.name === 'desktop') await styles(page, name);
  });
}
