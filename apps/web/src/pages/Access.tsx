import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, type ArtistSummary, type Me } from '../lib/api.ts';
import type { AppConfig } from '../lib/config.ts';
import {
  Avatar,
  Button,
  Card,
  DataTable,
  Field,
  Notice,
  RowCard,
  Select,
  shortDate,
  Tag,
  WaveLoader,
} from '../components/ui.tsx';

/**
 * Access & permissions (screens doc "Artists & access", canvas X-Artists
 * "What artists can see and do"): the switches that apply to every artist
 * account, the rules that never change, and the Blueprint team. Admins
 * change them (with a fresh sign-in check); staff can see them.
 */

interface Rules {
  artistDirectChats: boolean;
  artistGroups: boolean;
  artistGigSharing: boolean;
}
interface Settings extends Rules {
  version: number;
  updatedAt: string | null;
  updatedByName: string | null;
}
type TeamRole = 'bmg-admin' | 'bmg-staff';
interface Member {
  sub: string;
  email: string;
  displayName: string;
  jobTitle: string;
  role: TeamRole;
  enabled: boolean;
  status: string;
  artistIds: string[];
  createdAt: string | null;
}

const ROLE_LABEL: Record<TeamRole, string> = { 'bmg-admin': 'Admin', 'bmg-staff': 'Team member' };
const ROLE_OPTIONS = [
  { value: 'bmg-staff', label: 'Team member: only the artists you pick' },
  { value: 'bmg-admin', label: 'Admin: every artist and every setting' },
];

const SWITCHES: { key: keyof Rules; label: string; sr: string }[] = [
  {
    key: 'artistDirectChats',
    label: 'Message other Blueprint artists directly',
    sr: 'Allow artist-to-artist chat',
  },
  {
    key: 'artistGroups',
    label: 'Start their own group chats with other artists',
    sr: 'Allow artist groups',
  },
  {
    key: 'artistGigSharing',
    label: 'Share their gigs with other artists',
    sr: 'Allow gig sharing',
  },
];

function Fixed({ children, tone, tag }: { children: string; tone: 'n' | 's' | 'c'; tag: string }) {
  return (
    <div className="li">
      <span className="flex-1">{children}</span>
      <Tag tone={tone}>{tag}</Tag>
    </div>
  );
}

function stepUpNeeded(e: unknown) {
  return e instanceof ApiError && e.status === 403 && /step-up/.test(e.message);
}

