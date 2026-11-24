import { useCallback, useEffect, useState } from 'react';
import { BackLink, RecordPage } from '../components/patterns.tsx';
import {
  Button,
  Card,
  Field,
  Notice,
  RowCard,
  Select,
  Tag,
  TextArea,
  WaveLoader,
} from '../components/ui.tsx';
import { api, ApiError, needsFreshSignIn } from '../lib/api.ts';
import type { AppConfig } from '../lib/config.ts';
import { useLive } from '../lib/live.ts';

/**
 * Rev 22: deleting an artist (admins). A full page, not a popup: what will be
 * archived and what stays, a reason, and the artist's name typed to confirm.
 * The deletion itself runs on the server; the Deleted list shows how it's going.
 */

interface Counts {
  files: number;
  chats: number;
  plan: number;
  todos: number;
  gigs: number;
  submissions: number;
  meetings: number;
  other: number;
}
interface Preview {
  artistId: string;
  displayName: string;
  status: string;
  counts: Counts;
  upcomingGigs: { gigId: string; title: string; date: string }[];
}
export interface Deletion {
  artistId: string;
  deletionId: string;
  displayName: string;
  reasonLabel: string;
  note: string | null;
  byName: string;
  startedAt: string;
  finishedAt: string | null;
  status: 'running' | 'paused' | 'done';
  stepLabel: string;
  stepNumber: number;
  stepCount: number;
  error: string | null;
  counts: Counts;
  archive: { prefix: string; objects: number; items: number; bytes: number } | null;
  retainUntil: string | null;
  mentions: { fileId: string; name: string; why: 'name' | 'shared' }[];
}

const REASONS = [
  { value: '', label: 'Choose a reason' },
  { value: 'left', label: 'Left Blueprint' },
  { value: 'asked', label: 'Asked to be deleted' },
  { value: 'duplicate', label: 'Duplicate or test account' },
  { value: 'other', label: 'Other' },
];

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const day = (iso: string | null) =>
  iso
    ? new Date(iso.length === 10 ? `${iso}T00:00:00` : iso).toLocaleDateString('en-AU', {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
      })
    : '';

/** "48 files, 6 chats, 1 plan, 23 to-dos…", leaving out what they don't have. */
export function countsLine(c: Counts): string {
  const parts = [
    c.files && plural(c.files, 'file'),
    c.chats && plural(c.chats, 'chat'),
    c.plan && plural(c.plan, 'plan'),
    c.todos && plural(c.todos, 'to-do'),
    c.gigs && plural(c.gigs, 'gig'),
    c.submissions && plural(c.submissions, 'submission'),
    c.meetings && plural(c.meetings, 'meeting'),
  ].filter(Boolean);
  return parts.length ? parts.join(', ') : 'Nothing in their workspace yet';
}

