import { expect, test } from '@playwright/test';
import { baseUrl } from '../src/accounts.ts';
import { call, ok } from '../src/api.ts';

/**
 * UAT script Q (rev 21): the public consultation form and the team's
 * Enquiries. A real send needs a person to solve the CAPTCHA, so these check
 * the form opens without a sign-in, the WAF stops a send without a solved
 * puzzle, and the team's routes are Blueprint only.
 */

test('Q-01: the form opens without a sign-in, and the country list searches', async ({
  browser,
}) => {
  const context = await browser.newContext({ baseURL: await baseUrl(), locale: 'en-AU' });
  const page = await context.newPage();
  await page.goto('/consult');
  await expect(page.getByRole('heading', { name: 'Book a consultation' })).toBeVisible();
  for (const label of ['Your name', 'Email', 'Tell us about yourself', 'How can BMG help?'])
    await expect(page.getByLabel(label, { exact: true })).toBeVisible();
  await page.getByRole('button', { name: /^Country/ }).click();
  await page.getByRole('combobox', { name: 'Search countries' }).fill('new zea');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('button', { name: /^Country New Zealand/ })).toBeVisible();
  await context.close();
});

test('Q-02: a send without a solved CAPTCHA never reaches the app', async () => {
  const res = await fetch(`${await baseUrl()}/public/enquiries`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: 'E2E bot',
      email: 'bot+bmg-e2e-admin@example.com',
      country: 'AU',
      aboutMe: 'x',
      howCanWeHelp: 'x',
      elapsedMs: 10_000,
    }),
  });
  // AWS WAF answers a CAPTCHA action with 405 and its own page.
  expect(res.status).toBe(405);
});

test('Q-03: only the Blueprint team can see requests', async () => {
  const list = await call('artistOn', 'GET', '/enquiries');
  expect(list.status).toBe(403);
  const counts = await ok<{ open: number }>('staff', 'GET', '/enquiries?summary=1');
  expect(typeof counts.open).toBe('number');
  expect(JSON.stringify(counts)).not.toContain('@');
});
