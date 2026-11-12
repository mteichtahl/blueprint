import { defineConfig } from '@playwright/test';

/**
 * End-to-end tests against a deployed environment (docs/e2e.md). They run after
 * every staging deploy, as the dedicated E2E accounts, and only touch data those
 * accounts own. The base URL comes from E2E_BASE_URL or the accounts secret, so
 * pages use relative paths.
 *
 * One worker: the accounts sign in with authenticator codes, and Cognito takes
 * each code once, so sessions are shared and signed in one at a time.
 */
const ci = !!process.env.CI;

export default defineConfig({
  testDir: './tests',
  fullyParallel: false,
  workers: 1,
  forbidOnly: ci,
  // A deployed environment can blip; a retry separates that from a real break.
  retries: ci ? 1 : 0,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: ci
    ? [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }], ['github']]
    : [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],
  outputDir: 'test-results',
  use: {
    browserName: 'chromium',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
  },
});
