import type { Request } from '@playwright/test';
import { expect, login, type Page } from '../e2e/helpers';

export { test, expect } from '../e2e/helpers';

/** The browser clock: some hours after the frozen db time (test/e2e/serve.mjs VISUAL_TIME). */
const NOW = new Date('2026-10-01T14:00:00Z');

/** Requests in flight per page; the SSE stream (/api/events) never ends, so it does not count. */
const inflight = new WeakMap<Page, Set<Request>>();

function track(page: Page): void {
  const open = new Set<Request>();
  inflight.set(page, open);
  page.on('request', (r) => {
    if (!r.url().includes('/api/events')) open.add(r);
  });
  const done = (r: Request) => open.delete(r);
  page.on('requestfinished', done);
  page.on('requestfailed', done);
}

/**
 * Make one page repeatable before it loads anything:
 * - fake clock: Date, timers and animation frames move only when settle() advances them,
 *   so every animation (framer-motion ignores reduced motion for loops) stops at the same frame,
 * - seeded Math.random (DependencyGraph layout),
 * - landing animation and tour dismissed unless a test wants them.
 */
export async function prepare(
  page: Page,
  { landing = false, tour = false }: { landing?: boolean; tour?: boolean } = {},
): Promise<void> {
  track(page);
  await page.clock.install({ time: NOW });
  await page.addInitScript(
    ({ landing, tour }) => {
      // mulberry32: small, fast, good enough for layout seeds. settle() resets it.
      let seed = 42;
      (window as unknown as { __visualReseed: () => void }).__visualReseed = () => {
        seed = 42;
      };
      Math.random = () => {
        seed = (seed + 0x6d2b79f5) | 0;
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
      if (!landing) sessionStorage.setItem('landing-played', 'true');
      if (!tour) localStorage.setItem('tour-completed', 'true');
    },
    { landing, tour },
  );
  await login(page);
}

/** Open a route and wait until the page and its fonts are ready. */
export async function open(page: Page, hash: string): Promise<void> {
  await page.goto(`/${hash}`);
  await page.waitForSelector('[role="tablist"]', { timeout: 15_000 });
  await settle(page);
}

/**
 * Wait until the page is quiet, the same way in every run:
 * 1. no request in flight for QUIET_MS (real time; a loading page can show two equal blank frames),
 * 2. advance the fake clock by a fixed step (entry animations end, timers fire),
 * 3. quiet again (timers may have fetched), fonts loaded.
 */
const QUIET_MS = 500;
const CLOCK_STEP_MS = 3_000;
async function quiet(page: Page): Promise<void> {
  const open = inflight.get(page)!;
  await expect
    .poll(
      async () => {
        if (open.size > 0) return false;
        await page.waitForTimeout(QUIET_MS);
        return open.size === 0;
      },
      { timeout: 20_000, message: 'requests still in flight' },
    )
    .toBe(true);
}
export async function settle(page: Page): Promise<void> {
  await quiet(page);
  await page.clock.runFor(CLOCK_STEP_MS);
  await quiet(page);
  await page.evaluate(async () => {
    await document.fonts.ready;
    // Layouts drawn from Math.random (DependencyGraph) may have run a varying
    // number of times: reset the seed and draw once more on a resize.
    (window as unknown as { __visualReseed: () => void }).__visualReseed();
    window.dispatchEvent(new Event('resize'));
  });
  await freezeAnimations(page);
}

/**
 * CSS animations and transitions run on real time, not on the fake clock:
 * finish them, and stop endless ones at their first frame.
 */
async function freezeAnimations(page: Page): Promise<void> {
  await page.evaluate(() => {
    for (const a of document.getAnimations()) {
      if (a.effect?.getComputedTiming().iterations === Infinity) {
        a.pause();
        a.currentTime = 0;
      } else {
        a.finish();
      }
    }
  });
}

/** Screenshot gate: zero pixels may differ (playwright.visual.config.ts). */
export async function shot(
  page: Page,
  name: string,
  { keepPointer = false }: { keepPointer?: boolean } = {},
): Promise<void> {
  // Park the mouse on the empty top-left corner: a hover left over from a click is no state under test.
  if (!keepPointer) await page.mouse.move(0, 0);
  await settle(page);
  await expect(page).toHaveScreenshot(`${name}.png`);
}

/**
 * Computed-style gate: a text dump of the visual CSS of every element.
 * - It names the element and the property that changed, which a PNG diff cannot.
 * - It also covers what is off-screen, behind a modal, or under a scroll pane.
 * - Inherited properties are listed only where they differ from the parent,
 *   other properties only where they differ from the initial value of the tag.
 */
export async function styles(page: Page, name: string): Promise<void> {
  // Elements can mount between the screenshot and the dump; freeze their animations too.
  await freezeAnimations(page);
  const dump = await page.evaluate(() => {
    const INHERITED = [
      'color',
      'cursor',
      'font-family',
      'font-size',
      'font-style',
      'font-weight',
      'letter-spacing',
      'line-height',
      'text-align',
      'text-transform',
      'visibility',
      'white-space',
      '-webkit-font-smoothing',
    ];
    const OWN = [
      'display',
      'position',
      'top',
      'right',
      'bottom',
      'left',
      'z-index',
      'box-sizing',
      'width',
      'height',
      'min-width',
      'min-height',
      'max-width',
      'max-height',
      'margin-top',
      'margin-right',
      'margin-bottom',
      'margin-left',
      'padding-top',
      'padding-right',
      'padding-bottom',
      'padding-left',
      'border-top',
      'border-right',
      'border-bottom',
      'border-left',
      'border-radius',
      'outline',
      'background-color',
      'background-image',
      'background-size',
      'background-position',
      'box-shadow',
      'opacity',
      'transform',
      'filter',
      'backdrop-filter',
      'overflow-x',
      'overflow-y',
      'text-overflow',
      'text-decoration-line',
      'vertical-align',
      'flex-direction',
      'flex-wrap',
      'flex-grow',
      'flex-shrink',
      'flex-basis',
      'justify-content',
      'align-items',
      'align-self',
      'row-gap',
      'column-gap',
      'grid-template-columns',
      'grid-template-rows',
      'grid-column',
      'grid-row',
      'transition-property',
      'transition-duration',
      'transition-timing-function',
      'animation-name',
      'animation-duration',
      'pointer-events',
      'user-select',
      'fill',
      'stroke',
    ];
    // Initial values per tag, from a clean element in a style-free iframe.
    const frame = document.createElement('iframe');
    frame.style.display = 'none';
    document.body.appendChild(frame);
    const clean = frame.contentDocument!;
    const initial = new Map<string, CSSStyleDeclaration>();
    const initialOf = (tag: string) => {
      if (!initial.has(tag)) {
        const el = clean.createElement(tag);
        clean.body.appendChild(el);
        initial.set(tag, frame.contentWindow!.getComputedStyle(el));
      }
      return initial.get(tag)!;
    };
    const pathOf = (el: Element): string => {
      const parts: string[] = [];
      for (let e: Element | null = el; e && e !== document.body; e = e.parentElement) {
        const idx = e.parentElement ? Array.prototype.indexOf.call(e.parentElement.children, e) : 0;
        parts.unshift(`${e.tagName.toLowerCase()}[${idx}]`);
      }
      return parts.join('>');
    };
    const lines: string[] = [];
    for (const el of Array.from(document.body.querySelectorAll('*'))) {
      if (el === frame) continue;
      const cs = getComputedStyle(el);
      const ps = el.parentElement ? getComputedStyle(el.parentElement) : null;
      const init = initialOf(el.tagName.toLowerCase());
      const props: string[] = [];
      for (const p of INHERITED) {
        const v = cs.getPropertyValue(p);
        if (!ps || v !== ps.getPropertyValue(p)) props.push(`${p}:${v}`);
      }
      for (const p of OWN) {
        const v = cs.getPropertyValue(p);
        if (v !== init.getPropertyValue(p)) props.push(`${p}:${v}`);
      }
      lines.push(`${pathOf(el)} {${props.join(';')}}`);
    }
    frame.remove();
    return lines.join('\n') + '\n';
  });
  expect(dump).toMatchSnapshot(`${name}.styles.snap`);
}
