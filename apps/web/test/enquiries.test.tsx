// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SearchSelect } from '../src/components/SearchSelect.tsx';
import { browserCountry, checkPhone, COUNTRIES, searchCountries } from '../src/lib/countries.ts';
import {
  activityLine,
  businessDaysWaiting,
  enquiriesCsv,
  filterEnquiries,
  waitingTooLong,
  type EnquirySummary,
} from '../src/lib/enquiries.ts';
import { checkConsult, Consult, type ConsultFields } from '../src/pages/Consult.tsx';

/** Consultation requests (rev 21): the public form and the team's list. */

afterEach(cleanup);

describe('countries', () => {
  it('lists every country and territory once, A to Z', () => {
    expect(COUNTRIES).toHaveLength(250);
    expect(new Set(COUNTRIES.map((c) => c.code)).size).toBe(250);
    const names = COUNTRIES.map((c) => c.name);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b, 'en')));
    expect(COUNTRIES.find((c) => c.code === 'AU')).toEqual({
      code: 'AU',
      name: 'Australia',
      dial: '+61',
    });
  });

  it('finds by name start, any word, code, calling code, and ignores accents', () => {
    expect(searchCountries('aus')[0]!.code).toBe('AU');
    expect(searchCountries('zealand')[0]!.code).toBe('NZ');
    expect(searchCountries('GB').map((c) => c.code)).toContain('GB');
    expect(searchCountries('+64').map((c) => c.code)).toContain('NZ');
    expect(searchCountries('cote').map((c) => c.code)).toContain('CI');
    expect(searchCountries('qqqq')).toEqual([]);
  });

  it('starts on the browser’s country, or Australia', () => {
    expect(browserCountry(['en-NZ', 'en'])).toBe('NZ');
    expect(browserCountry(['en'])).toBe('AU');
  });

  it('turns a typed mobile into an international number for the chosen country', () => {
    expect(checkPhone('0412 345 678', 'AU')).toEqual({ e164: '+61412345678' });
    expect(checkPhone('+44 7700 900123', 'AU')).toEqual({ e164: '+447700900123' });
    expect(checkPhone('12', 'AU').error).toBe('Check your mobile number.');
    expect(checkPhone('  ', 'AU')).toEqual({});
  });
});

describe('the form’s checks', () => {
  const ok: ConsultFields = {
    name: 'Mia Torres',
    email: 'mia@example.com',
    country: 'AU',
    phone: '',
    phoneCountry: 'AU',
    aboutMe: 'Hi',
    howCanWeHelp: 'An EP',
  };
  it('passes a filled-in form', () => {
    expect(checkConsult(ok)).toEqual({ errors: {} });
  });
  it('names each problem in words', () => {
    expect(
      checkConsult({ ...ok, name: 'M', email: 'nope', country: 'XX', aboutMe: '', phone: '1' })
        .errors,
    ).toEqual({
      name: 'Add your name.',
      email: 'Add an email we can reply to.',
      country: 'Choose your country.',
      phone: 'Check your mobile number.',
      aboutMe: 'Tell us a little about yourself.',
    });
  });
});

describe('the searchable drop-down', () => {
  it('opens, filters as you type, and picks with the keyboard', () => {
    const picked: string[] = [];
    render(
      <SearchSelect
        label="Country"
        value="AU"
        options={COUNTRIES.map((c) => ({ id: c.code, label: c.name }))}
        search={(q) => searchCountries(q).map((c) => ({ id: c.code, label: c.name }))}
        onChange={(id) => picked.push(id)}
      />,
    );
    const trigger = screen.getByRole('button', { name: /Country Australia/ });
    fireEvent.click(trigger);
    const box = screen.getByRole('combobox', { name: 'Search country' });
    fireEvent.change(box, { target: { value: 'new z' } });
    expect(screen.getAllByRole('option')[0]!.textContent).toContain('New Zealand');
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(picked).toEqual(['NZ']);
    expect(screen.queryByRole('listbox')).toBeNull();
  });
});

