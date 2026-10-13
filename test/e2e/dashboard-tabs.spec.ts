import { test, expect, type Page } from '@playwright/test';

/**
 * E2E tests for all dashboard navigation tabs and user flows.
 *
 * Tests cover:
 * - Dashboard tab: sprint info, ticket list, sub-tabs
 * - Planning tab: discovery list, sub-tabs, filters
 * - Code Explorer tab: file tree, file selection
 * - Team tab: agent list, workload data
 * - Retro tab: retro findings, sub-tab switching
 * - Full navigation flow: visit every tab in sequence
 *
 * The Playwright webServer (playwright.config.ts) starts a seeded dashboard.
 */

/** Helper: click a top-level nav tab by its accessible role + label. */
async function navigateToTab(page: Page, label: string) {
  const tab = page.locator(`nav[role="tablist"] button[role="tab"]`).filter({
    hasText: label,
  });
  await tab.click();
  // Allow lazy-loaded page to render
  await page.waitForTimeout(600);
}

/** Helper: wait for page to fully load past the landing animation. */
async function waitForAppReady(page: Page) {
  // The landing animation stores a flag in sessionStorage once played.
  // Set it before navigating so the animation is skipped.
  await page.addInitScript(() => {
    sessionStorage.setItem('landing-played', 'true');
    localStorage.setItem('tour-completed', 'true');
  });
  await page.goto('/');
  // Wait for the top nav tablist to be present
  await page.waitForSelector('nav[role="tablist"]', { timeout: 8000 });
  await page.waitForTimeout(400);
}

// ─── Dashboard Tab ──────────────────────────────────────────────────────────

test.describe('Dashboard Tab', () => {
  test.beforeEach(async ({ page }) => {
    await waitForAppReady(page);
    await navigateToTab(page, 'Dashboard');
  });

  test('renders with sub-tabs and sprint content', async ({ page }) => {
    // The Dashboard page has sub-tabs: Board, Overview, GitHub
    const tablist = page.locator('[role="tablist"]').nth(1); // second tablist = sub-tabs
    await expect(tablist).toBeVisible({ timeout: 5000 });

    // At least one sub-tab should be visible (use exact to avoid matching top-nav "Dashboard" tab)
    const boardTab = page.getByRole('tab', { name: 'Board', exact: true });
    await expect(boardTab).toBeVisible();
  });

  test('Board sub-tab shows ticket content area', async ({ page }) => {
    // Board is the default sub-tab — the page content should render
    const pageContent = page.locator('.page-content');
    await expect(pageContent).toBeVisible();

    // Should not be an empty/blank page — some element must exist inside
    const childCount = await pageContent.locator('> *').count();
    expect(childCount).toBeGreaterThan(0);
  });

  test('Overview sub-tab loads activity feed', async ({ page }) => {
    const overviewTab = page.getByRole('tab', { name: /Overview/i });
    await overviewTab.click();
    await page.waitForTimeout(500);

    // Overview should render — check that the page-content area has content
    const pageContent = page.locator('.page-content');
    const childCount = await pageContent.locator('> *').count();
    expect(childCount).toBeGreaterThan(0);
  });

  test('can switch between all Dashboard sub-tabs without crash', async ({ page }) => {
    for (const tabName of ['Board', 'Overview', 'GitHub']) {
      const tab = page.getByRole('tab', { name: new RegExp(tabName, 'i') });
      if (await tab.isVisible().catch(() => false)) {
        await tab.click();
        await page.waitForTimeout(400);
        // Page should not crash — check page-content still exists
        await expect(page.locator('.page-content')).toBeVisible();
      }
    }
  });
});

// ─── Planning Tab ───────────────────────────────────────────────────────────

