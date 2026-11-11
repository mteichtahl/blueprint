// @vitest-environment jsdom
import axe from 'axe-core';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WhatsNew } from '../src/components/WhatsNew.tsx';
import {
  RELEASE,
  openWhatsNew,
  shouldShowWhatsNew,
  type BuildRelease,
} from '../src/lib/release.ts';

afterEach(cleanup);
beforeEach(() => window.localStorage.clear());

const beta: BuildRelease = {
  version: '1.1.0',
  label: 'beta-1.1.0',
  channel: 'beta',
  commit: 'abc1234',
  notes: [
    {
      version: '1.1.0',
      date: '2026-12-01',
      summary: 'Gig money gets easier.',
      groups: [
        { title: 'New', items: ['Takings by ticket type'] },
        { title: 'Fixed', items: ['Profit rounding'] },
      ],
    },
    { version: '1.0.0', summary: 'The first release.', groups: [] },
  ],
};

describe("What's new pop-up", () => {
  it('opens once per release with the summary and changes, then stays closed', async () => {
    render(<WhatsNew release={beta} />);
    const dialog = screen.getByRole('dialog', { name: "What's new in 1.1.0" });
    expect(dialog.textContent).toContain('beta-1.1.0');
    expect(dialog.textContent).toContain('Gig money gets easier.');
    expect(screen.getByText('Takings by ticket type')).toBeTruthy();
    expect(screen.getByText('Earlier releases')).toBeTruthy();
    const res = await axe.run(document.body, {
      runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] },
      rules: { 'color-contrast': { enabled: false } },
    });
    expect(res.violations.map((v) => v.id)).toEqual([]);

    fireEvent.click(screen.getByRole('button', { name: 'Got it' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(shouldShowWhatsNew(beta)).toBe(false);

    cleanup();
    render(<WhatsNew release={beta} />);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('shows again for the next release', () => {
    window.localStorage.setItem('bmg-seen-release', '1.0.0');
    expect(shouldShowWhatsNew(beta)).toBe(true);
  });

  it('reopens from the menu footer', () => {
    window.localStorage.setItem('bmg-seen-release', '1.1.0');
    render(<WhatsNew release={beta} />);
    expect(screen.queryByRole('dialog')).toBeNull();
    act(() => openWhatsNew());
    expect(screen.getByRole('dialog', { name: "What's new in 1.1.0" })).toBeTruthy();
  });

  it('stays hidden when the release has no notes', () => {
    const bare = { ...beta, notes: [] };
    render(<WhatsNew release={bare} />);
    act(() => openWhatsNew());
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('the build embeds this release from VERSION and CHANGELOG.md (dev label locally)', () => {
    expect(RELEASE.label).toBe(`dev-${RELEASE.version}`);
    expect(RELEASE.notes[0]?.version).toBe(RELEASE.version);
  });
});
