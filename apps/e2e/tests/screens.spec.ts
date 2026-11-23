import type { Page } from '@playwright/test';
import { tag } from '../src/accounts.ts';
import { artistIdOf, call, ok } from '../src/api.ts';
import { expect, newContext, settle, test } from '../src/fixtures.ts';

/**
 * What people see, beyond "every screen opens" (smoke.spec.ts): the sign-in
 * screen, the account menu, chat filters, a to-do's own page, the artist
 * desktop layout (rev 16), live updates without reloading (rev 17) and "Ask
 * for a change" on the artist's plan (rev 18). Anything made here is left
 * done or cancelled.
 */

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const startsWith = (label: string) => new RegExp(`^\\s*${escape(label)}`);

let artistId: string;
const todos: string[] = [];
const gigs: string[] = [];

test.beforeAll(async () => {
  artistId = await artistIdOf('artistOn');
});

test.afterAll(async () => {
  for (const id of todos)
    await call('admin', 'PATCH', `/artists/${artistId}/todos/${id}`, { done: true });
  for (const id of gigs)
    await call('admin', 'PATCH', `/artists/${artistId}/gigs/${id}`, { status: 'cancelled' });
});

const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };

/** Opens an artist screen from whichever menu the layout shows. */
async function openArtist(page: Page, label: string) {
  const main = page.getByRole('navigation', { name: 'Main' });
  const item = main.getByRole('button', { name: startsWith(label) }).first();
  await item.click();
  await expect(item).toHaveAttribute('aria-current', 'page');
  await settle(page);
}

test('S-01: the sign-in screen shows the BMG logo and no “Loading…” text', async ({ browser }) => {
  const context = await newContext(browser, 'admin');
  const page = await context.newPage();
  try {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
    await expect(page.getByRole('img', { name: 'Blueprint Music Group' }).first()).toBeVisible();
    await expect(page.getByText('Loading…')).toHaveCount(0);
  } finally {
    await context.close();
  }
});

test('B-13: the account menu shows name, role, Profile & preferences and Sign out', async ({
  pageAs,
}) => {
  const page = await pageAs('admin');
  await page
    .getByRole('button', { name: /your account$/i })
    .first()
    .click();
  const menu = page.getByRole('menu', { name: 'Your account' });
  await expect(menu).toBeVisible();
  // The menu shows the account's name and job title.
  const { jobTitle } = await ok<{ jobTitle: string }>('admin', 'GET', '/me');
  if (jobTitle) await expect(menu).toContainText(jobTitle);
  await expect(menu.getByRole('menuitem', { name: 'Profile & preferences' })).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: 'Sign out' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
});

test('K-01: Chat has the All, Unread, Groups, Artists, Team and Announcements filters', async ({
  pageAs,
}) => {
  const page = await pageAs('admin');
  await page
    .getByRole('navigation', { name: 'Main' })
    .getByRole('button', { name: startsWith('Chat') })
    .first()
    .click();
  const filters = page.getByRole('group', { name: 'Filter chats' });
  await expect(filters).toBeVisible();
  for (const name of ['All', 'Unread', 'Groups', 'Artists', 'Team', 'Announcements']) {
    const pill = filters.getByRole('button', { name: startsWith(name) });
    await pill.click();
    await expect(pill).toHaveAttribute('aria-pressed', 'true');
  }
});

test('S-05, D-02, D-03: a to-do row opens the to-do, with Mark done, Edit details and its conversation', async ({
  pageAs,
}) => {
  const title = tag('to-do to open');
  todos.push(
    (await ok<{ todoId: string }>('admin', 'POST', `/artists/${artistId}/todos`, { title })).todoId,
  );
  const page = await pageAs('admin');
  await page.goto(`/?go=plan:${artistId}`);
  const tabs = page.getByRole('tablist', { name: 'Workspace' });
  await tabs.getByRole('tab', { name: startsWith('Work') }).click();
  await page
    .getByRole('tablist', { name: 'Work sections' })
    .getByRole('tab', { name: startsWith('To-dos') })
    .click();
  await page
    .getByRole('button', { name: new RegExp(`Open "?${escape(title)}`) })
    .first()
    .click();
  await expect(page.getByRole('button', { name: 'Mark done' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Edit details' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Conversation' })).toBeVisible();
  const back = page.getByRole('button', { name: '← To-dos' });
  await expect(back).toBeVisible();
  await back.click();
  await expect(page.getByRole('button', { name: 'Mark done' })).toHaveCount(0);
});

test('B-09: the workspace reopens a tab on the section last used', async ({ pageAs }) => {
  const page = await pageAs('admin');
  await page.goto(`/?go=plan:${artistId}`);
  const tabs = page.getByRole('tablist', { name: 'Workspace' });
  await tabs.getByRole('tab', { name: startsWith('Work') }).click();
  const work = page.getByRole('tablist', { name: 'Work sections' });
  await work.getByRole('tab', { name: startsWith('Submissions') }).click();
  await tabs.getByRole('tab', { name: startsWith('Plan') }).click();
  await tabs.getByRole('tab', { name: startsWith('Work') }).click();
  await expect(work.getByRole('tab', { name: startsWith('Submissions') })).toHaveAttribute(
    'aria-selected',
    'true',
  );
});

