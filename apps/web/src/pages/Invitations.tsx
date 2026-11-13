import { useCallback, useEffect, useState } from 'react';
import { DangerArea, RecordPage, SectionSwitch } from '../components/patterns.tsx';
import { Button, Card, Notice, RowCard, Tag, WaveLoader } from '../components/ui.tsx';
import { api, ApiError, needsFreshSignIn } from '../lib/api.ts';
import type { AppConfig } from '../lib/config.ts';

/** One artist invitation and where it stands (GET /access/invitations). */
export interface Invitation {
  artistId: string;
  displayName: string;
  email: string | null;
  /** Accepted = the artist has signed in for the first time. */
  status: 'pending' | 'expired' | 'accepted' | 'revoked';
  invitedAt: string | null;
  lastSentAt: string | null;
  expiresAt: string | null;
  acceptedAt: string | null;
  revokedAt: string | null;
  resend: boolean;
  revoke: boolean;
}

const STATUS: Record<Invitation['status'], [tone: 'c' | 'n' | 's' | 'k', label: string]> = {
  pending: ['k', 'Waiting to sign in'],
  expired: ['c', 'Expired'],
  accepted: ['n', 'Accepted'],
  revoked: ['s', 'Revoked'],
};

type Filter = 'waiting' | 'accepted' | 'all';
const FILTERS = [
  { id: 'waiting', label: 'Waiting' },
  { id: 'accepted', label: 'Accepted' },
  { id: 'all', label: 'All' },
] as const;

const day = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' })
    : '';

/** The line under a name: when it was sent and what happened since. */
function story(i: Invitation): string {
  const sent =
    i.lastSentAt && i.invitedAt && i.lastSentAt !== i.invitedAt
      ? `Invited ${day(i.invitedAt)} · sent again ${day(i.lastSentAt)}`
      : `Invited ${day(i.invitedAt)}`;
  switch (i.status) {
    case 'accepted':
      return `${sent} · signed in ${day(i.acceptedAt)}`;
    case 'revoked':
      return `${sent} · revoked ${day(i.revokedAt)}`;
    case 'expired':
      return `${sent} · expired ${day(i.expiresAt)}`;
    default:
      return `${sent} · expires ${day(i.expiresAt)}`;
  }
}

/**
 * Invitations (Invite artist page): every artist invited, and where each one
 * stands. An invitation is accepted when the artist signs in for the first
 * time. Opening one shows Resend and Revoke.
 */
export function Invitations({
  cfg,
  token,
  refreshKey,
  onReauth,
}: {
  cfg: AppConfig;
  token: string;
  /** Changes after a new invite, so the list reloads. */
  refreshKey: number;
  onReauth: () => void;
}) {
  const [list, setList] = useState<Invitation[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>('waiting');
  const [openId, setOpenId] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await api<{ invitations: Invitation[] }>(
        cfg,
        token,
        'GET',
        '/access/invitations',
      );
      setList(res.invitations);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [cfg, token]);
  useEffect(() => void load(), [load, refreshKey]);

  const open = list?.find((i) => i.artistId === openId);
  if (open) {
    return (
      <InvitationPage
        cfg={cfg}
        token={token}
        invitation={open}
        onReauth={onReauth}
        onBack={() => setOpenId(null)}
        onChanged={async (msg) => {
          setNote(msg);
          await load();
        }}
        note={note}
      />
    );
  }

  const shown = (list ?? []).filter((i) =>
    filter === 'all'
      ? true
      : filter === 'accepted'
        ? i.status === 'accepted'
        : i.status !== 'accepted',
  );
  const waiting = (list ?? []).filter((i) => i.status === 'pending').length;

  return (
    <Card
      title="Invitations"
      action={
        <SectionSwitch
          label="Show invitations"
          value={filter}
          onChange={setFilter}
          options={FILTERS.map((f) =>
            f.id === 'waiting' && waiting ? { ...f, label: `Waiting ${waiting}` } : f,
          )}
        />
      }
    >
      {error && <Notice tone="error">{error}</Notice>}
      {note && <Notice tone="success">{note}</Notice>}
      {list === null && !error ? (
        <WaveLoader label="Loading invitations" />
      ) : shown.length === 0 ? (
        <p className="src">
          {filter === 'accepted'
            ? 'Nobody has accepted an invitation yet.'
            : filter === 'waiting'
              ? 'No invitations are waiting. Everyone invited has signed in.'
              : 'No artists invited yet.'}
        </p>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-2 p-0">
          {shown.map((i) => {
            const [tone, label] = STATUS[i.status];
            return (
              <RowCard
                key={i.artistId}
                title={i.displayName}
                sub={[i.email, story(i)].filter(Boolean).join(' · ')}
                status={<Tag tone={tone}>{label}</Tag>}
                accent={i.status === 'expired'}
                muted={i.status === 'revoked'}
                onOpen={() => {
                  setNote(null);
                  setOpenId(i.artistId);
                }}
                openLabel={`Open the invitation for ${i.displayName}`}
              />
            );
          })}
        </ul>
      )}
      <p className="src">An invitation is accepted when the artist signs in for the first time.</p>
    </Card>
  );
}

