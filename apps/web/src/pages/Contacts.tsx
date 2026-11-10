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
  QuickLink,
  RowCard,
  Tag,
  TextArea,
  WaveLoader,
} from '../components/ui.tsx';

/**
 * Contacts (rev 7): one shared list. Blueprint manages it (BMG desktop
 * "Contacts"); artists search it, pick from it and add to it, and can change
 * only what they added. Blueprint's notes never reach artists (the API drops them).
 */

export interface Contact {
  contactId: string;
  firstName: string;
  lastName: string;
  name: string;
  jobTitle: string;
  organisation: string;
  email: string;
  phone: string;
  linkedin: string;
  website: string;
  instagram: string;
  address: string;
  tags: string[];
  archived: boolean;
  addedByArtist: boolean;
  canEdit: boolean;
  bmgNotes?: string;
}

const EMPTY = {
  firstName: '',
  lastName: '',
  jobTitle: '',
  organisation: '',
  email: '',
  phone: '',
  linkedin: '',
  website: '',
  instagram: '',
  address: '',
  tags: [] as string[],
  bmgNotes: '',
};
export type ContactDraft = typeof EMPTY;

export function useContacts(
  cfg: AppConfig,
  token: string,
  q = '',
  tag = '',
  archived = false,
  enabled = true,
) {
  const [contacts, setContacts] = useState<Contact[] | null>(null);
  const [tags, setTags] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    if (!enabled) return;
    try {
      const params = new URLSearchParams({
        ...(q ? { q } : {}),
        ...(tag ? { tag } : {}),
        ...(archived ? { archived: 'true' } : {}),
      });
      const res = await api<{ contacts: Contact[]; tags: string[] }>(
        cfg,
        token,
        'GET',
        `/contacts${params.size ? `?${params}` : ''}`,
      );
      setContacts(res.contacts);
      setTags(res.tags);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [cfg, token, q, tag, archived, enabled]);
  useEffect(() => {
    const t = setTimeout(() => void load(), q ? 250 : 0);
    return () => clearTimeout(t);
  }, [load, q]);
  return { contacts, tags, error, reload: load };
}

/** The existing contact the API hands back when the email or phone is already in the list. */
const existingFrom = (e: unknown): Contact | undefined =>
  e instanceof ApiError && e.status === 409
    ? ((e.data as { existing?: Contact } | undefined)?.existing ?? undefined)
    : undefined;