export function DeleteArtistPage({
  cfg,
  token,
  artistId,
  onBack,
  onStarted,
  onReauth,
}: {
  cfg: AppConfig;
  token: string;
  artistId: string;
  onBack: () => void;
  /** The deletion started: go to the Deleted list. */
  onStarted: (name: string) => void;
  onReauth: () => void;
}) {
  const [look, setLook] = useState<Preview | null>(null);
  const [error, setError] = useState<{ text: string; reauth: boolean } | null>(null);
  const [reason, setReason] = useState('');
  const [note, setNote] = useState('');
  const [emailArtist, setEmailArtist] = useState(false);
  const [ack, setAck] = useState(false);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<Preview>(cfg, token, 'GET', `/access/artists/${artistId}/delete`)
      .then(setLook)
      .catch((e) => setError({ text: (e as Error).message, reauth: false }));
  }, [cfg, token, artistId]);

  if (!look)
    return (
      <Card title="Delete artist" action={<BackLink to="Artist" onClick={onBack} />}>
        {error ? <Notice tone="error">{error.text}</Notice> : <WaveLoader label="Checking" />}
      </Card>
    );

  const fold = (s: string) => s.replace(/\s+/g, ' ').trim().toLocaleLowerCase('en');
  const matches = fold(typed) !== '' && fold(typed) === fold(look.displayName);
  const upcoming = look.upcomingGigs.length > 0;
  const ready = matches && reason !== '' && (!upcoming || ack) && !busy;

  async function start() {
    setBusy(true);
    setError(null);
    try {
      await api(cfg, token, 'POST', `/access/artists/${artistId}/delete`, {
        confirmName: typed,
        reason,
        ...(note.trim() ? { note: note.trim() } : {}),
        emailArtist,
        acknowledgeUpcoming: ack,
      });
      onStarted(look!.displayName);
    } catch (e) {
      const reauth =
        needsFreshSignIn(e) ||
        (e instanceof ApiError && e.status === 403 && /two-step/.test(e.message));
      setError({
        text: reauth ? 'For security, sign in again first.' : (e as Error).message,
        reauth,
      });
      setBusy(false);
    }
  }

  return (
    <Card
      title={<h2 className="poster text-[22px] leading-none">Delete {look.displayName}</h2>}
      action={<BackLink to={look.displayName} onClick={onBack} />}
    >
      <form
        className="flex max-w-[680px] flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (ready) void start();
        }}
      >
        <section aria-labelledby="del-what" className="flex flex-col gap-1.5">
          <h3 id="del-what" className="text-[15px] font-bold">
            What will happen
          </h3>
          <p className="m-0">
            <b>{countsLine(look.counts)}</b> will be archived and removed from the app.
          </p>
          <p className="m-0">
            Their login is turned off straight away and they're signed out everywhere. Their
            knowledge base is deleted, and they're taken out of everything the assistant can see.
          </p>
          <p className="src m-0">
            The archive is kept for 7 years under {look.displayName}'s own key, then deleted.
            Private files and private chats stay private in it.
          </p>
        </section>
        <section aria-labelledby="del-stays" className="flex flex-col gap-1.5">
          <h3 id="del-stays" className="text-[15px] font-bold">
            What stays
          </h3>
          <ul className="m-0 flex flex-col gap-1 pl-5">
            <li>Group chats, with their messages shown as “Former artist”.</li>
            <li>Private chats with other artists, read-only for the other artist.</li>
            <li>Contacts and venues they added, now Blueprint's.</li>
            <li>The audit history.</li>
          </ul>
          <p className="src m-0">
            Blueprint documents that mention them are listed for you to review afterwards. They
            aren't changed.
          </p>
        </section>

        {upcoming && (
          <Notice tone="error">
            They have {plural(look.upcomingGigs.length, 'gig')} in the next 7 days:{' '}
            {look.upcomingGigs.map((g) => `${g.title} (${day(g.date)})`).join(', ')}.
          </Notice>
        )}
        {upcoming && (
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />
            Delete them anyway
          </label>
        )}

        <Select
          label="Reason"
          value={reason}
          options={REASONS}
          onChange={(e) => setReason(e.target.value)}
        />
        <TextArea
          label="Note for Blueprint (optional)"
          value={note}
          maxLength={500}
          rows={2}
          onChange={(e) => setNote(e.target.value)}
        />
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={emailArtist}
            onChange={(e) => setEmailArtist(e.target.checked)}
          />
          Email them that their account has been closed
        </label>
        <Field
          label={`Type ${look.displayName} to confirm`}
          value={typed}
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => setTyped(e.target.value)}
        />
        {error && (
          <Notice tone="error">
            {error.text}{' '}
            {error.reauth && (
              <Button type="button" size="sm" variant="ghost" onClick={onReauth}>
                Sign in again
              </Button>
            )}
          </Notice>
        )}
        <div className="flex flex-wrap gap-2">
          <Button type="submit" variant="cta" disabled={!ready}>
            {busy ? 'Deleting…' : 'Delete artist'}
          </Button>
          <Button type="button" variant="ghost" onClick={onBack}>
            Cancel
          </Button>
        </div>
      </form>
    </Card>
  );
}

const STATUS: Record<Deletion['status'], [tone: 'c' | 'n' | 's' | 'k', label: string]> = {
  running: ['k', 'Deleting…'],
  paused: ['c', 'Paused'],
  done: ['s', 'Deleted'],
};

