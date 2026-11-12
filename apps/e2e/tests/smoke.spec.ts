import { artistIdOf } from '../src/api.ts';
import { expect, newContext, settle, signIn, shellOf, test, VERSION } from '../src/fixtures.ts';

/**
 * UAT script S (smoke) and B (navigation patterns): every main screen opens
 * without a page error or a server error, and no back link says "← Back".
 */

const BMG_SCREENS = [
  'Overview',
  'Artist gigs',
  'Artists & applications',
  'Plan templates',
  'Chat',
  'Tasks & to-dos',
  'Document library',
  'Review queue',
  'Insights',
  'Contacts',
  'Venues',
  'Meetings',
  'Events',
  'Newsroom',
  'Connectors',
  'Access & permissions',
  'AI prompts',
];

const WORKSPACE = {
  Overview: ['Summary', 'Stats'],
  Plan: ['Outcome', 'Stages', 'Timeline', 'History'],
  Work: ['To-dos', 'Submissions', 'Gigs'],
  Files: ['Library', 'Brand kit'],
} as const;

const startsWith = (label: string) =>
  new RegExp(`^\\s*${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`);

test.describe('Blueprint (desktop)', () => {
  test('S-03: the menu footer shows this release', async ({ pageAs }) => {
    const page = await pageAs('admin');
    const channel = process.env.E2E_CHANNEL ?? 'beta';
    await expect(page.getByText(`Version ${channel}-${VERSION}`)).toBeVisible();
  });

  test('S-04, B-06: every main screen opens cleanly', async ({ pageAs }) => {
    const page = await pageAs('admin');
    const nav = page.getByRole('navigation', { name: 'Main' });
    for (const screen of BMG_SCREENS) {
      await test.step(screen, async () => {
        const item = nav.getByRole('button', { name: startsWith(screen) }).first();
        await item.click();
        await expect(item).toHaveAttribute('aria-current', 'page');
        await settle(page);
        await expect(page.getByRole('main')).not.toContainText('← Back');
      });
    }
  });

  test('B-08: the artist workspace has two levels of tabs, all of which open', async ({
    pageAs,
  }) => {
    const page = await pageAs('admin');
    await page.goto(`/?go=plan:${await artistIdOf('artistOn')}`);
    const tabs = page.getByRole('tablist', { name: 'Workspace' });
    await expect(tabs).toBeVisible();
    for (const [group, sections] of Object.entries(WORKSPACE)) {
      await test.step(group, async () => {
        const tab = tabs.getByRole('tab', { name: startsWith(group) });
        await tab.click();
        await expect(tab).toHaveAttribute('aria-selected', 'true');
        const switcher = page.getByRole('tablist', { name: `${group} sections` });
        for (const section of sections) {
          const s = switcher.getByRole('tab', { name: startsWith(section) });
          await s.click();
          await expect(s).toHaveAttribute('aria-selected', 'true');
          await settle(page);
          await expect(page.getByRole('main')).not.toContainText('← Back');
        }
      });
    }
  });
});

test.describe('Artists (phone)', () => {
  const TABS = ['Home', 'Chat', 'To-do', 'Gigs', 'Library'];

  test('S-08: an artist can open every tab', async ({ pageAs }) => {
    const page = await pageAs('artistOn');
    const tabbar = page.getByRole('navigation', { name: 'Tabs' });
    for (const name of TABS) {
      await test.step(name, async () => {
        const tab = tabbar.getByRole('button', { name: startsWith(name) });
        await tab.click();
        await expect(tab).toHaveAttribute('aria-current', 'page');
        await settle(page);
        await expect(page.getByRole('main')).not.toContainText('← Back');
      });
    }
  });

  test('A-07, M-06: the assistant shows for an opted-in artist only', async ({ pageAs }) => {
    const on = await pageAs('artistOn');
    await expect(on.getByRole('button', { name: 'Ask BMG' })).toBeVisible();
    const off = await pageAs('artistOff');
    await expect(shellOf(off, 'artistOff')).toBeVisible();
    await expect(off.getByRole('button', { name: 'Ask BMG' })).toHaveCount(0);
  });
});

test('S-10: signing out returns to the sign-in screen', async ({ browser }) => {
  // Its own browser context, so the shared sessions stay signed in.
  const context = await newContext(browser, 'staff');
  const page = await context.newPage();
  await signIn(page, 'staff');
  await page
    .getByRole('button', { name: /your account$/i })
    .first()
    .click();
  await page.getByRole('menuitem', { name: 'Sign out' }).click();
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  await context.close();
});
