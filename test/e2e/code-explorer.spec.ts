import { test, expect, openApp } from './helpers';

/**
 * E2E tests for the Code Explorer page.
 *
 * The Playwright webServer (playwright.config.ts) starts a seeded dashboard.
 * Navigate to Code Explorer via #code hash route.
 */

test.describe('Code Explorer', () => {
  test.beforeEach(async ({ page }) => {
    await openApp(page, '#code');
    // Wait for file list to populate
    await page.waitForSelector('.sidebar-body', { timeout: 5000 });
    await page.waitForTimeout(500);
  });

  test('page loads with header and file sidebar', async ({ page }) => {
    // Logo text visible (page has two logo-text elements — nav and Code Explorer header)
    await expect(page.getByTestId('logo-text').first()).toContainText('Code Context');

    // Sidebar shows "Files" heading with count
    await expect(page.locator('.sidebar-head')).toContainText('Files');
    const count = page.locator('.sidebar-head .count');
    await expect(count).toBeVisible();

    // File tree has items (files or folders)
    const treeItems = page.locator('[data-testid="file-item"], .tree-folder');
    await expect(treeItems.first()).toBeVisible({ timeout: 5000 });
  });

  test('sub-tabs switch between Explorer, Dependencies, Stats', async ({ page }) => {
    // Explorer tab is default — sidebar visible
    await expect(page.locator('.sidebar')).toBeVisible();

    // Click Dependencies sub-tab
    await page.locator('text=Dependencies').first().click();
    await page.waitForTimeout(300);
    // Canvas for dependency graph should appear
    await expect(page.locator('canvas')).toBeVisible();

    // Click Stats sub-tab
    await page.locator('text=Stats').first().click();
    await page.waitForTimeout(300);
    // Stats cards should show
    await expect(page.getByText('Directories', { exact: true })).toBeVisible();
    await expect(page.getByText('Exports', { exact: true })).toBeVisible();
  });

  test('selecting a file shows detail panel', async ({ page }) => {
    // Get a file ID via API, then navigate to it via hash
    const filesRes = await page.request.get('/api/files');
    const files = await filesRes.json();
    const tsFile =
      files.find((f: any) => f.path.endsWith('.ts') || f.path.endsWith('.tsx')) ?? files[0];

    await page.goto(`/#code/detail/${tsFile.id}`);
    await page.waitForTimeout(1000);

    // Detail section should appear with file path
    const detailTitle = page.locator('.detail-title');
    await expect(detailTitle).toBeVisible({ timeout: 5000 });
    // Title should contain a file path (has a slash or dot)
    const titleText = await detailTitle.textContent();
    expect(titleText).toMatch(/[./]/);

    // Meta info visible (language, lines, size)
    await expect(page.locator('.detail-meta')).toBeVisible();
  });

  test('search filters the file list', async ({ page }) => {
    // Count initial files
    const initialCount = await page.locator('[data-testid="file-item"]').count();
    expect(initialCount).toBeGreaterThan(0);

    // Type a search query
    const searchInput = page.locator('input[type="text"], input[type="search"]').first();
    await searchInput.fill('index');
    await page.waitForTimeout(500);

    // File list should be filtered (fewer or equal items)
    const filteredCount = await page.locator('[data-testid="file-item"]').count();
    expect(filteredCount).toBeLessThanOrEqual(initialCount);

    // Clear search
    await searchInput.fill('');
    await page.waitForTimeout(500);
    const restoredCount = await page.locator('[data-testid="file-item"]').count();
    expect(restoredCount).toBe(initialCount);
  });

  test('stats tab shows stat cards and file types', async ({ page }) => {
    await page.locator('text=Stats').first().click();
    await page.waitForTimeout(500);

    // Four stat cards
    for (const label of ['Files', 'Directories', 'Exports', 'Dependencies']) {
      await expect(page.getByText(label, { exact: true }).first()).toBeVisible();
    }

    // File Types section should render with extension bars
    await expect(page.getByText('File Types', { exact: true })).toBeVisible({ timeout: 3000 });
  });

  test('file detail graph tab renders canvas', async ({ page }) => {
    // Navigate to a file's graph view via hash
    const filesRes = await page.request.get('/api/files');
    const files = await filesRes.json();
    const fileId = files[0].id;

    await page.goto(`/#code/graph/${fileId}`);
    await page.waitForTimeout(1000);

    // Canvas for dependency graph should appear
    await expect(page.locator('canvas')).toBeVisible({ timeout: 5000 });
  });

  test('file detail changes tab loads', async ({ page }) => {
    // Navigate to a file's changes view via hash
    const filesRes = await page.request.get('/api/files');
    const files = await filesRes.json();
    const fileId = files[0].id;

    await page.goto(`/#code/changes/${fileId}`);
    await page.waitForTimeout(1000);

    // The main panel should be visible (changes or empty state)
    await expect(page.locator('.main')).toBeVisible({ timeout: 5000 });
  });

  test('live indicator dot is visible', async ({ page }) => {
    const liveDot = page.locator('[title="Live"]');
    await expect(liveDot).toBeVisible();
  });
});

test.describe('Code Explorer API', () => {
  test('/api/files returns file array', async ({ request }) => {
    const response = await request.get('/api/files');
    expect(response.status()).toBe(200);
    const body = await response.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBeGreaterThan(0);
    // Each file has required fields
    const file = body[0];
    expect(file).toHaveProperty('id');
    expect(file).toHaveProperty('path');
    expect(file).toHaveProperty('language');
  });

  test('/api/graph returns nodes and edges', async ({ request }) => {
    const response = await request.get('/api/graph');
    expect(response.status()).toBe(200);
    const body = await response.json();
    expect(body).toHaveProperty('nodes');
    expect(body).toHaveProperty('edges');
    expect(Array.isArray(body.nodes)).toBe(true);
    expect(Array.isArray(body.edges)).toBe(true);
  });

  test('/api/stats returns codebase statistics', async ({ request }) => {
    const response = await request.get('/api/stats');
    expect(response.status()).toBe(200);
    const body = await response.json();
    expect(body).toHaveProperty('files');
    expect(body).toHaveProperty('exports');
    expect(body).toHaveProperty('deps');
    expect(body).toHaveProperty('extensions');
    expect(typeof body.files).toBe('number');
  });

  test('/api/file/:id returns detail with exports', async ({ request }) => {
    // Get a file ID first
    const filesRes = await request.get('/api/files');
    const files = await filesRes.json();
    const fileId = files[0].id;

    const response = await request.get(`/api/file/${fileId}`);
    expect(response.status()).toBe(200);
    const body = await response.json();
    expect(body).toHaveProperty('path');
    expect(body).toHaveProperty('exports');
    expect(body).toHaveProperty('imports');
    expect(body).toHaveProperty('importedBy');
    expect(Array.isArray(body.exports)).toBe(true);

    // If exports exist, they should be objects with name/kind/description
    if (body.exports.length > 0) {
      const exp = body.exports[0];
      expect(exp).toHaveProperty('name');
      expect(exp).toHaveProperty('kind');
      expect(exp).toHaveProperty('description');
    }
  });

  test('/api/directories returns directory list', async ({ request }) => {
    const response = await request.get('/api/directories');
    expect(response.status()).toBe(200);
    const body = await response.json();
    expect(Array.isArray(body)).toBe(true);
    if (body.length > 0) {
      expect(body[0]).toHaveProperty('path');
      expect(body[0]).toHaveProperty('file_count');
    }
  });
});
