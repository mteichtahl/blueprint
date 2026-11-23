import { useCallback, useEffect, useState } from 'react';
import {
  DangerArea,
  EditScreen,
  SectionSwitch,
  WorkPage,
  WorkSection,
} from '../components/patterns.tsx';
import { SearchSelect } from '../components/SearchSelect.tsx';
import {
  Avatar,
  Button,
  Card,
  control,
  DataTable,
  Field,
  Notice,
  RowCard,
  Select,
  Tag,
  TextArea,
  WaveLoader,
} from '../components/ui.tsx';
import { api, ApiError, needsFreshSignIn, type ArtistSummary, type Me } from '../lib/api.ts';
import type { AppConfig } from '../lib/config.ts';
import { checkPhone, COUNTRIES, PINNED, searchCountries } from '../lib/countries.ts';
import {
  activityLine,
  ago,
  businessDaysWaiting,
  CLOSE_REASONS,
  closeReasonLabel,
  enquiriesCsv,
  filterEnquiries,
  STATUS_LABEL,
  waitingTooLong,
  when,
  type CloseReason,
  type EnquiryDetail,
  type EnquiryFilter,
  type EnquiryStatus,
  type EnquirySummary,
} from '../lib/enquiries.ts';
import { useLive } from '../lib/live.ts';

/** Status tags: Open lilac, In progress navy, Converted green, Closed slate. */
export function StatusTag({ status }: { status: EnquiryStatus }) {
  const cls: Record<EnquiryStatus, string> = {
    open: '!bg-[#C9B8FF] !text-[#011935]',
    'in-progress': '',
    converted: '!bg-[#1F6F4A] !text-white',
    closed: '',
  };
  return (
    <Tag tone={status === 'in-progress' ? 'n' : 's'} className={cls[status]}>
      {status === 'converted' ? '✓ ' : ''}
      {STATUS_LABEL[status]}
    </Tag>
  );
}

const FILTERS: { id: EnquiryFilter; label: string }[] = [
  { id: 'open', label: 'Open' },
  { id: 'mine', label: 'Mine' },
  { id: 'in-progress', label: 'In progress' },
  { id: 'converted', label: 'Converted' },
  { id: 'closed', label: 'Closed' },
  { id: 'all', label: 'All' },
];

export type EnquiriesTarget = { id: string; n: number } | null;

/**
 * Enquiries (rev 21): consultation requests from the public form. The list
 * opens on Open, oldest first; a request opens its page, where someone picks
 * it up, then marks it converted (to an artist) or closes it.
 */