/** Add or edit a contact. On a duplicate it offers the existing person instead. */
export function ContactForm({
  cfg,
  token,
  contact,
  isBmg,
  suggestedTags = [],
  initial,
  onSaved,
  onCancel,
  onUseExisting,
}: {
  cfg: AppConfig;
  token: string;
  contact?: Contact;
  isBmg: boolean;
  suggestedTags?: readonly string[];
  /** Pre-filled values for a new contact (e.g. the crew name being typed). */
  initial?: Partial<ContactDraft>;
  onSaved: (c: Contact) => void;
  onCancel: () => void;
  onUseExisting?: (c: Contact) => void;
}) {
  const [f, setF] = useState<ContactDraft>({
    ...EMPTY,
    ...initial,
    ...(contact
      ? {
          firstName: contact.firstName,
          lastName: contact.lastName,
          jobTitle: contact.jobTitle,
          organisation: contact.organisation,
          email: contact.email,
          phone: contact.phone,
          linkedin: contact.linkedin,
          website: contact.website,
          instagram: contact.instagram,
          address: contact.address,
          tags: contact.tags,
          bmgNotes: contact.bmgNotes ?? '',
        }
      : {}),
  });
  const [error, setError] = useState<string | null>(null);
  const [existing, setExisting] = useState<Contact | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof ContactDraft) => (e: { target: { value: string } }) =>
    setF({ ...f, [k]: e.target.value });
  const toggleTag = (t: string) =>
    setF({ ...f, tags: f.tags.includes(t) ? f.tags.filter((x) => x !== t) : [...f.tags, t] });

  async function save() {
    setBusy(true);
    setError(null);
    setExisting(null);
    const body = { ...f, ...(isBmg ? {} : { bmgNotes: undefined }) };
    try {
      const saved = contact
        ? await api<Contact>(cfg, token, 'PATCH', `/contacts/${contact.contactId}`, body)
        : await api<Contact>(cfg, token, 'POST', '/contacts', body);
      onSaved(saved);
    } catch (e) {
      const dup = existingFrom(e);
      if (dup) setExisting(dup);
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const tagChoices = [...new Set([...suggestedTags, ...f.tags])];
  return (
    <div className="flex flex-col gap-3">
      {error && <Notice tone="error">{error}</Notice>}
      {existing && onUseExisting && (
        <Button variant="navy" onClick={() => onUseExisting(existing)}>
          Use {existing.name} instead
        </Button>
      )}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="First name" value={f.firstName} onChange={set('firstName')} />
        <Field label="Last name" value={f.lastName} onChange={set('lastName')} />
        <Field
          label="Job title"
          value={f.jobTitle}
          onChange={set('jobTitle')}
          placeholder="Venue booker"
        />
        <Field label="Organisation" value={f.organisation} onChange={set('organisation')} />
        <Field label="Email" type="email" value={f.email} onChange={set('email')} />
        <Field label="Phone" type="tel" value={f.phone} onChange={set('phone')} />
        <Field
          label="LinkedIn"
          type="url"
          value={f.linkedin}
          onChange={set('linkedin')}
          placeholder="https://www.linkedin.com/in/…"
        />
        <Field
          label="Website"
          type="url"
          value={f.website}
          onChange={set('website')}
          placeholder="https://"
        />
        <Field
          label="Instagram"
          value={f.instagram}
          onChange={set('instagram')}
          placeholder="@handle"
        />
        <Field label="Address" value={f.address} onChange={set('address')} />
      </div>
      {tagChoices.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <span className="text-[15px] font-bold">Tags</span>
          <div className="flex flex-wrap gap-1.5" role="group" aria-label="Tags">
            {tagChoices.map((t) => (
              <button
                key={t}
                type="button"
                className="chip min-h-8"
                aria-pressed={f.tags.includes(t)}
                onClick={() => toggleTag(t)}
              >
                {t}
              </button>
            ))}
          </div>
        </div>
      )}
      {isBmg && (
        <TextArea
          label="Blueprint notes (artists never see these)"
          value={f.bmgNotes}
          onChange={set('bmgNotes')}
        />
      )}
      <div className="flex gap-2">
        <Button variant="cta" disabled={busy || !f.firstName.trim()} onClick={() => void save()}>
          {contact ? 'Save' : 'Add contact'}
        </Button>
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

/** Read-only view for a contact the caller can't edit. */
function ContactView({ c }: { c: Contact }) {
  const rows: [string, string][] = [
    ['Job title', c.jobTitle],
    ['Organisation', c.organisation],
    ['Email', c.email],
    ['Phone', c.phone],
    ['LinkedIn', c.linkedin],
    ['Website', c.website],
    ['Instagram', c.instagram],
    ['Address', c.address],
  ];
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-[15px]">
      {rows
        .filter(([, v]) => v)
        .map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="font-bold">{k}</dt>
            <dd className="m-0 break-all">
              {k === 'Email' ? (
                <a href={`mailto:${v}`}>{v}</a>
              ) : k === 'Phone' ? (
                <a href={`tel:${v.replace(/\s/g, '')}`}>{v}</a>
              ) : /^https?:/.test(v) ? (
                <a href={v} target="_blank" rel="noreferrer">
                  {v}
                </a>
              ) : (
                v
              )}
            </dd>
          </div>
        ))}
    </dl>
  );
}

/** Two clicks to remove, as elsewhere in the app. */
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

/**
 * The Contacts list: a table on BMG desktop, cards on the artist's phone.
 * Search, tag filters, add, and open a contact to view or edit it.
 */