describe('the team’s list', () => {
  const now = new Date('2026-11-23T01:00:00Z');
  const e = (over: Partial<EnquirySummary>): EnquirySummary => ({
    enquiryId: 'e',
    status: 'open',
    name: 'Mia',
    email: 'mia@example.com',
    country: 'AU',
    countryName: 'Australia',
    receivedAt: '2026-11-22T00:00:00Z',
    updatedAt: '2026-11-22T00:00:00Z',
    resends: 0,
    ...over,
  });
  const list = [
    e({ enquiryId: 'new', receivedAt: '2026-11-22T00:00:00Z' }),
    e({ enquiryId: 'old', receivedAt: '2026-11-16T00:00:00Z' }),
    e({ enquiryId: 'mine', status: 'in-progress', ownerSub: 'me' }),
    e({ enquiryId: 'theirs', status: 'in-progress', ownerSub: 'sam' }),
    e({ enquiryId: 'spam', status: 'closed', closedReason: 'spam' }),
    e({ enquiryId: 'nope', status: 'closed', closedReason: 'not-a-fit', name: 'Jordan' }),
  ];
  const ids = (xs: EnquirySummary[]) => xs.map((x) => x.enquiryId);

  it('Open is oldest first; Mine is yours in progress; spam only under Closed', () => {
    expect(ids(filterEnquiries(list, 'open', 'me'))).toEqual(['old', 'new']);
    expect(ids(filterEnquiries(list, 'mine', 'me'))).toEqual(['mine']);
    expect(ids(filterEnquiries(list, 'all', 'me'))).not.toContain('spam');
    expect(ids(filterEnquiries(list, 'closed', 'me')).sort()).toEqual(['nope', 'spam']);
    expect(ids(filterEnquiries(list, 'all', 'me', 'jord'))).toEqual(['nope']);
  });

  it('flags a request open for more than two business days', () => {
    expect(businessDaysWaiting('2026-11-16T00:00:00Z', now)).toBe(5);
    expect(waitingTooLong(list[1]!, now)).toBe(true);
    expect(waitingTooLong(list[0]!, now)).toBe(false);
  });

  it('exports a CSV a spreadsheet can’t run as a formula', () => {
    const csv = enquiriesCsv([e({ name: '=HYPERLINK("x")', email: 'a@b.co' })]);
    expect(csv.split('\n')[1]).toBe(
      `"'=HYPERLINK(""x"")",a@b.co,Australia,Open,2026-11-22T00:00:00Z,,`,
    );
  });

  it('words what happened', () => {
    expect(
      activityLine({ actId: 'a', kind: 'takenOver', at: '', byName: 'Kyra', fromName: 'Sam' }),
    ).toBe('Kyra took it over from Sam');
    expect(
      activityLine({ actId: 'a', kind: 'closed', at: '', byName: 'Sam', reason: 'spam' }),
    ).toBe('Sam closed it: Spam');
  });
});

describe('the public form', () => {
  const sent: { url: string; body: Record<string, unknown> }[] = [];
  let answer: { status: number; body: unknown } = { status: 200, body: { ok: true } };
  let solve: (() => void) | undefined;
  beforeEach(() => {
    sent.length = 0;
    answer = { status: 200, body: { ok: true, firstName: 'Mia' } };
    window.history.replaceState({}, '', '/consult');
    Object.defineProperty(navigator, 'languages', { value: ['en-AU'], configurable: true });
    window.scrollTo = () => undefined;
    // The AWS WAF CAPTCHA script: its puzzle and its fetch, which adds the token.
    const w = window as unknown as Record<string, unknown>;
    w.AwsWafCaptcha = {
      renderCaptcha: (_el: HTMLElement, o: { onSuccess: (t: string) => void }) => {
        solve = () => o.onSuccess('token');
      },
    };
    w.AwsWafIntegration = {
      fetch: async (url: string, init: RequestInit) => {
        sent.push({ url, body: JSON.parse(String(init.body)) });
        return new Response(JSON.stringify(answer.body), { status: answer.status });
      },
    };
  });

  const fill = () => {
    fireEvent.change(screen.getByLabelText('Your name'), { target: { value: 'Mia Torres' } });
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'mia@example.com' } });
    fireEvent.change(screen.getByLabelText(/^Mobile/), { target: { value: '0412 345 678' } });
    fireEvent.change(screen.getByLabelText('Tell us about yourself'), {
      target: { value: 'Singer-songwriter.' },
    });
    fireEvent.change(screen.getByLabelText('How can BMG help?'), {
      target: { value: 'My first EP.' },
    });
  };
  const cfg = { captcha: { scriptUrl: 'https://x.awswaf.com/x/jsapi.js', apiKey: 'k'.repeat(30) } };

  it('can’t send until the CAPTCHA is set up for the site', async () => {
    render(<Consult cfg={{}} />);
    expect(screen.getByText(/isn’t taking requests just yet/)).toBeTruthy();
    expect(
      (screen.getByRole('button', { name: 'Send request' }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it('asks for the check first, then sends and says thanks', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(<Consult cfg={cfg} />);
    await act(async () => undefined);
    fill();
    fireEvent.click(screen.getByRole('button', { name: 'Send request' }));
    expect(screen.getByText('Do the quick check first.')).toBeTruthy();
    expect(sent).toHaveLength(0);
    act(() => solve!());
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Send request' }));
    });
    expect(sent[0]!.url).toBe('/public/enquiries');
    expect(sent[0]!.body).toMatchObject({
      name: 'Mia Torres',
      country: 'AU',
      phone: '+61412345678',
      aboutMe: 'Singer-songwriter.',
    });
    expect(sent[0]!.body).not.toHaveProperty('website');
    expect(screen.getByRole('heading', { name: 'Thanks, Mia' })).toBeTruthy();
    expect(window.location.pathname).toBe('/consult/thanks');
    vi.useRealTimers();
  });

  it('shows the puzzle again when the WAF wants a new one', async () => {
    render(<Consult cfg={cfg} />);
    await act(async () => undefined);
    fill();
    act(() => solve!());
    answer = { status: 405, body: {} };
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Send request' }));
    });
    expect(screen.getByText('Do the quick check again, then send.')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Book a consultation' })).toBeTruthy();
  });

  it('puts the field errors under each field and focuses the first', async () => {
    render(<Consult cfg={cfg} />);
    await act(async () => undefined);
    fireEvent.click(screen.getByRole('button', { name: 'Send request' }));
    expect(screen.getByText('Add your name.')).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByLabelText('Your name'));
    expect(screen.getByLabelText('Your name').getAttribute('aria-describedby')).toBe('name-error');
  });
});
