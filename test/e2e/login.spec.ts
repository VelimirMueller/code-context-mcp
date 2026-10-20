import { test, expect, E2E_TOKEN, login, openApp } from './helpers';

/**
 * Browser login (#243): without the launch URL the browser gets a help page
 * and no token; after it, the HttpOnly cookie carries fetch and SSE, and page
 * scripts cannot read it.
 */

test('without a launch URL the browser sees the login help, never the token', async ({ page }) => {
  const res = await page.goto('/');
  expect(res?.status()).toBe(401);
  await expect(page.getByText('/ccui')).toBeVisible();
  expect(await page.content()).not.toContain(E2E_TOKEN);
});

test('a used launch URL does not log a second browser in', async ({ page, browser }) => {
  const minted = await page.request.post('/api/auth/launch', {
    headers: { Authorization: `Bearer ${E2E_TOKEN}` },
  });
  const { url } = (await minted.json()) as { url: string };
  await page.goto(url);
  const other = await browser.newContext();
  const res = await (await other.newPage()).goto(url);
  expect(res?.status()).toBe(401);
  await other.close();
});

test('after login the cookie carries fetch and SSE, and scripts cannot read it', async ({
  page,
}) => {
  await openApp(page);
  const result = await page.evaluate(async () => {
    const r = await fetch('/api/sprints');
    const sse = await new Promise<boolean>((resolve) => {
      const es = new EventSource('/api/events');
      es.onmessage = () => {
        es.close();
        resolve(true);
      };
      es.onerror = () => {
        es.close();
        resolve(false);
      };
    });
    return { status: r.status, sse, cookie: document.cookie };
  });
  expect(result.status).toBe(200);
  expect(result.sse).toBe(true);
  expect(result.cookie).not.toContain('cc_dashboard_session');
  const cookies = await page.context().cookies();
  const session = cookies.find((c) => c.name === 'cc_dashboard_session');
  expect(session?.httpOnly).toBe(true);
  expect(session?.sameSite).toBe('Strict');
});

test('login() works on its own and a cookie write passes the origin check', async ({ page }) => {
  await login(page);
  const status = await page.evaluate(
    async () => (await fetch('/api/notify', { method: 'POST' })).status,
  );
  expect(status).toBe(200);
});
