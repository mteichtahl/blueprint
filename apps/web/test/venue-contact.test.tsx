// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  ContactVenue,
  looksLikeUrl,
  VenueMapAndSite,
  venueContacts,
  type Venue,
  type VenuePerson,
} from '../src/pages/Venues.tsx';
import type { AppConfig } from '../src/lib/config.ts';

beforeAll(() => {
  window.matchMedia ??= ((q: string) => ({
    matches: false,
    media: q,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    onchange: null,
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
});
afterEach(cleanup);

const person = (id: string, name: string, more: Partial<VenuePerson> = {}): VenuePerson => ({
  contactId: id,
  name,
  jobTitle: '',
  email: '',
  phone: '',
  linkedin: '',
  ...more,
});
const venue = (more: Partial<Venue> = {}): Venue => ({
  venueId: 'v1',
  name: 'The Corner',
  capacity: 800,
  backline: true,
  website: '',
  address: '',
  suburb: '',
  contact: null,
  autoLogo: true,
  logo: null,
  archived: false,
  addedByArtist: false,
  canEdit: true,
  ...more,
});

describe('Contact venue', () => {
  it('goes straight to email or phone for the one venue contact', () => {
    render(
      <ContactVenue
        venue={venue({
          contact: person('c1', 'Bea Booker', { email: 'bea@corner.com', phone: '03 9000 0001' }),
        })}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /Contact venue/ }));
    expect(screen.getByText('Venue contact')).toBeTruthy();
    expect(screen.getByRole('link', { name: /Email bea@corner.com/ }).getAttribute('href')).toBe(
      'mailto:bea@corner.com?subject=Booking%20enquiry%3A%20The%20Corner',
    );
    expect(screen.getByRole('link', { name: /Call 03 9000 0001/ }).getAttribute('href')).toBe(
      'tel:0390000001',
    );
    expect(screen.queryByRole('button', { name: /Someone else/ })).toBeNull();
  });

  it('lists the venue contact once, only with a way to reach them', () => {
    const p = person('c1', 'Sam', { email: 's@x.com' });
    expect(venueContacts({ contact: p })).toEqual([{ role: 'Venue contact', p }]);
    expect(venueContacts({ contact: person('c2', 'No Details') })).toEqual([]);
    expect(venueContacts({ contact: null })).toEqual([]);
  });

  it('says so when no one can be reached', () => {
    render(<ContactVenue venue={venue({ contact: person('c1', 'No Details') })} />);
    fireEvent.click(screen.getByRole('button', { name: /Contact venue/ }));
    expect(screen.getByText(/has an email or phone number yet/)).toBeTruthy();
  });
});

describe('Map and website side by side', () => {
  const cfg = { apiUrl: 'https://api.test' } as unknown as AppConfig;
  it('shows two same-size panes, with a placeholder for a missing website', () => {
    render(
      <VenueMapAndSite
        cfg={cfg}
        token="t"
        venue={venue({ address: '57 Swan St', suburb: 'Richmond' })}
      />,
    );
    const grid = screen.getByTestId('venue-map-and-site');
    expect(grid.className).toMatch(/md:grid-cols-2/);
    expect(screen.getByTitle('Map of The Corner').className).toMatch(/h-80 w-full/);
    expect(screen.getByText('No website yet.')).toBeTruthy();
  });
});

describe('looksLikeUrl', () => {
  it('spots web addresses, not names or streets', () => {
    expect(looksLikeUrl('https://thecorner.com.au')).toBe(true);
    expect(looksLikeUrl('www.thetote.com.au/gigs')).toBe(true);
    expect(looksLikeUrl('The Corner Hotel')).toBe(false);
    expect(looksLikeUrl('57 Swan St.')).toBe(false);
  });
});