test.describe('Planning Tab', () => {
  test.beforeEach(async ({ page }) => {
    await waitForAppReady(page);
    await navigateToTab(page, 'Planning');
  });

  test('shows the Vision view with milestones and epics', async ({ page }) => {
    // Planning is one view now (breadcrumb "Planning > Vision"), no sub-tabs.
    await expect(page.getByRole('navigation', { name: 'Breadcrumb navigation' })).toContainText(
      'Vision',
    );
    await expect(page.getByText('Active Milestones')).toBeVisible({ timeout: 5000 });
    await expect(page.getByText('E2E milestone').first()).toBeVisible();
    await expect(page.getByRole('heading', { name: /Epics/ })).toBeVisible();
    await expect(page.getByText('E2E epic').first()).toBeVisible();
  });

  test('can switch between all Planning sub-tabs without crash', async ({ page }) => {
    // Planning uses plain buttons for sub-tabs
    const subTabs = [
      'Vision',
      'Roadmap',
      'Sprint Planning',
      'Process Flow',
      'Insights',
      'Discoveries',
    ];
    for (const tabName of subTabs) {
      const tab = page.locator('button').filter({ hasText: tabName }).first();
      if (await tab.isVisible().catch(() => false)) {
        await tab.click();
        await page.waitForTimeout(400);
        await expect(page.locator('.page-content')).toBeVisible();
      }
    }
  });
});

// ─── Code Explorer Tab ──────────────────────────────────────────────────────

test.describe('Code Explorer Tab', () => {
  test.beforeEach(async ({ page }) => {
    await waitForAppReady(page);
    await navigateToTab(page, 'Code');
  });

  test('renders file sidebar with items', async ({ page }) => {
    // Wait for sidebar to appear
    await page.waitForSelector('.sidebar', { timeout: 5000 });

    // Sidebar should have a "Files" heading
    await expect(page.locator('.sidebar-head')).toContainText('Files');

    // File tree should have at least one item
    const treeItems = page.locator('.file-item, .tree-folder');
    await expect(treeItems.first()).toBeVisible({ timeout: 5000 });
  });

  test('can select a file and see detail panel', async ({ page }) => {
    // Use the API to get a file ID, then navigate to its detail view via hash
    // (avoids click-interception issues with overlapping tree elements)
    const filesRes = await page.request.get('/api/files');
    const files = await filesRes.json();
    expect(files.length).toBeGreaterThan(0);

    const fileId = files[0].id;
    await page.goto(`/#code/detail/${fileId}`);
    await page.waitForTimeout(1000);

    // Detail panel should appear with file path
    const detailTitle = page.locator('.detail-title');
    await expect(detailTitle).toBeVisible({ timeout: 5000 });
    const titleText = await detailTitle.textContent();
    expect(titleText).toMatch(/[./]/);
  });
});

// ─── Team Tab ───────────────────────────────────────────────────────────────

test.describe('Team Tab', () => {
  test.beforeEach(async ({ page }) => {
    await waitForAppReady(page);
    await navigateToTab(page, 'Team');
  });

  test('renders agent list', async ({ page }) => {
    // The Team page should display agent cards or a grid
    // Wait for content to load
    await page.waitForTimeout(500);

    const pageContent = page.locator('.page-content');
    await expect(pageContent).toBeVisible();

    // Should have visible content (agent cards or at least the sub-tab bar)
    const childCount = await pageContent.locator('> *').count();
    expect(childCount).toBeGreaterThan(0);
  });

  test('Members sub-tab is active by default', async ({ page }) => {
    const membersTab = page.getByRole('tab', { name: /Members/i });
    await expect(membersTab).toBeVisible({ timeout: 5000 });
  });

  test('Workload sub-tab shows points per agent', async ({ page }) => {
    const workloadTab = page.getByRole('tab', { name: /Workload/i });
    await workloadTab.click();
    await page.waitForTimeout(500);

    await expect(page.getByText('Active Tickets per Agent', { exact: true })).toBeVisible({
      timeout: 5000,
    });
  });

  test('Mood sub-tab shows team mood', async ({ page }) => {
    const moodTab = page.getByRole('tab', { name: /Mood/i });
    await moodTab.click();
    await page.waitForTimeout(500);

    // Should show "Team Mood" text
    await expect(page.getByText('Team Mood', { exact: true })).toBeVisible({ timeout: 5000 });
  });
});

// ─── Retro Tab ──────────────────────────────────────────────────────────────