export function Enquiries({
  cfg,
  token,
  me,
  artists,
  target,
  onOpenArtist,
  onReauth,
  onInvited,
}: {
  cfg: AppConfig;
  token: string;
  me: Me;
  artists: ArtistSummary[];
  /** A request opened from a notification. */
  target?: EnquiriesTarget;
  onOpenArtist: (artistId: string) => void;
  onReauth: () => void;
  /** A new artist was invited from a request: the roster reloads. */
  onInvited: () => void;
}) {
  const [list, setList] = useState<EnquirySummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<EnquiryFilter>('open');
  const [query, setQuery] = useState('');
  const [openId, setOpenId] = useState<string | null>(target?.id ?? null);
  useEffect(() => {
    if (target) setOpenId(target.id);
  }, [target]);

  const load = useCallback(async () => {
    try {
      const res = await api<{ enquiries: EnquirySummary[] }>(cfg, token, 'GET', '/enquiries');
      setList(res.enquiries);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [cfg, token]);
  const live = useLive(['enquiries']);
  useEffect(() => void load(), [load, live]);

  if (openId) {
    return (
      <EnquiryPage
        cfg={cfg}
        token={token}
        me={me}
        artists={artists}
        id={openId}
        live={live}
        onBack={() => {
          setOpenId(null);
          void load();
        }}
        onOpenArtist={onOpenArtist}
        onReauth={onReauth}
        onInvited={onInvited}
      />
    );
  }

  const all = list ?? [];
  const now = new Date();
  const open = all.filter((e) => e.status === 'open');
  const mine = all.filter((e) => e.status === 'in-progress' && e.ownerSub === me.sub);
  const inProgress = all.filter((e) => e.status === 'in-progress');
  const ninety = new Date(now.getTime() - 90 * 24 * 3600 * 1000).toISOString();
  const converted = all.filter((e) => e.status === 'converted' && e.updatedAt >= ninety);
  const oldest = [...open].sort((a, b) => a.receivedAt.localeCompare(b.receivedAt))[0];
  const shown = filterEnquiries(all, filter, me.sub, query);
  const isAdmin = me.role === 'bmg-admin';

  const download = () => {
    const blob = new Blob([enquiriesCsv(shown)], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `consultation-requests-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const waiting = (e: EnquirySummary) =>
    waitingTooLong(e, now) ? (
      <span className="block text-[13px] font-extrabold text-[#B5403C]">
        Waiting {businessDaysWaiting(e.receivedAt, now)} days
      </span>
    ) : (
      <span className="src block">{ago(e.receivedAt, now)}</span>
    );

  return (
    <div className="flex flex-col gap-5">
      <div className="grid grid-cols-[repeat(auto-fit,minmax(200px,1fr))] gap-4">
        <Card>
          <span className="eyebrow">Open</span>
          <b className="poster text-[44px] leading-none">{open.length}</b>
          <span className="src">
            {oldest
              ? `Oldest waiting ${Math.max(businessDaysWaiting(oldest.receivedAt, now), 0)} business day${businessDaysWaiting(oldest.receivedAt, now) === 1 ? '' : 's'}`
              : 'Nothing waiting'}
          </span>
        </Card>
        <Card>
          <span className="eyebrow">In progress</span>
          <b className="poster text-[44px] leading-none">{inProgress.length}</b>
          <span className="src">{mine.length} of them yours</span>
        </Card>
        <Card>
          <span className="eyebrow">Converted · 90 days</span>
          <b className="poster text-[44px] leading-none">{converted.length}</b>
          <span className="src">Became artists with Blueprint</span>
        </Card>
      </div>

      <Card
        title="Consultation requests"
        action={
          isAdmin && shown.length > 0 ? (
            <Button size="sm" variant="ghost" onClick={download}>
              Export CSV
            </Button>
          ) : undefined
        }
      >
        <div className="flex flex-wrap items-center gap-3">
          <SectionSwitch
            label="Show requests"
            value={filter}
            onChange={setFilter}
            options={FILTERS.map((f) =>
              f.id === 'open' && open.length
                ? { ...f, label: `Open ${open.length}` }
                : f.id === 'mine' && mine.length
                  ? { ...f, label: `Mine ${mine.length}` }
                  : f,
            )}
          />
          <label className="ml-auto flex min-w-[220px] flex-[1_1_240px]">
            <span className="sr-only">Search requests</span>
            <input
              type="search"
              className={control}
              placeholder="Search name, email or country"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </label>
        </div>
        {error && <Notice tone="error">{error}</Notice>}
        {list === null && !error ? (
          <WaveLoader label="Loading requests" />
        ) : shown.length === 0 ? (
          <p className="src">
            {query
              ? `Nothing matches “${query}”.`
              : filter === 'open'
                ? 'No open requests. Everything’s been picked up.'
                : filter === 'mine'
                  ? 'You don’t have any requests in progress.'
                  : 'No requests here yet.'}
          </p>
        ) : (
          <DataTable
            label="Consultation requests"
            cards={shown.map((e) => (
              <RowCard
                key={e.enquiryId}
                title={e.name}
                sub={[e.countryName, e.ownerName ? `With ${e.ownerName}` : null]
                  .filter(Boolean)
                  .join(' · ')}
                status={<StatusTag status={e.status} />}
                tags={waiting(e)}
                accent={waitingTooLong(e, now)}
                muted={e.status === 'closed'}
                onOpen={() => setOpenId(e.enquiryId)}
                openLabel={`Open ${e.name}’s request`}
              />
            ))}
          >
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Country</th>
                <th scope="col">Received</th>
                <th scope="col">Status</th>
                <th scope="col">Picked up by</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((e) => (
                <tr
                  key={e.enquiryId}
                  className={`cursor-pointer ${e.status === 'closed' ? 'opacity-70' : ''}`}
                  onClick={() => setOpenId(e.enquiryId)}
                >
                  <td>
                    <button type="button" className="text-left font-bold">
                      {e.name}
                    </button>
                    <span className="src block">{e.email}</span>
                  </td>
                  <td>
                    <span className="tag tn mr-1.5 !text-[12px]">{e.country}</span>
                    {e.countryName}
                  </td>
                  <td>
                    {when(e.receivedAt)}
                    {waiting(e)}
                  </td>
                  <td>
                    <StatusTag status={e.status} />
                    {e.resends > 0 && <span className="src block">Sent {e.resends + 1} times</span>}
                  </td>
                  <td>
                    {e.ownerName ? (
                      <span className="flex items-center gap-2">
                        <Avatar name={e.ownerName} size={26} />
                        {e.ownerSub === me.sub ? 'You' : e.ownerName}
                      </span>
                    ) : (
                      '—'
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </DataTable>
        )}
        <p className="src">
          {filter === 'open'
            ? 'Oldest first, so nothing is left waiting. A row opens the request.'
            : 'A row opens the request. Spam only shows under Closed.'}
        </p>
      </Card>
    </div>
  );
}

type Panel = 'convert' | 'close' | null;

/** One request: their details, the status actions, notes and what happened. */
function EnquiryPage({
  cfg,
  token,
  me,
  artists,
  id,
  live,
  onBack,
  onOpenArtist,
  onReauth,
  onInvited,
}: {
  cfg: AppConfig;
  token: string;
  me: Me;
  artists: ArtistSummary[];
  id: string;
  live: number;
  onBack: () => void;
  onOpenArtist: (artistId: string) => void;
  onReauth: () => void;
  onInvited: () => void;
}) {
  const [e, setE] = useState<EnquiryDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [panel, setPanel] = useState<Panel>(null);
  const [editing, setEditing] = useState(false);
  const path = `/enquiries/${id}`;

  const load = useCallback(async () => {
    try {
      setE(await api<EnquiryDetail>(cfg, token, 'GET', path));
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [cfg, token, path]);
  useEffect(() => void load(), [load, live]);

  const run = async (body: Record<string, unknown>, done: string) => {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      setE(await api<EnquiryDetail>(cfg, token, 'POST', `${path}/actions`, body));
      setNote(done);
      setPanel(null);
    } catch (err) {
      setError((err as Error).message);
      // Someone else changed it: show it as it is now.
      if (err instanceof ApiError && err.status === 409) void load();
    } finally {
      setBusy(false);
    }
  };

  if (!e) {
    return (
      <Card
        title="Consultation request"
        action={
          <Button size="sm" variant="ghost" onClick={onBack}>
            ← Enquiries
          </Button>
        }
      >
        {error ? <Notice tone="error">{error}</Notice> : <WaveLoader label="Loading the request" />}
      </Card>
    );
  }

  if (editing) {
    return (
      <EditEnquiry
        cfg={cfg}
        token={token}
        me={me}
        enquiry={e}
        onReauth={onReauth}
        onCancel={() => setEditing(false)}
        onSaved={(next) => {
          setE(next);
          setEditing(false);
          setNote('Saved.');
        }}
        onDeleted={onBack}
      />
    );
  }

  const mine = e.ownerSub === me.sub;
  const isAdmin = me.role === 'bmg-admin';
  const artist = e.artistId ? artists.find((a) => a.artistId === e.artistId) : undefined;
  const primary =
    e.status === 'open' ? (
      <Button
        variant="cta"
        disabled={busy}
        onClick={() => void run({ kind: 'pick-up' }, 'It’s yours now.')}
      >
        {busy ? 'Picking up…' : 'Pick up'}
      </Button>
    ) : e.status === 'in-progress' && mine ? (
      <Button
        variant="cta"
        disabled={busy}
        aria-expanded={panel === 'convert'}
        onClick={() => setPanel(panel === 'convert' ? null : 'convert')}
      >
        Mark converted
      </Button>
    ) : e.status === 'converted' && e.artistId ? (
      <Button variant="cta" onClick={() => onOpenArtist(e.artistId!)}>
        Open {artist?.displayName ?? 'the artist'}’s workspace
      </Button>
    ) : undefined;

  const more = (
    <>
      {e.status === 'in-progress' && mine && (
        <Button
          variant="ghost"
          disabled={busy}
          onClick={() =>
            void run({ kind: 'hand-back' }, 'Handed back. It’s open for anyone to pick up.')
          }
        >
          Hand back
        </Button>
      )}
      {e.status === 'in-progress' && !mine && isAdmin && (
        <Button
          variant="ghost"
          disabled={busy}
          onClick={() =>
            void run({ kind: 'take-over' }, `It’s yours now. ${e.ownerName ?? 'They'} were told.`)
          }
        >
          Take over
        </Button>
      )}
      {(e.status === 'open' || (e.status === 'in-progress' && (mine || isAdmin))) && (
        <Button
          variant="ghost"
          disabled={busy}
          aria-expanded={panel === 'close'}
          onClick={() => setPanel(panel === 'close' ? null : 'close')}
        >
          Close…
        </Button>
      )}
      {(e.status === 'closed' || (e.status === 'converted' && (mine || isAdmin))) && (
        <Button
          variant="ghost"
          disabled={busy}
          onClick={() => void run({ kind: 'reopen' }, 'Reopened. It’s with you.')}
        >
          Reopen
        </Button>
      )}
    </>
  );

  return (
    <WorkPage
      kind="Consultation request"
      title={e.name}
      sub={`${e.countryName} · received ${when(e.receivedAt)}`}
      badges={
        <>
          <StatusTag status={e.status} />
          {e.ownerName && (
            <Tag tone="s">
              {e.status === 'in-progress'
                ? mine
                  ? `Picked up by you${e.pickedUpAt ? ` · ${when(e.pickedUpAt)}` : ''}`
                  : `${e.ownerName} has this`
                : `With ${mine ? 'you' : e.ownerName}`}
            </Tag>
          )}
          {e.status === 'closed' && <Tag tone="s">{closeReasonLabel(e.closedReason)}</Tag>}
          {e.status === 'converted' && artist && <Tag tone="s">{artist.displayName}</Tag>}
        </>
      }
      back={{ to: 'Enquiries', onClick: onBack }}
      primary={primary}
      onEdit={() => setEditing(true)}
      more={more}
    >
      {note && <Notice tone="success">{note}</Notice>}
      {error && <Notice tone="error">{error}</Notice>}

      {panel === 'convert' && (
        <ConvertPanel
          cfg={cfg}
          token={token}
          me={me}
          enquiry={e}
          artists={artists}
          busy={busy}
          onCancel={() => setPanel(null)}
          onConvert={(artistId, name) =>
            void run({ kind: 'convert', artistId }, `Converted to ${name}.`)
          }
          onReauth={onReauth}
          onInvited={onInvited}
        />
      )}
      {panel === 'close' && (
        <ClosePanel
          busy={busy}
          onCancel={() => setPanel(null)}
          onClose={(reason) =>
            void run(
              { kind: 'close', reason },
              reason === 'spam' ? 'Closed as spam. It’s hidden from the lists.' : 'Closed.',
            )
          }
        />
      )}

      <WorkSection title="Their request">
        <dl className="m-0 grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1.5 text-[15px]">
          <dt className="src">Email</dt>
          <dd className="m-0 [overflow-wrap:anywhere]">{e.email}</dd>
          <dt className="src">Mobile</dt>
          <dd className="m-0">{e.phone ?? '—'}</dd>
          <dt className="src">Country</dt>
          <dd className="m-0">{e.countryName}</dd>
          {e.resends > 0 && (
            <>
              <dt className="src">Sent</dt>
              <dd className="m-0">{e.resends + 1} times (the later ones are in Notes)</dd>
            </>
          )}
        </dl>
        <div className="flex flex-wrap gap-2">
          <a
            className="inline-flex min-h-11 items-center rounded-full border-2 border-[#011935] bg-primary px-5 font-title text-[15px] font-extrabold text-primary-foreground"
            href={`mailto:${e.email}?subject=${encodeURIComponent('Your consultation request with Blueprint Music Group')}`}
          >
            Reply by email
          </a>
          {e.phone && (
            <>
              <a
                className="inline-flex min-h-11 items-center rounded-full border-2 border-input px-5 font-bold"
                href={`tel:${e.phone}`}
              >
                Call
              </a>
              <a
                className="inline-flex min-h-11 items-center rounded-full border-2 border-input px-5 font-bold"
                href={`sms:${e.phone}`}
              >
                Text
              </a>
            </>
          )}
        </div>
        <h4 className="eyebrow mt-2">Tell us about yourself</h4>
        <p className="m-0 text-[16px] leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere]">
          {e.aboutMe}
        </p>
        <h4 className="eyebrow mt-2">How can BMG help?</h4>
        <p className="m-0 text-[16px] leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere]">
          {e.howCanWeHelp}
        </p>
      </WorkSection>

      <Notes cfg={cfg} token={token} enquiry={e} onSaved={setE} />

      <WorkSection title="Activity">
        <ul className="m-0 flex list-none flex-col gap-1.5 p-0 text-[15px]">
          {e.activity.map((a) => (
            <li
              key={a.actId}
              className="flex flex-wrap justify-between gap-x-4 border-b border-dashed border-input pb-1.5"
            >
              <span>
                {activityLine(
                  a,
                  a.artistId
                    ? artists.find((x) => x.artistId === a.artistId)?.displayName
                    : undefined,
                )}
              </span>
              <span className="src">{when(a.at)}</span>
            </li>
          ))}
        </ul>
      </WorkSection>
    </WorkPage>
  );
}

/** Mark converted: which artist this request became, or invite them now (admins). */
function ConvertPanel({
  cfg,
  token,
  me,
  enquiry: e,
  artists,
  busy,
  onCancel,
  onConvert,
  onReauth,
  onInvited,
}: {
  cfg: AppConfig;
  token: string;
  me: Me;
  enquiry: EnquiryDetail;
  artists: ArtistSummary[];
  busy: boolean;
  onCancel: () => void;
  onConvert: (artistId: string, name: string) => void;
  onReauth: () => void;
  onInvited: () => void;
}) {
  const [artistId, setArtistId] = useState<string | null>(null);
  const [inviting, setInviting] = useState(false);
  const [name, setName] = useState(e.name);
  const [email, setEmail] = useState(e.email);
  const [error, setError] = useState<{ text: string; reauth: boolean } | null>(null);
  const [sending, setSending] = useState(false);
  const options = [...artists]
    .sort((a, b) => a.displayName.localeCompare(b.displayName))
    .map((a) => ({
      id: a.artistId,
      label: a.displayName,
      lead: <Avatar name={a.displayName} artistId={a.artistId} size={26} />,
    }));
  const chosen = artists.find((a) => a.artistId === artistId);

  return (
    <section
      aria-label="Mark converted"
      className="flex flex-col gap-3 rounded-[18px] bg-primary p-4 text-primary-foreground"
    >
      <span className="eyebrow !text-[#F2A3A0]">Mark converted</span>
      {!inviting ? (
        <>
          <p className="m-0 text-[16px]">Which artist did this request become?</p>
          <div className="text-[#011935] [&>div>span:first-child]:text-primary-foreground">
            <SearchSelect
              label="Artist"
              value={artistId}
              options={options}
              placeholder="Type an artist’s name"
              searchLabel="Search artists"
              emptyText={(q) => `No artist matches “${q}”.`}
              onChange={setArtistId}
            />
          </div>
          {me.role === 'bmg-admin' && (
            <Button variant="ghost" className="self-start" onClick={() => setInviting(true)}>
              + Invite them as a new artist
            </Button>
          )}
          <div className="flex flex-wrap gap-2">
            <Button
              variant="cta"
              disabled={busy || !chosen}
              onClick={() => chosen && onConvert(chosen.artistId, chosen.displayName)}
            >
              {busy ? 'Saving…' : 'Save as converted'}
            </Button>
            <Button variant="ghost" onClick={onCancel}>
              Cancel
            </Button>
          </div>
        </>
      ) : (
        <form
          className="flex flex-col gap-3 text-[#011935] [&_span.font-bold]:text-primary-foreground"
          onSubmit={(ev) => {
            ev.preventDefault();
            setSending(true);
            setError(null);
            api<{ artistId: string }>(cfg, token, 'POST', '/artists', {
              email: email.trim(),
              displayName: name.trim(),
            })
              .then((res) => {
                onInvited();
                onConvert(res.artistId, name.trim());
              })
              .catch((err: unknown) => {
                const reauth = needsFreshSignIn(err);
                setError({
                  text: reauth
                    ? 'For security, sign in again to invite artists.'
                    : (err as Error).message,
                  reauth,
                });
              })
              .finally(() => setSending(false));
          }}
        >
          <p className="m-0 text-[16px] text-primary-foreground">
            Sets up their login, private key and workspace, and emails them an invitation. The
            request converts to them.
          </p>
          <Field
            label="Artist name"
            value={name}
            maxLength={120}
            required
            onChange={(ev) => setName(ev.target.value)}
          />
          <Field
            label="Email"
            type="email"
            value={email}
            maxLength={254}
            required
            onChange={(ev) => setEmail(ev.target.value)}
          />
          {error && (
            <Notice tone="error">
              {error.text}{' '}
              {error.reauth && (
                <Button size="sm" variant="ghost" onClick={onReauth}>
                  Sign in again
                </Button>
              )}
            </Notice>
          )}
          <div className="flex flex-wrap gap-2">
            <Button
              type="submit"
              variant="cta"
              disabled={sending || busy || !name.trim() || !email.trim()}
            >
              {sending ? 'Inviting…' : 'Send invitation and convert'}
            </Button>
            <Button type="button" variant="ghost" onClick={() => setInviting(false)}>
              Back to choosing
            </Button>
          </div>
        </form>
      )}
    </section>
  );
}

function ClosePanel({
  busy,
  onCancel,
  onClose,
}: {
  busy: boolean;
  onCancel: () => void;
  onClose: (reason: CloseReason) => void;
}) {
  const [reason, setReason] = useState<CloseReason>('not-a-fit');
  return (
    <section
      aria-label="Close the request"
      className="flex flex-col gap-3 rounded-[18px] border-2 border-input p-4"
    >
      <Select
        label="Why close it?"
        value={reason}
        onChange={(ev) => setReason(ev.target.value as CloseReason)}
        options={CLOSE_REASONS.map((r) => ({ value: r.id, label: r.label }))}
      />
      <p className="src m-0">
        {reason === 'spam'
          ? 'Spam is hidden from every list but Closed.'
          : 'Closed requests are deleted after a year. You can reopen it before then.'}
      </p>
      <div className="flex flex-wrap gap-2">
        <Button variant="cta" disabled={busy} onClick={() => onClose(reason)}>
          {busy ? 'Closing…' : 'Close it'}
        </Button>
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </section>
  );
}

function Notes({
  cfg,
  token,
  enquiry: e,
  onSaved,
}: {
  cfg: AppConfig;
  token: string;
  enquiry: EnquiryDetail;
  onSaved: (e: EnquiryDetail) => void;
}) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <WorkSection title="Notes" action={<Tag tone="s">Blueprint only</Tag>}>
      <form
        className="flex flex-col gap-2"
        onSubmit={(ev) => {
          ev.preventDefault();
          setBusy(true);
          setError(null);
          api<EnquiryDetail>(cfg, token, 'POST', `/enquiries/${e.enquiryId}/notes`, { text })
            .then((next) => {
              onSaved(next);
              setText('');
            })
            .catch((err: Error) => setError(err.message))
            .finally(() => setBusy(false));
        }}
      >
        <TextArea
          label="Add a note for the team"
          value={text}
          maxLength={2000}
          onChange={(ev) => setText(ev.target.value)}
        />
        {error && <Notice tone="error">{error}</Notice>}
        <Button
          type="submit"
          variant="ghost"
          className="self-start"
          disabled={busy || !text.trim()}
        >
          {busy ? 'Adding…' : 'Add note'}
        </Button>
      </form>
      {e.notes.length > 0 && (
        <ul className="m-0 flex list-none flex-col gap-3 p-0">
          {e.notes.map((n) => (
            <li key={n.noteId} className="flex gap-2.5">
              <Avatar name={n.byName} size={32} />
              <div className="min-w-0">
                <b>{n.bySub === 'public' ? `${n.byName} (from the form)` : n.byName}</b>{' '}
                <span className="src">· {when(n.at)}</span>
                <p className="m-0 text-[15px] whitespace-pre-wrap [overflow-wrap:anywhere]">
                  {n.text}
                </p>
              </div>
            </li>
          ))}
        </ul>
      )}
    </WorkSection>
  );
}

/** Edit details: typos in the contact details; the answers stay as they were sent. */
function EditEnquiry({
  cfg,
  token,
  me,
  enquiry: e,
  onCancel,
  onSaved,
  onDeleted,
  onReauth,
}: {
  cfg: AppConfig;
  token: string;
  me: Me;
  enquiry: EnquiryDetail;
  onCancel: () => void;
  onSaved: (e: EnquiryDetail) => void;
  onDeleted: () => void;
  onReauth: () => void;
}) {
  const [name, setName] = useState(e.name);
  const [email, setEmail] = useState(e.email);
  const [country, setCountry] = useState(e.country);
  const [phone, setPhone] = useState(e.phone ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const opts = COUNTRIES.map((c) => ({
    id: c.code,
    label: c.name,
    ...(c.dial ? { hint: c.dial } : {}),
  }));

  return (
    <EditScreen
      title="Edit details"
      back={{ to: e.name, onClick: onCancel }}
      busy={busy}
      error={error}
      onCancel={onCancel}
      onSave={async () => {
        const p = checkPhone(phone, country);
        if (p.error) return setError(p.error);
        setBusy(true);
        setError(null);
        try {
          onSaved(
            await api<EnquiryDetail>(cfg, token, 'PATCH', `/enquiries/${e.enquiryId}`, {
              name: name.trim(),
              email: email.trim(),
              country,
              phone: p.e164 ?? null,
            }),
          );
        } catch (err) {
          setError((err as Error).message);
        } finally {
          setBusy(false);
        }
      }}
      danger={
        me.role === 'bmg-admin' ? (
          <DangerArea
            title="Delete this request"
            what="Deletes the request, its notes and its history for good. For spam, or when the person asks for their details to be removed."
            onConfirm={async () => {
              try {
                await api(cfg, token, 'DELETE', `/enquiries/${e.enquiryId}`);
              } catch (err) {
                if (needsFreshSignIn(err)) onReauth();
                throw err;
              }
              onDeleted();
            }}
          />
        ) : undefined
      }
    >
      <Field
        label="Name"
        value={name}
        maxLength={100}
        required
        onChange={(ev) => setName(ev.target.value)}
      />
      <Field
        label="Email"
        type="email"
        value={email}
        maxLength={254}
        required
        onChange={(ev) => setEmail(ev.target.value)}
      />
      <SearchSelect
        label="Country"
        value={country}
        options={opts}
        pinned={PINNED.map((c) => ({
          id: c.code,
          label: c.name,
          ...(c.dial ? { hint: c.dial } : {}),
        }))}
        search={(q) =>
          searchCountries(q).map((c) => ({
            id: c.code,
            label: c.name,
            ...(c.dial ? { hint: c.dial } : {}),
          }))
        }
        onChange={setCountry}
      />
      <Field
        label="Mobile (optional)"
        type="tel"
        value={phone}
        hint="With the country code, e.g. +61 412 345 678."
        onChange={(ev) => setPhone(ev.target.value)}
      />
      <p className="src m-0">Their answers stay as they sent them.</p>
    </EditScreen>
  );
}