/** Rev 22, admins: deleted artists, how each deletion went, and mentions to review. */
export function DeletedArtists({ cfg, token }: { cfg: AppConfig; token: string }) {
  const [list, setList] = useState<Deletion[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      const res = await api<{ deletions: Deletion[] }>(cfg, token, 'GET', '/access/deletions');
      setList(res.deletions);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [cfg, token]);
  const live = useLive(['artists']);
  useEffect(() => void load(), [load, live]);
  // While one is running, check every few seconds.
  useEffect(() => {
    if (!list?.some((d) => d.status === 'running')) return;
    const t = setInterval(() => void load(), 5000);
    return () => clearInterval(t);
  }, [list, load]);

  const open = list?.find((d) => d.artistId === openId);
  if (open)
    return (
      <DeletionPage
        cfg={cfg}
        token={token}
        d={open}
        onBack={() => setOpenId(null)}
        onChanged={() => void load()}
      />
    );
  return (
    <Card title="Deleted artists">
      {error && <Notice tone="error">{error}</Notice>}
      {list === null && !error ? (
        <WaveLoader label="Loading deleted artists" />
      ) : (list ?? []).length === 0 ? (
        <p className="src">No artists have been deleted.</p>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-2 p-0">
          {list!.map((d) => {
            const [tone, label] = STATUS[d.status];
            return (
              <RowCard
                key={d.artistId}
                title={d.displayName}
                sub={`${day(d.startedAt)} · ${d.byName} · ${d.reasonLabel}`}
                status={
                  <>
                    <Tag tone={tone}>
                      {d.status === 'running'
                        ? `${label} step ${d.stepNumber} of ${d.stepCount}`
                        : label}
                    </Tag>
                    {d.mentions.length > 0 && d.status === 'done' && (
                      <Tag tone="c">{plural(d.mentions.length, 'mention')} to review</Tag>
                    )}
                  </>
                }
                accent={d.status === 'paused'}
                onOpen={() => setOpenId(d.artistId)}
                openLabel={`Open the deletion of ${d.displayName}`}
              />
            );
          })}
        </ul>
      )}
    </Card>
  );
}

function DeletionPage({
  cfg,
  token,
  d,
  onBack,
  onChanged,
}: {
  cfg: AppConfig;
  token: string;
  d: Deletion;
  onBack: () => void;
  onChanged: () => void;
}) {
  const [tone, label] = STATUS[d.status];
  return (
    <RecordPage
      kind="Deleted artist"
      title={d.displayName}
      sub={`Deleted by ${d.byName} on ${day(d.startedAt)} · ${d.reasonLabel}`}
      badges={<Tag tone={tone}>{label}</Tag>}
      back={{ to: 'Deleted artists', onClick: onBack }}
      primary={
        d.status === 'paused' ? (
          <Button
            variant="cta"
            onClick={async () => {
              await api(cfg, token, 'POST', `/access/deletions/${d.artistId}/retry`);
              onChanged();
            }}
          >
            Retry
          </Button>
        ) : undefined
      }
    >
      {d.status === 'paused' && (
        <Notice tone="error">
          Deletion paused at step {d.stepNumber} ({d.stepLabel.toLowerCase()}): {d.error}. They stay
          locked and hidden until it finishes.
        </Notice>
      )}
      <dl className="m-0 grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1.5 text-[15px]">
        <dt className="src">Archived</dt>
        <dd className="m-0">{countsLine(d.counts)}</dd>
        {d.archive && (
          <>
            <dt className="src">Archive</dt>
            <dd className="m-0">
              {plural(d.archive.objects, 'file')}, {plural(d.archive.items, 'record')}
            </dd>
          </>
        )}
        <dt className="src">Kept until</dt>
        <dd className="m-0">{day(d.retainUntil) || '—'}</dd>
        {d.note && (
          <>
            <dt className="src">Note</dt>
            <dd className="m-0">{d.note}</dd>
          </>
        )}
        <dt className="src">Step</dt>
        <dd className="m-0">
          {d.status === 'done' ? 'Finished' : `${d.stepNumber} of ${d.stepCount}: ${d.stepLabel}`}
        </dd>
      </dl>
      <section aria-labelledby="mentions" className="flex flex-col gap-1.5">
        <h3 id="mentions" className="text-[15px] font-bold">
          Review mentions
        </h3>
        {d.mentions.length === 0 ? (
          <p className="src m-0">No Blueprint documents mention them.</p>
        ) : (
          <>
            <p className="src m-0">
              These Blueprint documents are named after them or were shared with them. Their sharing
              was removed; open each to edit, move or delete it.
            </p>
            <ul className="m-0 flex flex-col gap-1 pl-5">
              {d.mentions.map((m) => (
                <li key={m.fileId}>
                  {m.name}{' '}
                  <span className="src">
                    ({m.why === 'name' ? 'mentions them' : 'was shared with them'})
                  </span>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>
      <p className="src m-0">
        The archive can't be opened from the app. It stays in the artist bucket under their own key
        until {day(d.retainUntil) || 'the end of the retention period'} (docs/decisions.md, rev 22).
      </p>
    </RecordPage>
  );
}
