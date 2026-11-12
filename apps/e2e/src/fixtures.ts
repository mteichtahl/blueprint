import { readFileSync } from 'node:fs';
import {
  test as base,
  expect,
  type Browser,
  type BrowserContext,
  type Locator,
  type Page,
} from '@playwright/test';
import { E2E_ACCOUNTS, type E2eAccountKey } from '@bmg/config/e2e';
import { account, baseUrl } from './accounts.ts';
import { appConfig } from './api.ts';
import { freshCode } from './totp.ts';

/** The release in this checkout; marked as seen so "What's new" doesn't cover the screen. */
export const VERSION = readFileSync(new URL('../../../VERSION', import.meta.url), 'utf8').trim();

const isArtist = (key: E2eAccountKey) => E2E_ACCOUNTS[key].role === 'artist';

/** Blueprint works on a desktop; artists on a phone (the artist app is phone-first). */
const DESKTOP = { viewport: { width: 1440, height: 900 } };
const PHONE = {
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 3,
  isMobile: true,
  hasTouch: true,
};

/** The app's frame once signed in: the sidebar for Blueprint, the tab bar for artists. */
export const shellOf = (page: Page, key: E2eAccountKey): Locator =>
  isArtist(key)
    ? page.getByRole('navigation', { name: 'Tabs' })
    : page.getByRole('navigation', { name: 'Main' });

/** Signs in through the real sign-in screens: email, password, then a 6-digit code. */
export async function signIn(page: Page, key: E2eAccountKey): Promise<void> {
  const a = await account(key);
  await page.goto('/');
  await page.getByLabel('Email').fill(a.email);
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByLabel('Password').fill(a.password);
  await page.getByRole('button', { name: 'Sign in with password' }).click();
  await page.getByLabel('6-digit code').fill(await freshCode(a.email, a.totpSecret));
  await page.getByRole('button', { name: 'Verify' }).click();
  // After a password sign-in the app offers a passkey for this device.
  const shell = shellOf(page, key);
  const noPasskey = page.getByRole('button', { name: /ask again on this device/i });
  await expect(shell.or(noPasskey).first()).toBeVisible({ timeout: 30_000 });
  if (await noPasskey.isVisible()) await noPasskey.click();
  await expect(shell).toBeVisible({ timeout: 30_000 });
}

/** A new, signed-out browser context set up like the account's device. */
export async function newContext(browser: Browser, key: E2eAccountKey): Promise<BrowserContext> {
  const context = await browser.newContext({
    ...(isArtist(key) ? PHONE : DESKTOP),
    baseURL: await baseUrl(),
    locale: 'en-AU',
    timezoneId: 'Australia/Melbourne',
  });
  await context.addInitScript((version) => {
    try {
      window.localStorage.setItem('bmg-seen-release', version);
    } catch {
      // Storage blocked: "What's new" may show; nothing here depends on it.
    }
  }, VERSION);
  return context;
}

/**
 * Lets a screen finish loading. The app keeps a realtime socket open and polls
 * a little, so "network idle" may never come; a few quiet seconds are enough.
 */
export async function settle(page: Page): Promise<void> {
  await page.waitForLoadState('networkidle', { timeout: 8_000 }).catch(() => undefined);
}

/** Problems any page must not have: uncaught errors and server errors from the API. */
export function watchForProblems(page: Page, apiBase: string): string[] {
  const problems: string[] = [];
  page.on('pageerror', (err) => problems.push(`page error: ${err.message}`));
  page.on('response', (res) => {
    if (res.status() >= 500 && res.url().startsWith(apiBase))
      problems.push(`${res.request().method()} ${new URL(res.url()).pathname} → ${res.status()}`);
  });
  return problems;
}

interface WorkerFixtures {
  /** One signed-in browser context per account, shared by every test in the worker. */
  sessionFor: (key: E2eAccountKey) => Promise<BrowserContext>;
}
interface TestFixtures {
  /** A new tab, signed in as the account, that fails the test on page errors or 5xx answers. */
  pageAs: (key: E2eAccountKey) => Promise<Page>;
}

export const test = base.extend<TestFixtures, WorkerFixtures>({
  sessionFor: [
    async ({ browser }, use) => {
      const sessions = new Map<E2eAccountKey, Promise<BrowserContext>>();
      await use((key) => {
        let s = sessions.get(key);
        if (!s) {
          s = (async () => {
            const context = await newContext(browser, key);
            const page = await context.newPage();
            await signIn(page, key);
            await page.close();
            return context;
          })();
          sessions.set(key, s);
        }
        return s;
      });
      for (const s of sessions.values()) await (await s).close();
    },
    { scope: 'worker', timeout: 180_000 },
  ],

  pageAs: async ({ sessionFor }, use) => {
    const opened: { page: Page; problems: string[] }[] = [];
    const { apiBase } = await appConfig();
    await use(async (key) => {
      const page = await (await sessionFor(key)).newPage();
      opened.push({ page, problems: watchForProblems(page, apiBase) });
      await page.goto('/');
      await expect(shellOf(page, key)).toBeVisible({ timeout: 30_000 });
      return page;
    });
    for (const { page, problems } of opened) {
      await page.close();
      expect(problems, 'page errors or 5xx API answers').toEqual([]);
    }
  },
});

export { expect };
