import type { Page } from '@playwright/test';

/**
 * Open the dashboard with the landing animation and the first-run tour
 * already dismissed (their flags live in session/local storage).
 */
export async function openApp(page: Page, hash = ''): Promise<void> {
  await page.addInitScript(() => {
    sessionStorage.setItem('landing-played', 'true');
    localStorage.setItem('tour-completed', 'true');
  });
  await page.goto(`/${hash}`);
  await page.waitForSelector('[role="tablist"]', { timeout: 10_000 });
}
