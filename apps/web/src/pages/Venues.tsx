import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../lib/api.ts';
import type { AppConfig } from '../lib/config.ts';
import {
  Button,
  Card,
  Chips,
  DataTable,
  Field,
  Notice,
  RowCard,
  Tag,
  TextArea,
  WaveLoader,
} from '../components/ui.tsx';
import { ContactPicker, type Contact } from './Contacts.tsx';
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
    name: venue?.name ?? initialName,
    capacity: venue ? String(venue.capacity || '') : '',
    backline: venue?.backline ?? false,
    website: venue?.website ?? '',
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
        <Field label="Venue name" value={f.name} onChange={set('name')} />
        <Field
          label="Capacity"
          inputMode="numeric"
          value={f.capacity}
          onChange={set('capacity')}
          placeholder="e.g. 350"
          {...(capOk ? {} : { hint: 'Numbers only' })}
        />
        <Field label="Address" value={f.address} onChange={set('address')} />
        <Field label="Suburb or city" value={f.suburb} onChange={set('suburb')} />
        <Field
          label="Website"
          type="url"
          value={f.website}
          onChange={set('website')}
          onBlur={lookNow}
          placeholder="https://"
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
          disabled={busy || !f.name.trim() || !capOk}
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

function ConfirmButton({ label, onConfirm }: { label: string; onConfirm: () => void }) {
  const [armed, setArmed] = useState(false);
  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={() => (armed ? onConfirm() : setArmed(true))}
      onBlur={() => setArmed(false)}
    >
      {armed ? 'Click again to confirm' : label}
    </Button>
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

  async function act(v: Venue, method: 'PATCH' | 'DELETE', done: string) {
    try {
      await api(
        cfg,
        token,
        method,
        `/venues/${v.venueId}`,
        method === 'PATCH' ? { archived: !v.archived } : undefined,
      );
      setOpen(null);
      setNote(done);
      await reload();
    } catch (e) {
      setActionError((e as Error).message);
    }
  }

  if (open) {
    const v = open === 'new' ? undefined : open;
    return (
      <Card
        title={v ? v.name : 'Add a venue'}
        action={
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setOpen(null);
              setEditing(false);
            }}
          >
            ← Venues
          </Button>
        }
      >
        {actionError && <Notice tone="error">{actionError}</Notice>}
        {v && !editing ? (
          <div className="flex flex-col gap-3">
            {v.logo && <VenueLogo cfg={cfg} token={token} venue={v} size={88} />}
            <div className="flex flex-wrap gap-1.5">
              <Tag tone="n">{v.capacity ? `Capacity ${v.capacity}` : 'Capacity not set'}</Tag>
              <Tag tone={v.backline ? 'c' : 's'}>Backline: {v.backline ? 'Yes' : 'No'}</Tag>
            </div>
            {(v.address || v.suburb) && (
              <p className="m-0">{[v.address, v.suburb].filter(Boolean).join(', ')}</p>
            )}
            {v.website && (
              <a href={v.website} target="_blank" rel="noreferrer">
                {v.website}
              </a>
            )}
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
            <div className="flex flex-wrap gap-2">
              {v.canEdit && (
                <Button variant="navy" size="sm" onClick={() => setEditing(true)}>
                  Edit
                </Button>
              )}
              {isBmg && (
                <>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() =>
                      void act(
                        v,
                        'PATCH',
                        v.archived ? `${v.name} restored.` : `${v.name} archived.`,
                      )
                    }
                  >
                    {v.archived ? 'Restore' : 'Archive'}
                  </Button>
                  <ConfirmButton
                    label="Delete"
                    onConfirm={() => void act(v, 'DELETE', `${v.name} removed.`)}
                  />
                </>
              )}
            </div>
          </div>
        ) : (
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
          cards={venueCards(venues, setOpen, (v) => (
            <VenueLogo cfg={cfg} token={token} venue={v} size={40} />
          ))}
        >
          <thead>
            <tr>
              <th scope="col">Venue</th>
              <th scope="col">Suburb</th>
              <th scope="col">Capacity</th>
              <th scope="col">Backline</th>
              <th scope="col">Manager</th>
              <th scope="col">Booker</th>
            </tr>
          </thead>
          <tbody>
            {venues.map((v) => (
              <tr key={v.venueId} className={v.archived ? 'opacity-60' : ''}>
                <td>
                  <span className="flex items-center gap-2.5">
                    <VenueLogo cfg={cfg} token={token} venue={v} size={32} />
                    <button
                      type="button"
                      className="font-bold underline"
                      onClick={() => setOpen(v)}
                    >
                      {v.name}
                    </button>
                  </span>
                </td>
                <td>{v.suburb || '—'}</td>
                <td>{v.capacity || '—'}</td>
                <td>{v.backline ? 'Yes' : 'No'}</td>
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
) {
  return venues.map((v) => (
    <RowCard
      key={v.venueId}
      lead={logo(v)}
      title={v.name}
      status={v.archived ? <Tag>Archived</Tag> : undefined}
      sub={[v.suburb, v.capacity ? `Capacity ${v.capacity}` : ''].filter(Boolean).join(' · ')}
      tags={
        <>
          {v.backline && <Tag tone="n">Backline</Tag>}
          {v.booker?.name && <span className="src">Booker: {v.booker.name}</span>}
          {!v.booker?.name && v.manager?.name && (
            <span className="src">Manager: {v.manager.name}</span>
          )}
        </>
      }
      onOpen={() => open(v)}
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