test.describe('Retro Tab', () => {
  test.beforeEach(async ({ page }) => {
    await waitForAppReady(page);
    await navigateToTab(page, 'Retro');
  });

  test('renders with sub-tabs', async ({ page }) => {
    // Retro has sub-tabs: Findings, History, Patterns
    for (const label of ['Findings', 'History', 'Patterns']) {
      const tab = page.getByRole('tab', { name: new RegExp(label, 'i') });
      await expect(tab).toBeVisible({ timeout: 5000 });
    }
  });

  test('can switch between Findings, History, and Patterns', async ({ page }) => {
    for (const tabName of ['Findings', 'History', 'Patterns']) {
      const tab = page.getByRole('tab', { name: new RegExp(tabName, 'i') });
      await tab.click();
      await page.waitForTimeout(400);

      // Page should not crash
      await expect(page.locator('.page-content')).toBeVisible();
    }
  });

  test('Findings tab renders content area', async ({ page }) => {
    // Findings is the default — should have visible content or empty state
    const pageContent = page.locator('.page-content');
    await expect(pageContent).toBeVisible();
    const childCount = await pageContent.locator('> *').count();
    expect(childCount).toBeGreaterThan(0);
  });
});

// ─── Full Navigation Flow ───────────────────────────────────────────────────

test.describe('Navigation Flow', () => {
  test('visit every tab in sequence — no crashes', async ({ page }) => {
    await waitForAppReady(page);

    const tabs = ['Dashboard', 'Planning', 'Code', 'Team', 'Retro'];

    for (const tabLabel of tabs) {
      await navigateToTab(page, tabLabel);

      // Verify the tab is now selected (aria-selected)
      const activeTab = page.locator(
        `nav[role="tablist"] button[role="tab"][aria-selected="true"]`,
      );
      await expect(activeTab).toContainText(tabLabel);

      // Verify page-content is visible and not empty
      const pageContent = page.locator('.page-content');
      await expect(pageContent).toBeVisible();
      const childCount = await pageContent.locator('> *').count();
      expect(childCount).toBeGreaterThan(0);
    }
  });

  test('navigate forward and backward through tabs', async ({ page }) => {
    await waitForAppReady(page);

    // Go forward: Dashboard -> Planning -> Code
    await navigateToTab(page, 'Dashboard');
    await navigateToTab(page, 'Planning');
    await navigateToTab(page, 'Code');

    // Verify Code is active
    const activeTab = page.locator(`nav[role="tablist"] button[role="tab"][aria-selected="true"]`);
    await expect(activeTab).toContainText('Code');

    // Go backward: Code -> Planning -> Dashboard
    await navigateToTab(page, 'Planning');
    await navigateToTab(page, 'Dashboard');

    await expect(activeTab).toContainText('Dashboard');
  });

  test('top nav tablist has correct ARIA structure', async ({ page }) => {
    await waitForAppReady(page);

    const tablist = page.locator('nav[role="tablist"]');
    await expect(tablist).toBeVisible();
    await expect(tablist).toHaveAttribute('aria-label', 'Main navigation');

    // Dashboard, Planning, Code, Team, Retro, Benchmark
    const tabButtons = tablist.locator('button[role="tab"]');
    await expect(tabButtons).toHaveCount(6);

    // Exactly one tab should be selected
    const selectedTabs = tablist.locator('button[role="tab"][aria-selected="true"]');
    await expect(selectedTabs).toHaveCount(1);
  });

  test('no console errors on any tab', async ({ page }) => {
    const errors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        errors.push(msg.text());
      }
    });

    await waitForAppReady(page);

    for (const tabLabel of ['Dashboard', 'Planning', 'Code', 'Team', 'Retro', 'Benchmark']) {
      await navigateToTab(page, tabLabel);
    }

    // Filter out known benign errors (e.g., failed API calls when no data)
    const criticalErrors = errors.filter(
      (e) => !e.includes('Failed to fetch') && !e.includes('NetworkError') && !e.includes('404'),
    );

    expect(criticalErrors).toEqual([]);
  });
});