export function AccessPage({
  cfg,
  token,
  me,
  artists,
  onReauth,
}: {
  cfg: AppConfig;
  token: string;
  me: Me;
  artists: ArtistSummary[];
  onReauth: () => void;
}) {
  const isAdmin = me.role === 'bmg-admin';
  const [saved, setSaved] = useState<Settings | null>(null);
  const [rules, setRules] = useState<Rules | null>(null);
  const [team, setTeam] = useState<Member[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [stepUp, setStepUp] = useState(false);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const load = useCallback(async () => {
    try {
      const [s, t] = await Promise.all([
        api<Settings>(cfg, token, 'GET', '/access/settings'),
        api<{ team: Member[] }>(cfg, token, 'GET', '/access/team'),
      ]);
      setSaved(s);
      setRules({
        artistDirectChats: s.artistDirectChats,
        artistGroups: s.artistGroups,
        artistGigSharing: s.artistGigSharing,
      });
      setTeam(t.team);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [cfg, token]);
  useEffect(() => void load(), [load]);

  async function run(fn: () => Promise<unknown>, done: string) {
    setBusy(true);
    setError(null);
    setNote(null);
    setStepUp(false);
    try {
      await fn();
      await load();
      setNote(done);
      return true;
    } catch (e) {
      if (stepUpNeeded(e)) setStepUp(true);
      else setError((e as Error).message);
      if (e instanceof ApiError && e.status === 409) await load();
      return false;
    } finally {
      setBusy(false);
    }
  }

  if (!saved || !rules || !team) {
    return error ? <Notice tone="error">{error}</Notice> : <WaveLoader />;
  }
  const dirty = SWITCHES.some((s) => rules[s.key] !== saved[s.key]);
  const artistName = (id: string) => artists.find((a) => a.artistId === id)?.displayName ?? id;

  return (
    <div className="flex flex-col gap-5">
      {error && <Notice tone="error">{error}</Notice>}
      {note && <Notice tone="success">{note}</Notice>}
      {stepUp && (
        <Notice tone="error">
          Changing access needs a fresh sign-in check.{' '}
          <button type="button" className="font-bold underline" onClick={onReauth}>
            Verify now
          </button>
        </Notice>
      )}

      <Card
        title="What artists can see and do"
        action={<span className="src">Applies to every artist account</span>}
      >
        <div className="flex flex-wrap gap-6">
          <div className="flex min-w-0 flex-[1_1_300px] flex-col gap-1">
            <Fixed tone="n" tag="Always">
              Chat with Blueprint, announcements and the groups they're in
            </Fixed>
            {SWITCHES.slice(0, 2).map((s) => (
              <Switch
                key={s.key}
                label={s.label}
                sr={s.sr}
                on={rules[s.key]}
                disabled={!isAdmin || busy}
                onChange={(v) => setRules({ ...rules, [s.key]: v })}
              />
            ))}
            <Fixed tone="s" tag="By design">
              Artist-to-artist chats are private to the artists
            </Fixed>
          </div>
          <div className="flex min-w-0 flex-[1_1_300px] flex-col gap-1">
            <Fixed tone="n" tag="Always">
              Only files shared with them
            </Fixed>
            <Fixed tone="n" tag="Always">
              Only their own stats, to-do and gigs
            </Fixed>
            <Switch
              label={SWITCHES[2]!.label}
              sr={SWITCHES[2]!.sr}
              on={rules.artistGigSharing}
              disabled={!isAdmin || busy}
              onChange={(v) => setRules({ ...rules, artistGigSharing: v })}
            />
            <Fixed tone="c" tag="Blueprint only">
              Events, Newsroom, website stats, applications
            </Fixed>
            <Fixed tone="n" tag="Always">
              AI features (assistant, newsletter drafting, summaries) use an artist's account and
              data only if they opted in
            </Fixed>
            <Fixed tone="n" tag="Always">
              Opting out later removes their data from AI features within 24 hours
            </Fixed>
          </div>
        </div>
        <p className="src m-0">
          {rules.artistGroups && 'Groups an artist starts include Blueprint, like every group. '}
          {!rules.artistDirectChats &&
            'With direct chats off, existing chats between artists stay readable but no one can post. '}
          {saved.updatedAt
            ? `Last changed by ${saved.updatedByName ?? 'Blueprint'}, ${shortDate(saved.updatedAt)}.`
            : 'These are the starting settings.'}
        </p>
        {isAdmin ? (
          <div className="flex flex-wrap gap-2">
            <Button
              variant="cta"
              size="sm"
              disabled={!dirty || busy}
              onClick={() =>
                void run(
                  () =>
                    api(cfg, token, 'PUT', '/access/settings', {
                      version: saved.version,
                      ...rules,
                    }),
                  'Saved. Artists see the change straight away.',
                )
              }
            >
              Save
            </Button>
            {dirty && (
              <Button
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={() =>
                  setRules({
                    artistDirectChats: saved.artistDirectChats,
                    artistGroups: saved.artistGroups,
                    artistGigSharing: saved.artistGigSharing,
                  })
                }
              >
                Cancel
              </Button>
            )}
          </div>
        ) : (
          <p className="src m-0">Only an admin can change these.</p>
        )}
      </Card>

      <Card
        title="Blueprint team"
        action={
          isAdmin && !adding ? (
            <Button size="sm" variant="ghost" onClick={() => setAdding(true)}>
              Add team member
            </Button>
          ) : undefined
        }
      >
        {adding && (
          <AddMember
            artists={artists}
            busy={busy}
            onCancel={() => setAdding(false)}
            onSubmit={async (body) => {
              const ok = await run(
                () => api(cfg, token, 'POST', '/access/team', body),
                `Invited ${body.displayName}. They'll get an email with a temporary password.`,
              );
              if (ok) setAdding(false);
            }}
          />
        )}
        <DataTable
          label="Team"
          cards={team.map((m) => (
            <RowCard
              key={m.sub}
              lead={<Avatar name={m.displayName} userSub={m.sub} size={36} />}
              title={`${m.displayName}${m.sub === me.sub ? ' (you)' : ''}`}
              status={
                !m.enabled ? (
                  <Tag tone="k">Turned off</Tag>
                ) : m.status === 'FORCE_CHANGE_PASSWORD' ? (
                  <Tag tone="c">Invited</Tag>
                ) : (
                  <Tag tone="n">Active</Tag>
                )
              }
              sub={[
                ROLE_LABEL[m.role],
                m.role === 'bmg-admin'
                  ? 'All artists'
                  : m.artistIds.length === 0
                    ? 'No artists yet'
                    : `${m.artistIds.length} artist${m.artistIds.length === 1 ? '' : 's'}`,
                m.jobTitle,
              ]
                .filter(Boolean)
                .join(' · ')}
              {...(isAdmin
                ? {
                    onOpen: () => setEditing(editing === m.sub ? null : m.sub),
                    openLabel: `Edit ${m.displayName}`,
                  }
                : {})}
            />
          ))}
        >
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">Access</th>
              <th scope="col">Artists</th>
              <th scope="col">Login</th>
              {isAdmin && (
                <th scope="col">
                  <span className="sr-only">Actions</span>
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            {team.map((m) => (
              <tr key={m.sub}>
                <td>
                  <span className="flex items-center gap-3">
                    <Avatar name={m.displayName} userSub={m.sub} size={32} />
                    <span className="flex flex-col">
                      <b>
                        {m.displayName}
                        {m.sub === me.sub ? ' (you)' : ''}
                      </b>
                      <span className="src">{m.jobTitle || (isAdmin ? m.email : '')}</span>
                    </span>
                  </span>
                </td>
                <td>
                  <Tag tone={m.role === 'bmg-admin' ? 'n' : 's'}>{ROLE_LABEL[m.role]}</Tag>
                </td>
                <td>
                  {m.role === 'bmg-admin'
                    ? 'All artists'
                    : m.artistIds.length === 0
                      ? 'None yet'
                      : m.artistIds.map(artistName).join(', ')}
                </td>
                <td>
                  {!m.enabled ? (
                    <Tag tone="k">Turned off</Tag>
                  ) : m.status === 'FORCE_CHANGE_PASSWORD' ? (
                    <Tag tone="c">Invited</Tag>
                  ) : (
                    <Tag tone="n">Active</Tag>
                  )}
                </td>
                {isAdmin && (
                  <td className="text-right">
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-expanded={editing === m.sub}
                      onClick={() => setEditing(editing === m.sub ? null : m.sub)}
                    >
                      {editing === m.sub ? 'Close' : `Edit ${m.displayName.split(' ')[0]}`}
                    </Button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </DataTable>
        {isAdmin &&
          editing &&
          (() => {
            const m = team.find((x) => x.sub === editing);
            if (!m) return null;
            return (
              <EditMember
                key={m.sub}
                member={m}
                self={m.sub === me.sub}
                artists={artists}
                busy={busy}
                onSave={(patch, done) =>
                  void run(() => api(cfg, token, 'PATCH', `/access/team/${m.sub}`, patch), done)
                }
                onResend={() =>
                  void run(
                    () => api(cfg, token, 'POST', `/access/team/${m.sub}/resend`),
                    `Sent ${m.displayName} a new invitation.`,
                  )
                }
              />
            );
          })()}
        <p className="src m-0">
          Admins see every artist and change settings. Team members see only the artists they're
          given, e.g. an events coordinator or a workshop facilitator. Changing someone's access
          signs them out everywhere, so it applies at once.
        </p>
      </Card>
    </div>
  );
}

function Switch({
  label,
  sr,
  on,
  disabled,
  onChange,
}: {
  label: string;
  sr: string;
  on: boolean;
  disabled: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="li">
      <span className="flex-1">{label}</span>
      <label className="flex min-h-10 items-center gap-2">
        <span className="sr-only">{sr}</span>
        <input
          className="chk"
          type="checkbox"
          checked={on}
          disabled={disabled}
          onChange={(e) => onChange(e.target.checked)}
        />
        <span aria-hidden="true" className="w-7">
          {on ? 'On' : 'Off'}
        </span>
      </label>
    </div>
  );
}

function ArtistPicker({
  artists,
  value,
  onChange,
}: {
  artists: ArtistSummary[];
  value: string[];
  onChange: (ids: string[]) => void;
}) {
  return (
    <fieldset className="m-0 flex flex-col gap-1 border-0 p-0">
      <legend className="pb-1 text-[15px] font-bold">Artists they work with</legend>
      {artists.length === 0 && <span className="src">No artists yet.</span>}
      {artists.map((a) => (
        <label key={a.artistId} className="flex min-h-[34px] items-center gap-3">
          <input
            className="chk"
            type="checkbox"
            checked={value.includes(a.artistId)}
            onChange={(e) =>
              onChange(
                e.target.checked ? [...value, a.artistId] : value.filter((id) => id !== a.artistId),
              )
            }
          />
          {a.displayName}
        </label>
      ))}
    </fieldset>
  );
}

function AddMember({
  artists,
  busy,
  onCancel,
  onSubmit,
}: {
  artists: ArtistSummary[];
  busy: boolean;
  onCancel: () => void;
  onSubmit: (body: {
    displayName: string;
    email: string;
    role: TeamRole;
    jobTitle: string;
    artistIds: string[];
  }) => void;
}) {
  const [displayName, setName] = useState('');
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<TeamRole>('bmg-staff');
  const [jobTitle, setJobTitle] = useState('');
  const [artistIds, setArtistIds] = useState<string[]>([]);
  return (
    <form
      className="flex flex-col gap-4 rounded-lg border border-input p-4"
      aria-label="Add team member"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit({
          displayName,
          email,
          role,
          jobTitle,
          artistIds: role === 'bmg-staff' ? artistIds : [],
        });
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field
          label="Name"
          value={displayName}
          required
          maxLength={120}
          onChange={(e) => setName(e.target.value)}
        />
        <Field
          label="Email"
          type="email"
          value={email}
          required
          maxLength={254}
          onChange={(e) => setEmail(e.target.value)}
        />
        <Field
          label="Job title"
          value={jobTitle}
          maxLength={80}
          placeholder="e.g. Events coordinator"
          onChange={(e) => setJobTitle(e.target.value)}
        />
        <Select
          label="Access"
          value={role}
          options={ROLE_OPTIONS}
          onChange={(e) => setRole(e.target.value as TeamRole)}
        />
      </div>
      {role === 'bmg-staff' && (
        <ArtistPicker artists={artists} value={artistIds} onChange={setArtistIds} />
      )}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" variant="cta" size="sm" disabled={busy}>
          Send invite
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
      </div>
      <span className="src">
        They get a branded email with a temporary password. At first sign-in they choose their own
        password and set up two-step verification.
      </span>
    </form>
  );
}

function EditMember({
  member,
  self,
  artists,
  busy,
  onSave,
  onResend,
}: {
  member: Member;
  self: boolean;
  artists: ArtistSummary[];
  busy: boolean;
  onSave: (patch: Record<string, unknown>, done: string) => void;
  onResend: () => void;
}) {
  const [role, setRole] = useState<TeamRole>(member.role);
  const [jobTitle, setJobTitle] = useState(member.jobTitle);
  const [artistIds, setArtistIds] = useState<string[]>(member.artistIds);
  const first = member.displayName.split(' ')[0];
  const patch: Record<string, unknown> = {};
  if (role !== member.role) patch.role = role;
  if (jobTitle.trim() !== member.jobTitle) patch.jobTitle = jobTitle.trim();
  if (
    role === 'bmg-staff' &&
    JSON.stringify([...artistIds].sort()) !== JSON.stringify([...member.artistIds].sort())
  )
    patch.artistIds = artistIds;
  return (
    <section
      className="flex flex-col gap-4 rounded-lg border border-input p-4"
      aria-label={`Edit ${member.displayName}`}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field
          label="Job title"
          value={jobTitle}
          maxLength={80}
          onChange={(e) => setJobTitle(e.target.value)}
        />
        <Select
          label="Access"
          value={role}
          options={ROLE_OPTIONS}
          disabled={self}
          onChange={(e) => setRole(e.target.value as TeamRole)}
        />
      </div>
      {self && (
        <span className="src">You can't change your own access or turn off your own login.</span>
      )}
      {role === 'bmg-staff' && (
        <ArtistPicker artists={artists} value={artistIds} onChange={setArtistIds} />
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          variant="cta"
          size="sm"
          disabled={busy || Object.keys(patch).length === 0}
          onClick={() => onSave(patch, `Saved ${first}'s access.`)}
        >
          Save
        </Button>
        {member.status === 'FORCE_CHANGE_PASSWORD' && member.enabled && (
          <Button variant="ghost" size="sm" disabled={busy} onClick={onResend}>
            Resend invite
          </Button>
        )}
        {!self &&
          (member.enabled ? (
            <Button
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() =>
                onSave({ enabled: false }, `${first}'s login is off and they've been signed out.`)
              }
            >
              Turn off login
            </Button>
          ) : (
            <Button
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() => onSave({ enabled: true }, `${first} can sign in again.`)}
            >
              Turn login back on
            </Button>
          ))}
      </div>
    </section>
  );
}
