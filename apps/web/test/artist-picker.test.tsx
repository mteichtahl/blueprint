// @vitest-environment jsdom
import axe from 'axe-core';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { BmgShell, matchesWords, type NavSection } from '../src/components/Shell.tsx';

afterEach(cleanup);
beforeAll(() => {
  window.matchMedia ??= ((q: string) => ({
    matches: false,
    media: q,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  })) as unknown as typeof window.matchMedia;
});

const artist = (id: string, name: string, badge?: number) => ({
  id: `artist:${id}`,
  label: name,
  avatar: name,
  avatarArtistId: id,
  badge,
});

const sections: NavSection[] = [
  { items: [{ id: 'overview', label: 'Overview', icon: 'home' }] },
  {
    label: 'ARTIST WORKSPACES',
    picker: {
      label: 'Find an artist workspace',
      placeholder: 'Choose an artist',
      options: [
        artist('art_chloe', 'Chloe Poli', 2),
        artist('art_mia', 'Mia Ray'),
        artist('art_zoe', 'Zoë Hart', 1),
      ],
    },
    items: [{ id: 'gigs', label: 'Artist gigs', icon: 'mic' }],
  },
];

function shell(current = 'overview') {
  const went: string[] = [];
  render(
    <BmgShell
      sections={sections}
      current={current}
      onNavigate={(id) => went.push(id)}
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
  const nav = screen.getAllByRole('navigation', { name: 'Main' })[0]!;
  return { nav, went };
}

describe('Artist workspaces in the side menu', () => {
  it('is one dropdown, not a row per artist', () => {
    const { nav } = shell();
    expect(within(nav).queryByRole('button', { name: /Mia Ray/ })).toBeNull();
    const trigger = within(nav).getByRole('button', { name: /Choose an artist/ });
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    // Reviews waiting across all artists show on the closed dropdown.
    expect(trigger.textContent).toContain('3');
  });

  it('filters by name as you type, ignoring case and accents, and opens the pick', () => {
    const { nav, went } = shell();
    fireEvent.click(within(nav).getByRole('button', { name: /Choose an artist/ }));
    const box = within(nav).getByRole('combobox', { name: 'Find an artist workspace' });
    expect(document.activeElement).toBe(box);
    expect(within(nav).getAllByRole('option')).toHaveLength(3);
    fireEvent.change(box, { target: { value: 'zoe' } });
    const left = within(nav).getAllByRole('option');
    expect(left).toHaveLength(1);
    expect(left[0]!.textContent).toContain('Zoë Hart');
    fireEvent.click(within(nav).getByRole('option', { name: /Zoë Hart/ }));
    expect(went).toEqual(['artist:art_zoe']);
    expect(within(nav).queryByRole('combobox')).toBeNull();
  });

  it('works from the keyboard and says when nothing matches', () => {
    const { nav, went } = shell();
    fireEvent.click(within(nav).getByRole('button', { name: /Choose an artist/ }));
    const box = within(nav).getByRole('combobox');
    fireEvent.change(box, { target: { value: 'nobody' } });
    expect(within(nav).getByRole('status').textContent).toBe('No artist matches “nobody”.');
    fireEvent.change(box, { target: { value: '' } });
    fireEvent.keyDown(box, { key: 'ArrowDown' });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(went).toEqual(['artist:art_mia']);
    fireEvent.click(within(nav).getByRole('button', { name: /Choose an artist/ }));
    fireEvent.keyDown(within(nav).getByRole('combobox'), { key: 'Escape' });
    expect(within(nav).queryByRole('combobox')).toBeNull();
  });

  it('shows the open artist on the dropdown, and passes axe when open', async () => {
    const { nav } = shell('artist:art_chloe');
    const trigger = within(nav).getByRole('button', { name: /Chloe Poli/ });
    expect(trigger.getAttribute('aria-current')).toBe('page');
    fireEvent.click(trigger);
    expect(
      within(nav)
        .getByRole('option', { name: /Chloe Poli/ })
        .getAttribute('aria-selected'),
    ).toBe('true');
    const result = await axe.run(nav, { rules: { 'color-contrast': { enabled: false } } });
    expect(result.violations.map((v) => v.id)).toEqual([]);
  });

  it('matches every word typed', () => {
    expect(matchesWords('Chloe Poli', 'poli chl')).toBe(true);
    expect(matchesWords('Chloe Poli', 'chloe ray')).toBe(false);
  });
});