export function Contacts({
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
  const [tag, setTag] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const { contacts, tags, error, reload } = useContacts(cfg, token, q, tag, showArchived);
  const [open, setOpen] = useState<Contact | 'new' | null>(null);
  const [editing, setEditing] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  async function archive(c: Contact, archived: boolean) {
    try {
      await api(cfg, token, 'PATCH', `/contacts/${c.contactId}`, { archived });
      setOpen(null);
      setNote(archived ? `${c.name} archived.` : `${c.name} restored.`);
      await reload();
    } catch (e) {
      setActionError((e as Error).message);
    }
  }
  async function remove(c: Contact) {
    try {
      await api(cfg, token, 'DELETE', `/contacts/${c.contactId}`);
      setOpen(null);
      setNote(`${c.name} removed.`);
      await reload();
    } catch (e) {
      setActionError((e as Error).message);
    }
  }

  const tagOptions = [{ id: '', label: 'All' }, ...tags.map((t) => ({ id: t, label: t }))];

  if (open) {
    const c = open === 'new' ? undefined : open;
    return (
      <Card
        title={c ? c.name : 'Add a contact'}
        action={
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setOpen(null);
              setEditing(false);
            }}
          >
            ← Contacts
          </Button>
        }
      >
        {actionError && <Notice tone="error">{actionError}</Notice>}
        {c && !editing ? (
          <div className="flex flex-col gap-3">
            {c.tags.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {c.tags.map((t) => (
                  <Tag key={t}>{t}</Tag>
                ))}
              </div>
            )}
            <ContactView c={c} />
            {isBmg && c.bmgNotes && (
              <Notice>
                <b>Blueprint notes:</b> {c.bmgNotes}
              </Notice>
            )}
            <div className="flex flex-wrap gap-2">
              {c.canEdit && (
                <Button variant="navy" size="sm" onClick={() => setEditing(true)}>
                  Edit
                </Button>
              )}
              {isBmg && (
                <>
                  <Button size="sm" variant="ghost" onClick={() => void archive(c, !c.archived)}>
                    {c.archived ? 'Restore' : 'Archive'}
                  </Button>
                  <ConfirmButton label="Delete" onConfirm={() => void remove(c)} />
                </>
              )}
            </div>
            {!c.canEdit && (
              <p className="src">Added by Blueprint. Ask Blueprint if something needs changing.</p>
            )}
          </div>
        ) : (
          <ContactForm
            cfg={cfg}
            token={token}
            {...(c ? { contact: c } : {})}
            isBmg={isBmg}
            suggestedTags={tags}
            onSaved={(saved) => {
              setEditing(false);
              setOpen(saved);
              setNote(c ? 'Saved.' : `${saved.name} added to contacts.`);
              void reload();
            }}
            onUseExisting={(existing) => {
              setEditing(false);
              setOpen(existing);
            }}
            onCancel={() => {
              setEditing(false);
              if (!c) setOpen(null);
            }}
          />
        )}
      </Card>
    );
  }

  return (
    <Card
      title="Contacts"
      action={
        <Button variant="cta" size="sm" onClick={() => setOpen('new')}>
          + Add contact
        </Button>
      }
    >
      {error && <Notice tone="error">{error}</Notice>}
      {note && <Notice tone="success">{note}</Notice>}
      <input
        className="min-h-11 w-full rounded-lg border border-input bg-white px-3 text-base shadow-xs"
        type="search"
        aria-label="Search contacts"
        placeholder="Search by name, organisation, email, phone or tag"
        value={q}
        onChange={(e) => setQ(e.target.value)}
      />
      <div className="flex flex-wrap items-center gap-2">
        <Chips label="Filter by tag" value={tag} onChange={setTag} options={tagOptions} />
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
      {contacts === null ? (
        <WaveLoader />
      ) : contacts.length === 0 ? (
        <p className="src">
          {q || tag ? 'No contacts match.' : 'No contacts yet. Add the first one.'}
        </p>
      ) : compact ? (
        <ul className="m-0 flex list-none flex-col gap-2 p-0" aria-label="Contacts">
          {contactCards(contacts, setOpen)}
        </ul>
      ) : (
        <DataTable label="Contacts" cards={contactCards(contacts, setOpen)}>
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">Role</th>
              <th scope="col">Email</th>
              <th scope="col">Phone</th>
              <th scope="col">Tags</th>
              <th scope="col">Added by</th>
            </tr>
          </thead>
          <tbody>
            {contacts.map((c) => (
              <tr key={c.contactId} className={c.archived ? 'opacity-60' : ''}>
                <td>
                  <button type="button" className="font-bold underline" onClick={() => setOpen(c)}>
                    {c.name}
                  </button>
                </td>
                <td>{[c.jobTitle, c.organisation].filter(Boolean).join(', ') || '—'}</td>
                <td>{c.email ? <a href={`mailto:${c.email}`}>{c.email}</a> : '—'}</td>
                <td>{c.phone || '—'}</td>
                <td>
                  <span className="flex flex-wrap gap-1">
                    {c.tags.map((t) => (
                      <Tag key={t}>{t}</Tag>
                    ))}
                  </span>
                </td>
                <td>{c.addedByArtist ? 'An artist' : 'Blueprint'}</td>
              </tr>
            ))}
          </tbody>
        </DataTable>
      )}
      <p className="src">
        {isBmg
          ? 'Shared with artists: they can pick and add contacts, and change only the ones they added. Your notes stay private.'
          : 'Shared by Blueprint. Pick contacts for your gigs and add new ones.'}
      </p>
    </Card>
  );
}

