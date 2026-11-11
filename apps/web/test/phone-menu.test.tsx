// @vitest-environment jsdom
import axe from 'axe-core';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { BmgShell, type NavSection } from '../src/components/Shell.tsx';

afterEach(cleanup);
beforeAll(() => {
  window.matchMedia ??= ((q: string) => ({
    matches: false,
    media: q,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  })) as unknown as typeof window.matchMedia;
});

const sections: NavSection[] = [
  { items: [{ id: 'overview', label: 'Overview', icon: 'home' }] },
  {
    label: 'ARTIST WORKSPACES',
    items: [
      { id: 'gigs', label: 'Artist gigs', icon: 'mic', urgent: { waiting: 0, priority: 3 } },
      { id: 'templates', label: 'Plan templates', icon: 'template' },
    ],
  },
  {
    label: 'SHARED WITH ARTISTS',
    items: [
      { id: 'messages', label: 'Chat', icon: 'chat', urgent: { waiting: 2, priority: 1 } },
      { id: 'review', label: 'Review queue', icon: 'music', urgent: { waiting: 5, priority: 2 } },
      {
        id: 'todos',
        label: 'Tasks & to-dos',
        icon: 'todo',
        urgent: { waiting: 1, priority: 4 },
        alwaysOnTop: true,
      },
      { id: 'contacts', label: 'Contacts', icon: 'users', urgent: { waiting: 0, priority: 5 } },
      { id: 'library', label: 'Document library', icon: 'folder' },
    ],
  },
  { label: 'BMG ONLY', items: [{ id: 'events', label: 'Events', icon: 'calendar' }] },
];

function openMenu() {
  render(
    <BmgShell
      sections={sections}
      current="library"
      onNavigate={() => undefined}
      userName="Kyra Teichtahl"
      roleLabel="BMG admin"
      theme="light"
      onTheme={() => undefined}
      onSignOut={() => undefined}
      onProfile={() => undefined}
    >
      <p>Page</p>
    </BmgShell>,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Open menu' }));
  return screen.getByRole('dialog', { name: 'Menu' });
}

describe('Phone menu', () => {
  it('puts Overview first, then to-dos and the three most urgent items, most waiting first', () => {
    const menu = openMenu();
    const rows = within(menu)
      .getAllByRole('button')
      .map((b) => b.textContent);
    const top = rows.slice(
      rows.indexOf('Ask Blueprint AI⌘K') + 1,
      rows.indexOf('Ask Blueprint AI⌘K') + 7,
    );
    // Contacts is a fourth urgent candidate, so it stays folded.
    expect(top).toEqual([
      'Overview',
      'Review queue',
      'Chat',
      'Tasks & to-dos',
      'Artist gigs',
      'ARTIST WORKSPACES',
    ]);
    // Overview sits above the Needs attention label, with no heading of its own.
    const text = menu.textContent ?? '';
    expect(text.indexOf('Overview')).toBeLessThan(text.indexOf('NEEDS ATTENTION'));
    expect(within(menu).queryByRole('button', { name: /STUDIO HQ/ })).toBeNull();
  });

  it('folds everything else under headings that start collapsed', async () => {
    const menu = openMenu();
    for (const name of ['ARTIST WORKSPACES', 'SHARED WITH ARTISTS', 'BMG ONLY']) {
      expect(within(menu).getByRole('button', { name: new RegExp(name) })).toHaveProperty(
        'ariaExpanded',
        'false',
      );
    }
    expect(within(menu).queryByRole('button', { name: 'Events' })).toBeNull();
    // The heading holding the current page says so while it is folded.
    expect(within(menu).getByRole('button', { name: /SHARED WITH ARTISTS/ }).textContent).toContain(
      'current page is here',
    );

    fireEvent.click(within(menu).getByRole('button', { name: /BMG ONLY/ }));
    expect(within(menu).getByRole('button', { name: /BMG ONLY/ })).toHaveProperty(
      'ariaExpanded',
      'true',
    );
    expect(within(menu).getByRole('button', { name: 'Events' })).toBeTruthy();
    // Pinned items aren't repeated in their sections.
    fireEvent.click(within(menu).getByRole('button', { name: /SHARED WITH ARTISTS/ }));
    expect(within(menu).getAllByRole('button', { name: 'Chat' })).toHaveLength(1);

    const result = await axe.run(menu, { rules: { 'color-contrast': { enabled: false } } });
    expect(result.violations.map((v) => v.id)).toEqual([]);
  });

  it('collapses the headings again each time the menu opens', () => {
    const menu = openMenu();
    fireEvent.click(within(menu).getByRole('button', { name: /BMG ONLY/ }));
    fireEvent.click(within(menu).getByRole('button', { name: 'Close menu' }));
    fireEvent.click(screen.getByRole('button', { name: 'Open menu' }));
    const again = screen.getByRole('dialog', { name: 'Menu' });
    expect(within(again).getByRole('button', { name: /BMG ONLY/ })).toHaveProperty(
      'ariaExpanded',
      'false',
    );
  });
});