/** One invitation: what happened, Resend, and Revoke in the danger area. */
function InvitationPage({
  cfg,
  token,
  invitation: i,
  note,
  onBack,
  onChanged,
  onReauth,
}: {
  cfg: AppConfig;
  token: string;
  invitation: Invitation;
  note: string | null;
  onBack: () => void;
  onChanged: (msg: string) => Promise<void>;
  onReauth: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ text: string; reauth: boolean } | null>(null);
  const [tone, label] = STATUS[i.status];
  const path = `/access/invitations/${i.artistId}`;
  const failed = (e: unknown) => {
    const reauth =
      needsFreshSignIn(e) ||
      (e instanceof ApiError && e.status === 403 && /two-step/.test(e.message));
    return { text: reauth ? 'For security, sign in again first.' : (e as Error).message, reauth };
  };

  return (
    <RecordPage
      kind="Invitation"
      title={i.displayName}
      sub={i.email ?? undefined}
      badges={<Tag tone={tone}>{label}</Tag>}
      back={{ to: 'Invitations', onClick: onBack }}
      primary={
        i.resend ? (
          <Button
            variant="cta"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                await api(cfg, token, 'POST', `${path}/resend`);
                await onChanged(
                  i.status === 'revoked'
                    ? `Invitation turned back on and sent to ${i.email}.`
                    : `Invitation sent again to ${i.email}, with a new temporary password.`,
                );
              } catch (e) {
                setError(failed(e));
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? 'Sending…' : i.status === 'revoked' ? 'Send it again' : 'Resend invitation'}
          </Button>
        ) : undefined
      }
    >
      {note && <Notice tone="success">{note}</Notice>}
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
      <dl className="m-0 grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1.5 text-[15px]">
        <dt className="src">Invited</dt>
        <dd className="m-0">{day(i.invitedAt) || '—'}</dd>
        <dt className="src">Last sent</dt>
        <dd className="m-0">{day(i.lastSentAt) || '—'}</dd>
        {i.status === 'accepted' ? (
          <>
            <dt className="src">First signed in</dt>
            <dd className="m-0">{day(i.acceptedAt) || 'Yes'}</dd>
          </>
        ) : i.status === 'revoked' ? (
          <>
            <dt className="src">Revoked</dt>
            <dd className="m-0">{day(i.revokedAt) || '—'}</dd>
          </>
        ) : (
          <>
            <dt className="src">{i.status === 'expired' ? 'Expired' : 'Expires'}</dt>
            <dd className="m-0">{day(i.expiresAt) || '—'}</dd>
          </>
        )}
      </dl>
      <p className="src">
        {i.status === 'accepted'
          ? 'They’ve signed in, so this invitation is done. Their workspace is under Artist workspaces.'
          : i.status === 'revoked'
            ? 'Their login is off. Sending it again turns it back on, with a new temporary password and 7 days to sign in.'
            : 'Resending sends a new temporary password and gives them another 7 days. The old password stops working.'}
      </p>
      {i.revoke && (
        <DangerArea
          title={`Revoke ${i.displayName}’s invitation`}
          action="Revoke"
          what="Their temporary password stops working and they can’t sign in. Their workspace stays as it is, and you can send the invitation again later."
          onConfirm={async () => {
            try {
              await api(cfg, token, 'POST', `${path}/revoke`);
            } catch (e) {
              throw new Error(failed(e).text, { cause: e });
            }
            await onChanged(`${i.displayName}’s invitation is revoked.`);
          }}
        />
      )}
    </RecordPage>
  );
}