/** Contacts as phone cards: name and role, tags, and one-tap call and email. */
function contactCards(contacts: Contact[], open: (c: Contact) => void) {
  return contacts.map((c) => (
    <RowCard
      key={c.contactId}
      title={c.name}
      status={c.archived ? <Tag>Archived</Tag> : undefined}
      sub={[c.jobTitle, c.organisation].filter(Boolean).join(' · ') || c.email || c.phone}
      tags={
        c.tags.length > 0 ? (
          <>
            {c.tags.map((t) => (
              <Tag key={t}>{t}</Tag>
            ))}
          </>
        ) : undefined
      }
      actions={
        <>
          {c.phone && (
            <QuickLink
              href={`tel:${c.phone.replace(/[^\d+]/g, '')}`}
              label={`Call ${c.name}`}
              icon="phone"
            />
          )}
          {c.email && (
            <QuickLink href={`mailto:${c.email}`} label={`Email ${c.name}`} icon="mail" />
          )}
        </>
      }
      onOpen={() => open(c)}
    />
  ));
}

/**
 * Pick someone from the main contacts list, or add them on the spot.
 * Used wherever a person is needed: venue manager and booker, crew, gig contacts.
 */
export function ContactPicker({
  cfg,
  token,
  isBmg,
  label,
  value,
  onChange,
  defaultTags = [],
}: {
  cfg: AppConfig;
  token: string;
  isBmg: boolean;
  label: string;
  value: { contactId: string; name: string } | null;
  onChange: (c: Contact | null) => void;
  /** Tags given to a contact added from here, e.g. "Venue booker". */
  defaultTags?: string[];
}) {
  const [q, setQ] = useState('');
  const [openList, setOpenList] = useState(false);
  const [adding, setAdding] = useState(false);
  const { contacts, tags } = useContacts(cfg, token, q, '', false, openList || adding);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpenList(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);

  if (adding) {
    const [firstName, ...rest] = q.trim().split(/\s+/);
    return (
      <div className="flex flex-col gap-2 rounded-lg border border-input p-3">
        <span className="text-[15px] font-bold">{label}: new contact</span>
        <ContactForm
          cfg={cfg}
          token={token}
          isBmg={isBmg}
          suggestedTags={tags}
          initial={{ firstName: firstName ?? '', lastName: rest.join(' '), tags: defaultTags }}
          onSaved={(c) => {
            setAdding(false);
            setQ('');
            onChange(c);
          }}
          onUseExisting={(c) => {
            setAdding(false);
            setQ('');
            onChange(c);
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
          <button
            type="button"
            className="text-sm underline"
            aria-label={`Clear ${label}`}
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
          placeholder="Search contacts…"
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
          {(contacts ?? []).slice(0, 20).map((c) => (
            <li key={c.contactId}>
              <button
                type="button"
                role="option"
                aria-selected={false}
                className="flex w-full flex-col items-start rounded-md px-2.5 py-2 text-left hover:bg-secondary"
                onClick={() => {
                  onChange(c);
                  setOpenList(false);
                  setQ('');
                }}
              >
                <b>{c.name}</b>
                <span className="src">
                  {[c.jobTitle, c.organisation, c.email].filter(Boolean).join(' · ')}
                </span>
              </button>
            </li>
          ))}
          {contacts !== null && contacts.length === 0 && (
            <li className="src px-2.5 py-2">No one matches “{q}”.</li>
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
              + Add contact{q ? ` “${q}”` : ''}
            </button>
          </li>
        </ul>
      )}
    </div>
  );
}
