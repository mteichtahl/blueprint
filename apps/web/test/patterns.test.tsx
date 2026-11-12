// @vitest-environment jsdom
import axe from 'axe-core';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BackLink,
  DangerArea,
  EditScreen,
  RecordPage,
  SectionSwitch,
  WorkPage,
} from '../src/components/patterns.tsx';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const a11y = async () => {
  const res = await axe.run(document.body, {
    runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] },
    rules: { 'color-contrast': { enabled: false } },
  });
  return res.violations.map((v) => v.id);
};

describe('Rev 13 patterns', () => {
  it('P8: Back names the page it goes to', () => {
    const onClick = vi.fn();
    render(<BackLink to="Gigs" onClick={onClick} />);
    fireEvent.click(screen.getByRole('button', { name: '← Gigs' }));
    expect(onClick).toHaveBeenCalled();
  });

  it('P2 says Edit, P3 says Edit details, and neither has Delete', async () => {
    render(
      <>
        <RecordPage
          kind="Contact"
          title="Sam Lee"
          back={{ to: 'Contacts', onClick: () => {} }}
          onEdit={() => {}}
        />
        <WorkPage
          kind="Gig"
          title="Corner Hotel"
          back={{ to: 'Gigs', onClick: () => {} }}
          onEdit={() => {}}
        />
        <RecordPage kind="Venue" title="Read only" back={{ to: 'Venues', onClick: () => {} }} />
      </>,
    );
    expect(screen.getByRole('button', { name: 'Edit' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Edit details' })).toBeTruthy();
    expect(screen.getAllByRole('button', { name: /^(Edit|Edit details)$/ })).toHaveLength(2);
    expect(screen.queryByRole('button', { name: /delete/i })).toBeNull();
    expect(await a11y()).toEqual([]);
  });

  it('P4: Enter saves, Escape cancels, and the danger area sits last', () => {
    const onSave = vi.fn();
    const onCancel = vi.fn();
    render(
      <EditScreen
        title="Edit contact"
        back={{ to: 'Sam Lee', onClick: onCancel }}
        onSave={onSave}
        onCancel={onCancel}
        danger={<DangerArea title="Delete this contact" onConfirm={async () => {}} />}
      >
        <input aria-label="Name" defaultValue="Sam" />
      </EditScreen>,
    );
    const name = screen.getByLabelText('Name');
    fireEvent.submit(name.closest('form')!);
    expect(onSave).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(name, { key: 'Escape' });
    expect(onCancel).toHaveBeenCalledTimes(1);
    const buttons = screen.getAllByRole('button').map((b) => b.textContent);
    expect(buttons.at(-1)).toBe('Delete');
  });

  it('P5: the first click asks, the second deletes, and the ask times out', async () => {
    vi.useFakeTimers();
    const onConfirm = vi.fn(async () => {});
    render(<DangerArea title="Delete this gig" onConfirm={onConfirm} />);
    fireEvent.click(screen.getByRole('button', { name: 'Delete this gig' }));
    expect(onConfirm).not.toHaveBeenCalled();
    expect(
      screen.getByRole('button', { name: 'Click again to delete: Delete this gig' }).textContent,
    ).toBe('Click again to delete');
    act(() => void vi.advanceTimersByTime(6100));
    expect(screen.getByRole('button', { name: 'Delete this gig' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Delete this gig' }));
    await act(async () => {
      fireEvent.click(
        screen.getByRole('button', { name: 'Click again to delete: Delete this gig' }),
      );
    });
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('P5: blocked shows the reason and places, and the button is off', () => {
    render(
      <DangerArea
        title="Delete this venue"
        blocked={{ reason: 'This venue is used by 2 gigs.', places: ['Gig: Launch', 'Gig: Tour'] }}
        onConfirm={async () => {}}
      />,
    );
    expect(screen.getByText('This venue is used by 2 gigs.')).toBeTruthy();
    expect(screen.getByText('Gig: Tour')).toBeTruthy();
    expect(
      (screen.getByRole('button', { name: 'Delete this venue' }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it('P9: the section switch is a tab list with one selected tab', async () => {
    const onChange = vi.fn();
    render(
      <SectionSwitch
        label="Plan sections"
        value="stages"
        onChange={onChange}
        options={[
          { id: 'outcome', label: 'Outcome' },
          { id: 'stages', label: 'Stages' },
        ]}
      />,
    );
    expect(screen.getByRole('tab', { name: 'Stages' }).getAttribute('aria-selected')).toBe('true');
    fireEvent.click(screen.getByRole('tab', { name: 'Outcome' }));
    expect(onChange).toHaveBeenCalledWith('outcome');
    expect(await a11y()).toEqual([]);
  });
});

/**
 * Guards for the patterns that a test can't see at runtime: the source must not
 * bring back the things rev 13 removed. KNOWN lists what's still being moved
 * over; each work package empties its part of it.
 */
describe('Rev 13 source guards', () => {
  const root = join(import.meta.dirname, '../src');
  const files = ['pages', 'components'].flatMap((d) =>
    readdirSync(join(root, d))
      .filter((f) => f.endsWith('.tsx'))
      .map((f) => `${d}/${f}`),
  );
  const KNOWN_BACK = new Set<string>();

  it('P8: no "← Back" or "Back to …" links (name the page instead)', () => {
    const offenders = files.filter(
      (f) => !KNOWN_BACK.has(f) && /←\s*Back\b|← Back to/.test(readFileSync(join(root, f), 'utf8')),
    );
    expect(offenders).toEqual([]);
  });

  it('P5: no home-made second-click buttons (use DangerArea)', () => {
    // Chat keeps WhatsApp's own conventions (docs/patterns.md). Connectors: follow-up.
    const allowed = new Set(['pages/Messages.tsx', 'pages/Connectors.tsx']);
    const offenders = files.filter(
      (f) =>
        !allowed.has(f) &&
        f !== 'components/patterns.tsx' &&
        /function ConfirmButton|Click again to/.test(readFileSync(join(root, f), 'utf8')),
    );
    expect(offenders).toEqual([]);
  });
});