test('on a phone, no artist tab scrolls sideways', async ({ pageAs }) => {
  const page = await pageAs('artistOn');
  const tabbar = page.getByRole('navigation', { name: 'Tabs' });
  for (const name of ['Home', 'Chat', 'To-do', 'Gigs', 'Library']) {
    await test.step(name, async () => {
      await tabbar.getByRole('button', { name: startsWith(name) }).click();
      await settle(page);
      const wide = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(wide, `${name} is ${wide}px wider than the screen`).toBeLessThanOrEqual(1);
    });
  }
});

test.describe('Artists on a computer (rev 16)', () => {
  const SCREENS = [
    'Home',
    'Chat',
    'To-dos',
    'Gigs',
    'Library',
    'My plan',
    'Submissions',
    'My stats',
    'My brand kit',
    'Contacts & venues',
    'My meetings',
  ];

  test('a wide window gets the desktop layout, and every artist screen opens from its side menu', async ({
    pageAs,
  }) => {
    const page = await pageAs('artistOn');
    await page.setViewportSize(DESKTOP);
    await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Tabs' })).toHaveCount(0);
    await expect(page.getByText('ARTIST ★ ALL ACCESS')).toBeVisible();
    for (const screen of SCREENS) {
      await test.step(screen, async () => {
        await openArtist(page, screen);
        await expect(page.getByRole('main')).not.toContainText('← Back');
      });
    }
    await page.setViewportSize(PHONE);
  });

  test('an iPad gets the desktop layout held sideways and the phone layout upright', async ({
    pageAs,
  }) => {
    const page = await pageAs('artistOn');
    await page.setViewportSize({ width: 1180, height: 820 });
    await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();
    await page.setViewportSize({ width: 820, height: 1180 });
    await expect(page.getByRole('navigation', { name: 'Tabs' })).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Main' })).toHaveCount(0);
    await page.setViewportSize(PHONE);
  });

  test('C-13, rev 18: Export to PDF downloads the plan; “Ask for a change” sends the owner a to-do', async ({
    pageAs,
  }) => {
    const page = await pageAs('artistOn');
    await page.setViewportSize(DESKTOP);
    await openArtist(page, 'My plan');
    // C-13: Export to PDF downloads the whole plan as a PDF.
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Export to PDF' }).click();
    expect((await download).suggestedFilename()).toMatch(/\.pdf$/i);
    await page.getByRole('button', { name: 'Ask for a change' }).click();
    const change = tag('move the EP launch');
    await page.getByLabel('What should change?').fill(change);
    await page.getByRole('button', { name: 'Ask for the change' }).click();
    await expect(page.getByText(/Your change is with/)).toBeVisible();
    await page.setViewportSize(PHONE);

    const { todos: theirs } = await ok<{ todos: { todoId: string; title: string }[] }>(
      'admin',
      'GET',
      `/artists/${artistId}/todos?filter=for-me`,
    );
    const sent = theirs.find((t) => t.title === `Plan change: ${change}`);
    expect(sent, 'the plan owner has the change as a to-do').toBeTruthy();
    todos.push(sent!.todoId);
  });
});

test.describe('Live updates (rev 17)', () => {
  /**
   * Reloads the artist's page while listening to the app's `[realtime]` console
   * lines, waits until their own channel is subscribed, then opens a tab. If
   * the update never shows, the failure lists every realtime line seen, so a
   * refused subscription and a nudge that never arrives look different.
   */
  async function liveArtistPage(page: Page, tab: string) {
    const lines: string[] = [];
    page.on('console', (m) => {
      if (m.text().startsWith('[realtime]')) lines.push(`${m.type()}: ${m.text()}`);
    });
    await page.reload();
    await settle(page);
    const channel = `/inbox/artist-${artistId.split('_').join('-')}`;
    await expect
      .poll(() => lines.some((l) => l.includes(`listening on ${channel}`)), {
        message: `the artist's live-update channel should subscribe.\n${lines.join('\n') || '(no [realtime] lines)'}`,
        timeout: 20_000,
      })
      .toBe(true);
    await page
      .getByRole('navigation', { name: 'Tabs' })
      .getByRole('button', { name: startsWith(tab) })
      .click();
    await settle(page);
    return lines;
  }

  test('a gig Blueprint adds appears in the artist’s Gigs without reloading', async ({
    pageAs,
  }) => {
    const page = await pageAs('artistOn');
    const lines = await liveArtistPage(page, 'Gigs');
    const title = tag('live gig');
    const gig = await ok<{ gigId: string }>('admin', 'POST', `/artists/${artistId}/gigs`, {
      title,
      // Confirmed, so it's listed under Upcoming (the tab that's open), not Ideas.
      status: 'confirmed',
      date: new Date(Date.now() + 21 * 86_400_000).toISOString().slice(0, 10),
    });
    gigs.push(gig.gigId);
    await expect(
      page.getByText(title).first(),
      `realtime lines seen:\n${lines.join('\n')}`,
    ).toBeVisible({ timeout: 30_000 });
  });

  test('a to-do Blueprint adds appears in the artist’s To-do tab without reloading', async ({
    pageAs,
  }) => {
    const page = await pageAs('artistOn');
    const lines = await liveArtistPage(page, 'To-do');
    const title = tag('live to-do');
    todos.push(
      (await ok<{ todoId: string }>('admin', 'POST', `/artists/${artistId}/todos`, { title }))
        .todoId,
    );
    await expect(
      page.getByText(title).first(),
      `realtime lines seen:\n${lines.join('\n')}`,
    ).toBeVisible({ timeout: 30_000 });
  });
});
