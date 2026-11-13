import {
  BackLink,
  DangerArea,
  RecordPage,
  SelectBar,
  SelectBox,
  useSelect,
  type SelectState,
} from '../components/patterns.tsx';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../lib/api.ts';
import type { AppConfig } from '../lib/config.ts';
import {
  Button,
  Card,
  Chips,
  DataTable,
  Field,
  Icon,
  Notice,
  RowCard,
  Tag,
  TextArea,
  WaveLoader,
} from '../components/ui.tsx';
import { archiveActions, ContactPicker, type Contact } from './Contacts.tsx';
import { Dialog } from '../components/Folders.tsx';
import {
  LogoTile,
  lookupableUrl,
  primeLogo,
  toLogoDataUrl,
  VenueLogo,
  type VenueLogoRef,
} from '../components/VenueLogo.tsx';

/**
 * Venues (rev 7): name, capacity, backline (yes/no), website, address, and the
 * venue manager and booker, who are people in Contacts. Shared like contacts:
 * artists pick and add; Blueprint manages.
 */

export interface VenuePerson {
  contactId: string;
  name: string;
  jobTitle: string;
  email: string;
  phone: string;
  linkedin: string;
}
export interface Venue {
  venueId: string;
  name: string;
  capacity: number;
  backline: boolean;
  website: string;
  address: string;
  suburb: string;
  manager: VenuePerson | null;
  booker: VenuePerson | null;
  /** "Automatically get logo" from the website when none is uploaded (default on). */
  autoLogo: boolean;
  logo: VenueLogoRef | null;
  archived: boolean;
  addedByArtist: boolean;
  canEdit: boolean;
  bmgNotes?: string;
  /** Times booked: confirmed, booked or played gigs and Blueprint events at this venue. */
  bookings?: number;
}

/** "Booked 3 times" for the venue cards and details. */
export const bookedLabel = (n = 0) =>
  n === 0 ? 'Not booked yet' : `Booked ${n} ${n === 1 ? 'time' : 'times'}`;

/** A Google Maps search for the venue's address (also used for the embedded map). */
export function mapsQuery(v: Pick<Venue, 'name' | 'address' | 'suburb'>): string {
  const where = [v.address, v.suburb]
    .map((x) => x.trim())
    .filter(Boolean)
    .join(', ');
  return where ? `${v.name}, ${where}` : '';
}

/** What the API learnt from a venue's website (POST /venues/site-lookup). */
export interface SiteInfo {
  found: boolean;
  embeddable: boolean;
  url?: string;
  name?: string;
  address?: string;
  suburb?: string;
}

const siteInfoCache = new Map<string, Promise<SiteInfo>>();

/** Looks at a venue's website once per page load (shared by the form and the viewer). */
export function lookupSite(cfg: AppConfig, token: string, url: string): Promise<SiteInfo> {
  let p = siteInfoCache.get(url);
  if (!p) {
    p = api<SiteInfo>(cfg, token, 'POST', '/venues/site-lookup', { url });
    p.catch(() => siteInfoCache.delete(url));
    siteInfoCache.set(url, p);
  }
  return p;
}

/** Text that is plainly a web address ("https://…" or "www.…"), not a name or street. */
export const looksLikeUrl = (s: string) => /^(?:https?:\/\/|www\.)\S+\.\S+$/i.test(s.trim());

/** Map and website tiles share one size, side by side (stacked on a phone). */
const PANE = 'h-80 w-full rounded-xl border border-input';

function EmptyPane({ children }: { children: React.ReactNode }) {
  return (
    <div
      className={`${PANE} flex flex-col items-center justify-center gap-2 bg-muted/40 p-4 text-center`}
    >
      {children}
    </div>
  );
}

/** The venue's address on an embedded Google map, with a link to open it in Maps. */
export function VenueMap({ venue }: { venue: Pick<Venue, 'name' | 'address' | 'suburb'> }) {
  const q = mapsQuery(venue);
  if (!q) return null;
  const query = encodeURIComponent(q);
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <iframe
        title={`Map of ${venue.name}`}
        src={`https://www.google.com/maps?q=${query}&output=embed`}
        className={PANE}
        loading="lazy"
        referrerPolicy="no-referrer-when-downgrade"
        sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox"
      />
      <a
        className="self-start text-sm font-bold underline"
        href={`https://www.google.com/maps/search/?api=1&query=${query}`}
        target="_blank"
        rel="noreferrer"
      >
        Open in Google Maps
      </a>
    </div>
  );
}

/**
 * The venue's own website in a sandboxed frame. Many sites refuse to be shown
 * inside another app; the API checks first, and if so we say so and link out.
 */
