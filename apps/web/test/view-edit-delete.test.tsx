// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DangerArea, EditDialog } from '../src/components/patterns.tsx';
import type { AppConfig } from '../src/lib/config.ts';
import { Events } from '../src/pages/Events.tsx';
import { Newsroom } from '../src/pages/Newsroom.tsx';

/**
 * Viewing, editing and deleting are separate steps everywhere: a row opens the
 * item, its fields change on an edit screen (here a dialog), and removing it is
 * only in the danger area at the bottom of that screen, which asks twice.
 */

const cfg: AppConfig = {
  clientId: 'test',
  region: 'ap-southeast-2',
  userPoolId: 'ap-southeast-2_test',
  apiBase: '/v1',
};

type Call = { method: string; url: string; body: unknown };
const calls: Call[] = [];
let routes: [RegExp, unknown][] = [];

beforeEach(() => {
  calls.length = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: { method: string; body?: string }) => {
      calls.push({ method: init.method, url, body: init.body ? JSON.parse(init.body) : undefined });
      const path = url.replace(/^\/v1/, '').split('?')[0]!;
      const hit = init.method === 'GET' ? routes.find(([re]) => re.test(path)) : undefined;
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify(hit ? hit[1] : { ok: true }),
      };
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const settle = () => act(async () => void (await new Promise((r) => setTimeout(r, 0))));
const sent = (method: string, re: RegExp) =>
  calls.filter((c) => c.method === method && re.test(c.url));

const EVENT = {
  eventId: 'evt000000001',
  name: 'Industry Mixer Night',
  date: '2027-02-12',
  startTime: '18:00',
  endTime: '23:00',
  venue: 'The Toff in Town',
  capacity: 200,
  ticketTarget: 150,
  ticketPriceCents: 2500,
  ticketsSold: 40,
  takingsCents: 0,
  compsTarget: 20,
  surveyAfter: true,
};
const eventDetail = {
  event: EVENT,
  guests: [
    { itemId: 'g1', name: 'Ana Booker', type: 'Booker', status: 'invited', fromOutreach: false },
  ],
  speakers: [{ itemId: 's1', name: 'Kyra', role: 'Host', status: 'confirmed' }],
  crew: [{ itemId: 'c1', role: 'Door', needed: 2, filled: 0, people: [] }],
  run: [{ itemId: 'r1', time: '18:00', item: 'Doors open', who: 'Door', notes: 'Wristbands' }],
  budget: [{ itemId: 'b1', item: 'Venue', budgetCents: 50000, spentCents: 0, inKind: false }],
  summary: {
    ticketsSold: 40,
    ticketTarget: 150,
    compsAccepted: 0,
    compsTarget: 20,
    inRoom: 40,
    capacity: 200,
    budgetCents: 50000,
    spentCents: 0,
    ticketIncomeCents: 100000,
    takingsCents: 0,
    profitCents: 0,
  },
};

describe('EditDialog (P4 for small items)', () => {
  function Harness({ onSave, onCancel }: { onSave: () => void; onCancel: () => void }) {
    const [v, setV] = useState('Door');
    return (
      <EditDialog
        title="Edit crew role"
        onSave={onSave}
        onCancel={onCancel}
        danger={
          <DangerArea title="Remove Door" action="Remove" onConfirm={async () => undefined} />
        }
      >
        <label>
          Role
          <input value={v} onChange={(e) => setV(e.target.value)} />
        </label>
      </EditDialog>
    );
  }

  it('saves on Enter, cancels on Escape, and keeps the danger area below Save', () => {
    const onSave = vi.fn();
    const onCancel = vi.fn();
    render(<Harness onSave={onSave} onCancel={onCancel} />);
    const dialog = screen.getByRole('dialog', { name: 'Edit crew role' });
    fireEvent.submit(within(dialog).getByRole('textbox', { name: 'Role' }).closest('form')!);
    expect(onSave).toHaveBeenCalledOnce();
    fireEvent.keyDown(within(dialog).getByRole('textbox', { name: 'Role' }), { key: 'Escape' });
    expect(onCancel).toHaveBeenCalledOnce();
    const form = dialog.querySelector('form[data-pattern="edit"]')!;
    const danger = dialog.querySelector('[data-pattern="danger"]')!;
    // The danger area comes after the form, never inside it.
    expect(form.contains(danger)).toBe(false);
    expect(form.compareDocumentPosition(danger) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

describe('an event: lines open to edit; removing is in the danger area', () => {
  beforeEach(() => {
    routes = [
      [/^\/events$/, { events: [EVENT] }],
      [/^\/events\/evt000000001$/, eventDetail],
    ];
  });

  it('has no remove buttons on the page', async () => {
    render(<Events cfg={cfg} token="t" openEventId="evt000000001" />);
    await settle();
    expect(screen.getAllByText('Ana Booker').length).toBeGreaterThan(0);
    expect(screen.queryAllByRole('button', { name: /^Remove$|^×$/ })).toEqual([]);
    expect(screen.queryAllByRole('button', { name: /notes for/i })).toEqual([]);
    // The run sheet's notes are still shown, read-only.
    expect(screen.getByText('Wristbands')).toBeTruthy();
  });

  it('opens a guest to edit it, and saves the changed fields', async () => {
    render(<Events cfg={cfg} token="t" openEventId="evt000000001" />);
    await settle();
    fireEvent.click(screen.getAllByRole('button', { name: /Ana Booker/ })[0]!);
    const dialog = screen.getByRole('dialog', { name: 'Edit guest' });
    fireEvent.change(within(dialog).getByLabelText('Type'), { target: { value: 'Promoter' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await settle();
    const [patch] = sent('PATCH', /\/events\/evt000000001\/guests\/g1$/);
    expect(patch?.body).toMatchObject({ name: 'Ana Booker', type: 'Promoter' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(sent('DELETE', /./)).toEqual([]);
  });

  it('removes a run sheet item only after asking twice', async () => {
    render(<Events cfg={cfg} token="t" openEventId="evt000000001" />);
    await settle();
    fireEvent.click(screen.getByRole('button', { name: 'Doors open' }));
    const dialog = screen.getByRole('dialog', { name: 'Edit run sheet item' });
    expect((within(dialog).getByLabelText('Notes') as HTMLTextAreaElement).value).toBe(
      'Wristbands',
    );
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove Doors open' }));
    expect(sent('DELETE', /./)).toEqual([]);
    fireEvent.click(
      within(dialog).getByRole('button', { name: 'Click again to remove: Remove Doors open' }),
    );
    await settle();
    expect(sent('DELETE', /\/events\/evt000000001\/run\/r1$/)).toHaveLength(1);
  });

  it('keeps quick status changes on the page (single actions, P3)', async () => {
    render(<Events cfg={cfg} token="t" openEventId="evt000000001" />);
    await settle();
    fireEvent.change(screen.getAllByRole('combobox', { name: 'Status for Ana Booker' })[0]!, {
      target: { value: 'accepted' },
    });
    await settle();
    expect(sent('PATCH', /\/guests\/g1$/)[0]?.body).toEqual({ status: 'accepted' });
  });
});

describe('Newsroom industry sites: open, edit, remove in the danger area', () => {
  const site = {
    siteId: 'site00000001',
    name: 'Music Victoria',
    url: 'https://musicvictoria.com.au/feed',
    kind: 'Industry body',
    mode: 'feed',
    enabled: true,
  };
  beforeEach(() => {
    routes = [
      [
        /^\/newsroom$/,
        {
          draft: null,
          past: [],
          settings: {
            include: { blueprint: true, artists: true, industry: true },
            lookFor: '',
            skip: '',
            storiesPerIssue: 3,
          },
          sites: [site],
          mailchimpConnected: false,
        },
      ],
    ];
  });

  it('has no remove button or switch on the row; the site opens to edit', async () => {
    render(<Newsroom cfg={cfg} token="t" isAdmin onReauth={() => undefined} />);
    await settle();
    expect(screen.queryAllByRole('button', { name: /Remove Music Victoria/ })).toEqual([]);
    expect(screen.queryAllByRole('checkbox', { name: 'Use Music Victoria' })).toEqual([]);
    fireEvent.click(screen.getAllByRole('button', { name: /Music Victoria/ })[0]!);
    const dialog = screen.getByRole('dialog', { name: 'Edit site' });
    fireEvent.click(within(dialog).getByRole('checkbox', { name: /Use this site/ }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await settle();
    expect(sent('PATCH', /\/newsroom\/sites\/site00000001$/)[0]?.body).toMatchObject({
      name: 'Music Victoria',
      enabled: false,
    });
  });

  it('removes a site after asking twice', async () => {
    render(<Newsroom cfg={cfg} token="t" isAdmin onReauth={() => undefined} />);
    await settle();
    fireEvent.click(screen.getAllByRole('button', { name: /Music Victoria/ })[0]!);
    const dialog = screen.getByRole('dialog', { name: 'Edit site' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove Music Victoria' }));
    fireEvent.click(
      within(dialog).getByRole('button', {
        name: 'Click again to remove: Remove Music Victoria',
      }),
    );
    await settle();
    expect(sent('DELETE', /\/newsroom\/sites\/site00000001$/)).toHaveLength(1);
  });

  it("staff can't open a site", async () => {
    render(<Newsroom cfg={cfg} token="t" isAdmin={false} onReauth={() => undefined} />);
    await settle();
    expect(screen.queryAllByRole('button', { name: /Music Victoria/ })).toEqual([]);
  });
});