export function VenueWebsite({
  cfg,
  token,
  venue,
}: {
  cfg: AppConfig;
  token: string;
  venue: Pick<Venue, 'name' | 'website'>;
}) {
  const url = lookupableUrl(venue.website);
  const [info, setInfo] = useState<SiteInfo | null>(null);
  useEffect(() => {
    setInfo(null);
    if (!url) return;
    let live = true;
    lookupSite(cfg, token, url)
      .then((r) => live && setInfo(r))
      .catch(() => live && setInfo({ found: false, embeddable: false }));
    return () => {
      live = false;
    };
  }, [cfg, token, url]);
  if (!url) return null;
  const host = new URL(url).hostname.replace(/^www\./, '');
  const open = (
    <a
      className="self-start text-sm font-bold underline"
      href={url}
      target="_blank"
      rel="noreferrer"
    >
      Open {host}
    </a>
  );
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      {info === null ? (
        <EmptyPane>
          <WaveLoader />
          <span className="src">Loading {host}…</span>
        </EmptyPane>
      ) : info.embeddable ? (
        <iframe
          title={`Website of ${venue.name}`}
          src={info.url ?? url}
          className={`${PANE} bg-white`}
          loading="lazy"
          referrerPolicy="no-referrer"
          sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-forms"
        />
      ) : (
        <EmptyPane>
          <b>{host}</b>
          <span className="src">
            {info.found
              ? "This website doesn't allow itself to be shown inside other apps."
              : "We couldn't reach this website just now."}
          </span>
          <a
            href={url}
            target="_blank"
            rel="noreferrer"
            className="inline-flex min-h-[38px] items-center rounded-full border-2 border-primary bg-primary px-3.5 font-title text-sm font-extrabold text-primary-foreground no-underline hover:opacity-90"
          >
            Open website
          </a>
        </EmptyPane>
      )}
      {open}
    </div>
  );
}

/** Map and website, side by side and the same size; a placeholder fills a missing one. */
export function VenueMapAndSite({
  cfg,
  token,
  venue,
}: {
  cfg: AppConfig;
  token: string;
  venue: Pick<Venue, 'name' | 'address' | 'suburb' | 'website'>;
}) {
  const hasMap = !!mapsQuery(venue);
  const hasSite = !!lookupableUrl(venue.website);
  if (!hasMap && !hasSite) return null;
  return (
    <div className="grid grid-cols-1 gap-3 md:grid-cols-2" data-testid="venue-map-and-site">
      {hasMap ? (
        <VenueMap venue={venue} />
      ) : (
        <EmptyPane>
          <span className="src">No address yet, so no map.</span>
        </EmptyPane>
      )}
      {hasSite ? (
        <VenueWebsite cfg={cfg} token={token} venue={venue} />
      ) : (
        <EmptyPane>
          <span className="src">No website yet.</span>
        </EmptyPane>
      )}
    </div>
  );
}

type Backline = '' | 'yes' | 'no';

export function useVenues(
  cfg: AppConfig,
  token: string,
  filter: { q?: string; backline?: Backline; minCapacity?: string; archived?: boolean } = {},
  enabled = true,
) {
  const [venues, setVenues] = useState<Venue[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { q = '', backline = '', minCapacity = '', archived = false } = filter;
  const load = useCallback(async () => {
    if (!enabled) return;
    try {
      const params = new URLSearchParams({
        ...(q ? { q } : {}),
        ...(backline ? { backline } : {}),
        ...(minCapacity ? { minCapacity } : {}),
        ...(archived ? { archived: 'true' } : {}),
      });
      const res = await api<{ venues: Venue[] }>(
        cfg,
        token,
        'GET',
        `/venues${params.size ? `?${params}` : ''}`,
      );
      setVenues(res.venues);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [cfg, token, q, backline, minCapacity, archived, enabled]);
  useEffect(() => {
    const t = setTimeout(() => void load(), q ? 250 : 0);
    return () => clearTimeout(t);
  }, [load, q]);
  return { venues, error, reload: load };
}

const existingVenue = (e: unknown): Venue | undefined =>
  e instanceof ApiError && e.status === 409
    ? (e.data as { existing?: Venue } | undefined)?.existing
    : undefined;

const personRef = (p: VenuePerson | Contact | null) =>
  p ? { contactId: p.contactId, name: p.name } : null;

/** Add or edit a venue; the manager and booker are picked from (or added to) Contacts. */
export function VenueForm({
  cfg,
  token,
  venue,
  isBmg,
  initialName = '',
  onSaved,
  onCancel,
  onUseExisting,
}: {
  cfg: AppConfig;
  token: string;
  venue?: Venue;
  isBmg: boolean;
  initialName?: string;
  onSaved: (v: Venue, warning?: string) => void;
  onCancel: () => void;
  onUseExisting?: (v: Venue) => void;
}) {
  const [f, setF] = useState({
    // Typed a web address into the venue picker? That's the website, not the name.
    name: venue?.name ?? (looksLikeUrl(initialName) ? '' : initialName),
    capacity: venue ? String(venue.capacity || '') : '',
    backline: venue?.backline ?? false,
    website: venue?.website ?? (looksLikeUrl(initialName) ? initialName.trim() : ''),
    address: venue?.address ?? '',
    suburb: venue?.suburb ?? '',
    bmgNotes: venue?.bmgNotes ?? '',
  });
  const [manager, setManager] = useState(personRef(venue?.manager ?? null));
  const [booker, setBooker] = useState(personRef(venue?.booker ?? null));
  const [error, setError] = useState<string | null>(null);
  const [existing, setExisting] = useState<Venue | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) =>
    setF({ ...f, [k]: e.target.value });

  // ── Address from the website ──
  // Paste the venue's website (or a web address into the name or address box)
  // and we look there for the street address and suburb. We only fill empty
  // boxes, or ones we filled ourselves; anything they typed is left alone.
  const [addrLooking, setAddrLooking] = useState(false);
  const [addrNote, setAddrNote] = useState<string | null>(null);
  const addrFilled = useRef<{ address: string; suburb: string; name: string } | null>(null);
  const addrFor = useRef<string | null>(lookupableUrl(venue?.website ?? ''));
  const addrRun = useRef(0);

  /** Typing into the name, address or suburb box; a web address goes to Website. */
  const typed = (k: 'name' | 'address' | 'suburb') => (e: { target: { value: string } }) => {
    const value = e.target.value;
    if (k !== 'suburb' && looksLikeUrl(value) && !f.website.trim()) {
      setF((cur) => ({ ...cur, [k]: '', website: value.trim() }));
      return;
    }
    setF((cur) => ({ ...cur, [k]: value }));
  };

  async function lookupAddress(url: string) {
    const run = ++addrRun.current;
    addrFor.current = url;
    setAddrLooking(true);
    setAddrNote(null);
    try {
      const res = await lookupSite(cfg, token, url);
      if (run !== addrRun.current) return;
      const found = res.found && !!res.address;
      setF((cur) => {
        const ours = addrFilled.current;
        const free = (k: 'address' | 'suburb' | 'name') =>
          !cur[k].trim() || (ours !== null && cur[k] === ours[k]);
        const next = { ...cur };
        if (found && free('address') && free('suburb')) {
          next.address = res.address ?? '';
          next.suburb = res.suburb ?? '';
        }
        if (res.name && free('name')) next.name = res.name;
        addrFilled.current = { address: next.address, suburb: next.suburb, name: next.name };
        return next;
      });
      setAddrNote(
        found
          ? "Address found on the venue's website. Check it's right."
          : "We couldn't find an address on that website. Type it in.",
      );
    } catch {
      if (run === addrRun.current) setAddrNote(null);
    } finally {
      if (run === addrRun.current) setAddrLooking(false);
    }
  }

  // Look a moment after they stop typing the website.
  useEffect(() => {
    const url = lookupableUrl(f.website);
    if (!url || url === addrFor.current) return;
    const t = setTimeout(() => void lookupAddress(url), 900);
    return () => clearTimeout(t);
  }, [f.website]);

  // ── Logo ──
  // 'saved': the venue's current logo, unchanged. 'new': a logo to save (uploaded
  // or found on the website), already shrunk. 'none': no logo.
  type LogoState =
    | { kind: 'saved' }
    | { kind: 'none' }
    | { kind: 'new'; dataUrl: string; source: 'upload' | 'website'; sourceUrl?: string };
  const [logo, setLogo] = useState<LogoState>(venue?.logo ? { kind: 'saved' } : { kind: 'none' });
  const [autoLogo, setAutoLogo] = useState(venue?.autoLogo ?? true);
  const [looking, setLooking] = useState(false);
  const [lookupNote, setLookupNote] = useState<string | null>(null);
  const lookedUpFor = useRef<string | null>(null);
  const lookupRun = useRef(0);
  const lookupPromise = useRef<Promise<void> | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const logoSource =
    logo.kind === 'new' ? logo.source : logo.kind === 'saved' ? venue?.logo?.source : undefined;
  const uploaded = logoSource === 'upload';
  const initialSite = lookupableUrl(venue?.website ?? '');

  function lookup(url: string) {
    const run = ++lookupRun.current;
    lookedUpFor.current = url;
    setLooking(true);
    setLookupNote(null);
    const p = (async () => {
      try {
        const res = await api<{ found: boolean; dataUrl?: string; sourceUrl?: string }>(
          cfg,
          token,
          'POST',
          '/venues/logo-lookup',
          { url },
        );
        const small = res.found && res.dataUrl ? await toLogoDataUrl(res.dataUrl) : null;
        if (run !== lookupRun.current) return;
        if (small) {
          setLogo({
            kind: 'new',
            dataUrl: small,
            source: 'website',
            ...(res.sourceUrl ? { sourceUrl: res.sourceUrl } : {}),
          });
        } else {
          // A logo from the old website no longer fits.
          setLogo((l) =>
            (l.kind === 'new' && l.source === 'website') ||
            (l.kind === 'saved' && venue?.logo?.source === 'website')
              ? { kind: 'none' }
              : l,
          );
          setLookupNote("We couldn't find a logo on that website. You can upload one.");
        }
      } catch {
        if (run === lookupRun.current)
          setLookupNote("We couldn't get a logo from that website. You can upload one.");
      } finally {
        if (run === lookupRun.current) {
          setLooking(false);
          lookupPromise.current = null;
        }
      }
    })();
    lookupPromise.current = p;
    return p;
  }

  /** Should we look at the website now? Only when auto is on and nothing was uploaded. */
  function wantLookup(): string | null {
    if (!autoLogo || uploaded) return null;
    const url = lookupableUrl(f.website);
    if (!url || url === lookedUpFor.current) return null;
    // Editing: the saved website logo still matches the saved website.
    if (logo.kind === 'saved' && url === initialSite) return null;
    return url;
  }

  // Look a moment after they stop typing the website (or when auto is switched on).
  useEffect(() => {
    const url = wantLookup();
    if (!url) return;
    const t = setTimeout(() => void lookup(url), 900);
    return () => clearTimeout(t);
  }, [f.website, autoLogo, uploaded]);

  function lookNow() {
    const url = wantLookup();
    if (url) void lookup(url);
  }

  async function pickFile(file: File | undefined) {
    if (!file) return;
    lookupRun.current++; // an upload wins over any lookup still running
    setLooking(false);
    setLookupNote(null);
    const objectUrl = URL.createObjectURL(file);
    try {
      setLogo({ kind: 'new', dataUrl: await toLogoDataUrl(objectUrl), source: 'upload' });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      URL.revokeObjectURL(objectUrl);
      if (fileInput.current) fileInput.current.value = '';
    }
  }

  function removeLogo() {
    lookupRun.current++;
    setLooking(false);
    // Don't go straight back to the website for the logo they just removed.
    lookedUpFor.current = lookupableUrl(f.website);
    setLogo({ kind: 'none' });
    setLookupNote(null);
  }

  function toggleAuto(on: boolean) {
    setAutoLogo(on);
    setLookupNote(null);
    if (!on) {
      lookupRun.current++;
      setLooking(false);
      lookedUpFor.current = null;
      if (logoSource === 'website') setLogo({ kind: 'none' });
    }
  }

  async function saveLogo(saved: Venue): Promise<{ venue: Venue; warning?: string }> {
    try {
      if (logo.kind === 'new') {
        const v = await api<Venue>(cfg, token, 'PUT', `/venues/${saved.venueId}/logo`, {
          dataUrl: logo.dataUrl,
          source: logo.source,
          ...(logo.sourceUrl ? { sourceUrl: logo.sourceUrl } : {}),
        });
        if (v.logo) primeLogo(v.venueId, v.logo.version, logo.dataUrl);
        return { venue: v };
      }
      if (logo.kind === 'none' && saved.logo)
        return { venue: await api<Venue>(cfg, token, 'DELETE', `/venues/${saved.venueId}/logo`) };
    } catch (e) {
      return {
        venue: saved,
        warning: `The venue was saved, but not its logo: ${(e as Error).message}`,
      };
    }
    return { venue: saved };
  }

  async function save() {
    setBusy(true);
    setError(null);
    setExisting(null);
    // If they save straight after typing the website, finish looking first.
    const url = wantLookup();
    if (url) await lookup(url);
    else if (lookupPromise.current) await lookupPromise.current;
    const body = {
      name: f.name,
      capacity: f.capacity ? Number(f.capacity) : 0,
      backline: f.backline,
      website: f.website,
      address: f.address,
      suburb: f.suburb,
      managerContactId: manager?.contactId ?? null,
      bookerContactId: booker?.contactId ?? null,
      autoLogo,
      ...(isBmg ? { bmgNotes: f.bmgNotes } : {}),
    };
    try {
      const saved = venue
        ? await api<Venue>(cfg, token, 'PATCH', `/venues/${venue.venueId}`, body)
        : await api<Venue>(cfg, token, 'POST', '/venues', body);
      const done = await saveLogo(saved);
      onSaved(done.venue, done.warning);
    } catch (e) {
      const dup = existingVenue(e);
      if (dup) setExisting(dup);
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const capOk = f.capacity === '' || /^\d+$/.test(f.capacity);
  return (
    <div className="flex flex-col gap-3">
      {error && <Notice tone="error">{error}</Notice>}
      {existing && onUseExisting && (
        <Button variant="navy" onClick={() => onUseExisting(existing)}>
          Use {existing.name} instead
        </Button>
      )}
      <div className="flex flex-col gap-2">
        <span className="text-[15px] font-bold">Logo</span>
        <div className="flex flex-wrap items-center gap-3">
          {logo.kind === 'saved' && venue && !looking ? (
            <VenueLogo cfg={cfg} token={token} venue={venue} size={72} />
          ) : (
            <LogoTile
              src={logo.kind === 'new' ? logo.dataUrl : null}
              name={f.name || 'Venue'}
              size={72}
              loading={looking}
              loadingLabel="Looking for a logo on the venue's website"
            />
          )}
          <div className="flex flex-col gap-1.5">
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="ghost" onClick={() => fileInput.current?.click()}>
                {logo.kind === 'none' ? 'Upload logo' : 'Replace logo'}
              </Button>
              {logo.kind !== 'none' && (
                <Button size="sm" variant="ghost" onClick={removeLogo}>
                  Remove
                </Button>
              )}
            </div>
            <span className="src" aria-live="polite">
              {looking
                ? "Looking for a logo on the venue's website…"
                : logoSource === 'website'
                  ? "Found on the venue's website. Not right? Upload one instead."
                  : (lookupNote ?? (uploaded ? 'Uploaded' : 'PNG, JPEG, WebP or SVG'))}
            </span>
          </div>
          <input
            ref={fileInput}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml"
            className="hidden"
            aria-label="Upload logo"
            onChange={(e) => void pickFile(e.target.files?.[0])}
          />
        </div>
        <label className="flex items-center gap-3">
          <input
            className="switch"
            type="checkbox"
            checked={autoLogo}
            onChange={(e) => toggleAuto(e.target.checked)}
          />
          <span className="flex-1">
            <b className="block">Automatically get logo</b>
            <span className="src">
              {uploaded
                ? 'Off while you use your own upload'
                : "If you don't upload one, we'll look on the venue's website"}
            </span>
          </span>
        </label>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field
          label="Venue name"
          value={f.name}
          onChange={typed('name')}
          placeholder="Name, or paste the venue's website"
        />
        <Field
          label="Capacity"
          inputMode="numeric"
          value={f.capacity}
          onChange={set('capacity')}
          placeholder="e.g. 350"
          {...(capOk ? {} : { hint: 'Numbers only' })}
        />
        <Field
          label="Address"
          value={f.address}
          onChange={typed('address')}
          disabled={addrLooking}
          placeholder={
            addrLooking ? "Looking on the venue's website…" : 'Street, or paste a website'
          }
        />
        <Field
          label="Suburb or city"
          value={f.suburb}
          onChange={typed('suburb')}
          disabled={addrLooking}
        />
        <Field
          label="Website"
          type="url"
          value={f.website}
          onChange={set('website')}
          onBlur={() => {
            lookNow();
            const url = lookupableUrl(f.website);
            if (url && url !== addrFor.current) void lookupAddress(url);
          }}
          placeholder="https://"
          {...(addrLooking
            ? { hint: "Looking for the address on the venue's website…" }
            : addrNote
              ? { hint: addrNote }
              : {})}
        />
        <fieldset className="m-0 flex flex-col gap-1.5 border-0 p-0">
          <legend className="mb-1.5 text-[15px] font-bold">Backline</legend>
          <div className="flex gap-2">
            {[
              [true, 'Yes'],
              [false, 'No'],
            ].map(([v, label]) => (
              <button
                key={String(label)}
                type="button"
                className="chip min-h-11 flex-1"
                aria-pressed={f.backline === v}
                onClick={() => setF({ ...f, backline: v as boolean })}
              >
                {label}
              </button>
            ))}
          </div>
        </fieldset>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <ContactPicker
          cfg={cfg}
          token={token}
          isBmg={isBmg}
          label="Venue manager"
          value={manager}
          onChange={(c) => setManager(personRef(c))}
          defaultTags={['Venue manager']}
        />
        <ContactPicker
          cfg={cfg}
          token={token}
          isBmg={isBmg}
          label="Venue booker"
          value={booker}
          onChange={(c) => setBooker(personRef(c))}
          defaultTags={['Venue booker']}
        />
      </div>
      {isBmg && (
        <TextArea
          label="Blueprint notes (artists never see these)"
          value={f.bmgNotes}
          onChange={set('bmgNotes')}
        />
      )}
      <div className="flex gap-2">
        <Button
          variant="cta"
          disabled={busy || addrLooking || !f.name.trim() || !capOk}
          onClick={() => void save()}
        >
          {busy ? 'Saving…' : venue ? 'Save' : 'Add venue'}
        </Button>
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

function Person({ role, p }: { role: string; p: VenuePerson | null }) {
  if (!p) return null;
  return (
    <div className="flex flex-col gap-0.5 rounded-lg border border-input p-3">
      <span className="eyebrow text-muted-foreground">{role}</span>
      <b>{p.name}</b>
      {p.jobTitle && <span className="src">{p.jobTitle}</span>}
      {p.email && <a href={`mailto:${p.email}`}>{p.email}</a>}
      {p.phone && <a href={`tel:${p.phone.replace(/\s/g, '')}`}>{p.phone}</a>}
      {p.linkedin && (
        <a href={p.linkedin} target="_blank" rel="noreferrer">
          LinkedIn
        </a>
      )}
    </div>
  );
}

/** Who at a venue can be reached: manager and booker, once each, with how. */
export function venueContacts(v: Pick<Venue, 'manager' | 'booker'>) {
  const out: { role: string; p: VenuePerson }[] = [];
  for (const [role, p] of [
    ['Venue booker', v.booker],
    ['Venue manager', v.manager],
  ] as const) {
    if (!p || (!p.email && !p.phone)) continue;
    const same = out.find((o) => o.p.contactId === p.contactId);
    if (same) same.role = 'Venue manager and booker';
    else out.push({ role, p });
  }
  return out;
}

const linkBtn =
  'inline-flex min-h-11 flex-1 items-center justify-center gap-1.5 rounded-full border-2 px-5 font-title text-[15px] font-extrabold no-underline transition';

/**
 * "Contact venue": pick who (booker or manager), then email or phone them.
 * With only one person, it goes straight to how.
 */
export function ContactVenue({ venue, onEdit }: { venue: Venue; onEdit?: () => void }) {
  const people = venueContacts(venue);
  const [open, setOpen] = useState(false);
  const [who, setWho] = useState<string | null>(null);
  const close = () => {
    setOpen(false);
    setWho(null);
  };
  const chosen = people.length === 1 ? people[0]! : people.find((o) => o.p.contactId === who);
  const subject = encodeURIComponent(`Booking enquiry: ${venue.name}`);
  return (
    <>
      <Button variant="cta" onClick={() => setOpen(true)}>
        <Icon name="phone" size={16} />
        Contact venue
      </Button>
      {open && (
        <Dialog
          title={`Contact ${venue.name}`}
          onClose={close}
          footer={
            <Button variant="ghost" onClick={close}>
              Close
            </Button>
          }
        >
          {people.length === 0 ? (
            <div className="flex flex-col gap-2">
              <p className="m-0">
                No one at {venue.name} has an email or phone number yet. Add a venue manager or
                booker with their details.
              </p>
              {onEdit && (
                <Button
                  variant="navy"
                  onClick={() => {
                    close();
                    onEdit();
                  }}
                >
                  Edit venue
                </Button>
              )}
            </div>
          ) : !chosen ? (
            <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
              <legend className="mb-1.5 text-[15px] font-bold">Who do you want to contact?</legend>
              {people.map(({ role, p }) => (
                <button
                  key={p.contactId}
                  type="button"
                  className="flex flex-col items-start gap-0.5 rounded-lg border border-input bg-card p-3 text-left hover:bg-[#F6F8FA] dark:hover:bg-secondary"
                  onClick={() => setWho(p.contactId)}
                >
                  <span className="eyebrow text-muted-foreground">{role}</span>
                  <b>{p.name}</b>
                  <span className="src">
                    {[p.email && 'Email', p.phone && 'Phone'].filter(Boolean).join(' or ')}
                  </span>
                </button>
              ))}
            </fieldset>
          ) : (
            <div className="flex flex-col gap-3">
              {people.length > 1 && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="self-start"
                  onClick={() => setWho(null)}
                >
                  ← Someone else
                </Button>
              )}
              <div className="flex flex-col gap-0.5">
                <span className="eyebrow text-muted-foreground">{chosen.role}</span>
                <b>{chosen.p.name}</b>
                {chosen.p.jobTitle && <span className="src">{chosen.p.jobTitle}</span>}
              </div>
              <p className="m-0 text-[15px] font-bold">How do you want to get in touch?</p>
              <div className="flex flex-wrap gap-2">
                {chosen.p.email && (
                  <a
                    className={`${linkBtn} border-primary bg-primary text-primary-foreground hover:opacity-90`}
                    href={`mailto:${chosen.p.email}?subject=${subject}`}
                    onClick={close}
                  >
                    <Icon name="mail" size={16} />
                    Email {chosen.p.email}
                  </a>
                )}
                {chosen.p.phone && (
                  <a
                    className={`${linkBtn} border-foreground bg-card text-foreground hover:bg-[#F6F8FA] dark:hover:bg-secondary`}
                    href={`tel:${chosen.p.phone.replace(/\s/g, '')}`}
                    onClick={close}
                  >
                    <Icon name="phone" size={16} />
                    Call {chosen.p.phone}
                  </a>
                )}
              </div>
            </div>
          )}
        </Dialog>
      )}
    </>
  );
}

/** The Venues list: table on desktop, cards on phone; filters by capacity and backline. */
export function Venues({
  cfg,
  token,
  isBmg,
  compact = false,
}: {
  cfg: AppConfig;
  token: string;
  isBmg: boolean;
  compact?: boolean;
}) {
  const [q, setQ] = useState('');
  const [backline, setBackline] = useState<Backline>('');
  const [minCapacity, setMinCapacity] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const { venues, error, reload } = useVenues(cfg, token, {
    q,
    backline,
    minCapacity,
    archived: showArchived,
  });
  const [open, setOpen] = useState<Venue | 'new' | null>(null);
  const [editing, setEditing] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  // Select mode (rev 13): Blueprint archives or restores several at once.
  const sel = useSelect();

  /** Archive or delete. Throws, so the danger area can show why it didn't work. */
  async function act(v: Venue, method: 'PATCH' | 'DELETE', done: string) {
    await api(
      cfg,
      token,
      method,
      `/venues/${v.venueId}`,
      method === 'PATCH' ? { archived: !v.archived } : undefined,
    );
    setOpen(null);
    setEditing(false);
    setNote(done);
    await reload();
  }

  if (open) {
    const v = open === 'new' ? undefined : open;
    const toList = () => {
      setOpen(null);
      setEditing(false);
    };
    // Rev 13: a venue is a record. Edit opens the edit screen, where Archive and
    // Delete sit in the danger area.
    if (v && !editing) {
      return (
        <RecordPage
          kind="Venue"
          title={v.name}
          sub={[v.address, v.suburb].filter(Boolean).join(', ') || undefined}
          lead={v.logo ? <VenueLogo cfg={cfg} token={token} venue={v} size={88} /> : undefined}
          badges={
            <>
              {v.archived && <Tag tone="c">Archived</Tag>}
              <Tag tone="n">{v.capacity ? `Capacity ${v.capacity}` : 'Capacity not set'}</Tag>
              <Tag tone={v.backline ? 'c' : 's'}>Backline: {v.backline ? 'Yes' : 'No'}</Tag>
              <Tag tone={v.bookings ? 'c' : 's'}>{bookedLabel(v.bookings)}</Tag>
            </>
          }
          back={{ to: 'Venues', onClick: toList }}
          primary={
            <ContactVenue venue={v} {...(v.canEdit ? { onEdit: () => setEditing(true) } : {})} />
          }
          onEdit={v.canEdit ? () => setEditing(true) : undefined}
        >
          {actionError && <Notice tone="error">{actionError}</Notice>}
          {note && <Notice tone="success">{note}</Notice>}
          <VenueMapAndSite cfg={cfg} token={token} venue={v} />
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <Person role="Venue manager" p={v.manager} />
            <Person role="Venue booker" p={v.booker} />
          </div>
          {!v.manager && !v.booker && <p className="src">No manager or booker yet.</p>}
          {isBmg && v.bmgNotes && (
            <Notice>
              <b>Blueprint notes:</b> {v.bmgNotes}
            </Notice>
          )}
        </RecordPage>
      );
    }
    return (
      <Card
        title={v ? 'Edit venue' : 'Add a venue'}
        action={
          <BackLink to={v ? v.name : 'Venues'} onClick={() => (v ? setEditing(false) : toList())} />
        }
      >
        {actionError && <Notice tone="error">{actionError}</Notice>}
        <VenueForm
          cfg={cfg}
          token={token}
          {...(v ? { venue: v } : {})}
          isBmg={isBmg}
          onSaved={(saved, warning) => {
            setEditing(false);
            setOpen(saved);
            setActionError(warning ?? null);
            setNote(v ? 'Saved.' : `${saved.name} added to venues.`);
            void reload();
          }}
          onUseExisting={(existing) => {
            setEditing(false);
            setOpen(existing);
          }}
          onCancel={() => {
            setEditing(false);
            if (!v) setOpen(null);
          }}
        />
        {v && isBmg && (
          <DangerArea
            title={`Delete ${v.name}`}
            what="Removed from the shared list for everyone. A venue with gigs or events can’t be deleted: archive it instead, which hides it from the venue picker."
            onConfirm={() => act(v, 'DELETE', `${v.name} removed.`)}
            extra={
              <Button
                type="button"
                variant="ghost"
                onClick={() =>
                  void act(
                    v,
                    'PATCH',
                    v.archived ? `${v.name} restored.` : `${v.name} archived.`,
                  ).catch((e: Error) => setActionError(e.message))
                }
              >
                {v.archived ? 'Restore' : 'Archive'}
              </Button>
            }
          />
        )}
      </Card>
    );
  }

  return (
    <Card
      title="Venues"
      action={
        <Button variant="cta" size="sm" onClick={() => setOpen('new')}>
          + Add venue
        </Button>
      }
    >
      {error && <Notice tone="error">{error}</Notice>}
      {note && <Notice tone="success">{note}</Notice>}
      <div className="flex flex-wrap items-end gap-2">
        <input
          className="min-h-11 min-w-0 flex-1 rounded-lg border border-input bg-white px-3 text-base shadow-xs"
          type="search"
          aria-label="Search venues"
          placeholder="Search by name or suburb"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <input
          className="min-h-11 w-36 rounded-lg border border-input bg-white px-3 text-base shadow-xs"
          inputMode="numeric"
          aria-label="Minimum capacity"
          placeholder="Min capacity"
          value={minCapacity}
          onChange={(e) => setMinCapacity(e.target.value.replace(/\D/g, ''))}
        />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Chips
          label="Backline"
          value={backline}
          onChange={setBackline}
          options={[
            { id: '', label: 'Any backline' },
            { id: 'yes', label: 'Backline: Yes' },
            { id: 'no', label: 'Backline: No' },
          ]}
        />
        {isBmg && (
          <label className="ml-auto flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              className="chk"
              checked={showArchived}
              onChange={(e) => setShowArchived(e.target.checked)}
            />
            Show archived
          </label>
        )}
      </div>
      {isBmg && !compact && venues && (
        <SelectBar
          sel={sel}
          all={venues.map((v) => v.venueId)}
          actions={archiveActions(
            cfg,
            token,
            venues.map((v) => ({ id: v.venueId, archived: v.archived })),
            (id) => `/venues/${id}`,
            ['venue', 'venues'],
          )}
          onDone={() => void reload()}
        />
      )}
      {venues === null ? (
        <WaveLoader />
      ) : venues.length === 0 ? (
        <p className="src">
          {q || backline || minCapacity ? 'No venues match.' : 'No venues yet. Add the first one.'}
        </p>
      ) : compact ? (
        <ul className="m-0 flex list-none flex-col gap-2 p-0" aria-label="Venues">
          {venueCards(venues, setOpen, (v) => (
            <VenueLogo cfg={cfg} token={token} venue={v} size={40} />
          ))}
        </ul>
      ) : (
        <DataTable
          label="Venues"
          cards={venueCards(
            venues,
            setOpen,
            (v) => (
              <VenueLogo cfg={cfg} token={token} venue={v} size={40} />
            ),
            sel,
          )}
        >
          <thead>
            <tr>
              {sel.on && (
                <th scope="col">
                  <span className="sr-only">Selected</span>
                </th>
              )}
              <th scope="col">Venue</th>
              <th scope="col">Suburb</th>
              <th scope="col">Capacity</th>
              <th scope="col">Backline</th>
              <th scope="col">Booked</th>
              <th scope="col">Manager</th>
              <th scope="col">Booker</th>
            </tr>
          </thead>
          <tbody>
            {venues.map((v) => (
              <tr
                key={v.venueId}
                className={`cursor-pointer ${v.archived ? 'opacity-60' : ''}`}
                onClick={() => (sel.on ? sel.toggle(v.venueId) : setOpen(v))}
              >
                {sel.on && (
                  <td className="w-10">
                    <SelectBox
                      label={v.name}
                      checked={sel.has(v.venueId)}
                      onChange={() => sel.toggle(v.venueId)}
                    />
                  </td>
                )}
                <td>
                  <span className="flex items-center gap-2.5">
                    <VenueLogo cfg={cfg} token={token} venue={v} size={32} />
                    <button type="button" className="font-bold" tabIndex={sel.on ? -1 : undefined}>
                      {v.name}
                    </button>
                  </span>
                </td>
                <td>{v.suburb || '—'}</td>
                <td>{v.capacity || '—'}</td>
                <td>{v.backline ? 'Yes' : 'No'}</td>
                <td>
                  <span className="bk-count" title={bookedLabel(v.bookings)}>
                    {v.bookings ?? 0}
                  </span>
                </td>
                <td>{v.manager?.name ?? '—'}</td>
                <td>{v.booker?.name ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </DataTable>
      )}
    </Card>
  );
}

/** Venues as phone cards: name, suburb and capacity, backline, who to talk to. */
function venueCards(
  venues: Venue[],
  open: (v: Venue) => void,
  logo: (v: Venue) => React.ReactNode,
  select?: SelectState,
) {
  const selecting = !!select?.on;
  return venues.map((v) => (
    <RowCard
      key={v.venueId}
      lead={
        selecting ? (
          <SelectBox
            label={v.name}
            checked={select!.has(v.venueId)}
            onChange={() => select!.toggle(v.venueId)}
          />
        ) : (
          logo(v)
        )
      }
      title={v.name}
      status={v.archived ? <Tag>Archived</Tag> : undefined}
      sub={[v.suburb, v.capacity ? `Capacity ${v.capacity}` : ''].filter(Boolean).join(' · ')}
      tags={
        <>
          <span className="bk-count" title={bookedLabel(v.bookings)}>
            <Icon name="calendar" size={14} />
            <span aria-hidden="true">{v.bookings ?? 0}</span>
            <span className="sr-only">{bookedLabel(v.bookings)}</span>
          </span>
          {v.backline && <Tag tone="n">Backline</Tag>}
          {v.booker?.name && <span className="src">Booker: {v.booker.name}</span>}
          {!v.booker?.name && v.manager?.name && (
            <span className="src">Manager: {v.manager.name}</span>
          )}
        </>
      }
      onOpen={() => (selecting ? select!.toggle(v.venueId) : open(v))}
    />
  ));
}

/** Pick a venue from the main list, or add it on the spot (gigs and events). */
export function VenuePicker({
  cfg,
  token,
  isBmg,
  label = 'Venue',
  value,
  onChange,
}: {
  cfg: AppConfig;
  token: string;
  isBmg: boolean;
  label?: string;
  value: { venueId: string | null; name: string } | null;
  onChange: (v: { venueId: string | null; name: string } | null) => void;
}) {
  const [q, setQ] = useState('');
  const [openList, setOpenList] = useState(false);
  const [adding, setAdding] = useState(false);
  const { venues } = useVenues(cfg, token, { q }, openList);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpenList(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);

  if (adding) {
    return (
      <div className="flex flex-col gap-2 rounded-lg border border-input p-3 sm:col-span-2">
        <span className="text-[15px] font-bold">New venue</span>
        <VenueForm
          cfg={cfg}
          token={token}
          isBmg={isBmg}
          initialName={q}
          onSaved={(v) => {
            setAdding(false);
            setQ('');
            onChange({ venueId: v.venueId, name: v.name });
          }}
          onUseExisting={(v) => {
            setAdding(false);
            setQ('');
            onChange({ venueId: v.venueId, name: v.name });
          }}
          onCancel={() => setAdding(false)}
        />
      </div>
    );
  }

  return (
    <div className="relative flex flex-col gap-1.5" ref={box}>
      <span className="text-[15px] font-bold">{label}</span>
      {value ? (
        <div className="flex min-h-11 items-center gap-2 rounded-lg border border-input bg-white px-3">
          <span className="flex-1 font-bold">{value.name}</span>
          {!value.venueId && <span className="src">not in venues</span>}
          <button
            type="button"
            className="text-sm underline"
            aria-label={`Change ${label}`}
            onClick={() => onChange(null)}
          >
            Change
          </button>
        </div>
      ) : (
        <input
          className="min-h-11 w-full rounded-lg border border-input bg-white px-3 text-base shadow-xs"
          type="search"
          role="combobox"
          aria-expanded={openList}
          aria-label={label}
          placeholder="Search venues…"
          value={q}
          onFocus={() => setOpenList(true)}
          onChange={(e) => {
            setQ(e.target.value);
            setOpenList(true);
          }}
        />
      )}
      {openList && !value && (
        <ul
          role="listbox"
          className="absolute top-full z-20 m-0 mt-1 flex max-h-72 w-full list-none flex-col overflow-auto rounded-lg border border-input bg-card p-1 shadow-md"
        >
          {(venues ?? []).slice(0, 20).map((v) => (
            <li key={v.venueId}>
              <button
                type="button"
                role="option"
                aria-selected={false}
                className="flex w-full flex-col items-start rounded-md px-2.5 py-2 text-left hover:bg-secondary"
                onClick={() => {
                  onChange({ venueId: v.venueId, name: v.name });
                  setOpenList(false);
                  setQ('');
                }}
              >
                <b>{v.name}</b>
                <span className="src">
                  {[v.suburb, v.capacity ? `cap. ${v.capacity}` : '', v.backline ? 'backline' : '']
                    .filter(Boolean)
                    .join(' · ')}
                </span>
              </button>
            </li>
          ))}
          {venues !== null && venues.length === 0 && (
            <li className="src px-2.5 py-2">No venue matches “{q}”.</li>
          )}
          <li>
            <button
              type="button"
              className="w-full rounded-md px-2.5 py-2 text-left font-bold text-cta hover:bg-secondary"
              onClick={() => {
                setAdding(true);
                setOpenList(false);
              }}
            >
              + Add venue{q ? ` “${q}”` : ''}
            </button>
          </li>
        </ul>
      )}
    </div>
  );
}
