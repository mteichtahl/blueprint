import { useCallback, useEffect, useState } from 'react';
import {
  api,
  SUBMISSION_TYPES,
  type ArtistSummary,
  type PlanResponse,
  type Priority,
  type SubmissionDetail,
  type SubmissionSummary,
} from '../lib/api.ts';
import type { AppConfig } from '../lib/config.ts';
import { download, type FileItem } from '../lib/files.ts';
import { Button, Card, Field, Notice } from '../components/ui.tsx';

const PRIORITY_LABEL: Record<Priority, string> = { high: 'High', medium: 'Medium', low: 'Low' };
const PRIORITY_STYLE: Record<Priority, string> = {
  high: 'bg-cta text-white',
  medium: 'bg-secondary',
  low: 'bg-white border border-border text-muted-foreground',
};
const TYPE_LABEL = Object.fromEntries(SUBMISSION_TYPES.map((t) => [t.id, t.label]));

const date = (iso: string) =>
  new Date(iso.length === 10 ? `${iso}T00:00:00` : iso).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
  });
const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

function PriorityBadge({ p }: { p: Priority }) {
  return (
    <span className={`rounded px-2 py-0.5 text-xs font-semibold ${PRIORITY_STYLE[p]}`}>
      {PRIORITY_LABEL[p]}
    </span>
  );
}

function SelectField({
  label,
  value,
  onChange,
  options,
  disabled = false,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
  disabled?: boolean;
}) {
  return (
    <label className="block space-y-1.5">
      <span className="text-sm font-semibold">{label}</span>
      <select
        className="h-10 w-full rounded-md border border-input bg-white px-2 text-sm"
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

const PRIORITY_OPTIONS = (['high', 'medium', 'low'] as const).map((p) => ({
  value: p,
  label: PRIORITY_LABEL[p],
}));

function usePhases(cfg: AppConfig, token: string, artistId: string) {
  const [phases, setPhases] = useState<{ id: string; name: string }[]>([]);
  useEffect(() => {
    api<PlanResponse>(cfg, token, 'GET', `/artists/${artistId}/plan`)
      .then((r) => setPhases(r.plan.phases.map((p) => ({ id: p.id, name: p.name }))))
      .catch(() => setPhases([]));
  }, [cfg, token, artistId]);
  return phases;
}

function useArtistFiles(cfg: AppConfig, token: string, artistId: string) {
  const [files, setFiles] = useState<FileItem[]>([]);
  useEffect(() => {
    api<{ files: FileItem[] }>(cfg, token, 'GET', `/artists/${artistId}/files`)
      .then((r) => setFiles(r.files))
      .catch(() => setFiles([]));
  }, [cfg, token, artistId]);
  return files;
}

/** The artist's "Submit for review" form. */
function SubmitForm({
  cfg,
  token,
  artistId,
  onSubmitted,
}: {
  cfg: AppConfig;
  token: string;
  artistId: string;
  onSubmitted: () => void;
}) {
  const phases = usePhases(cfg, token, artistId);
  const files = useArtistFiles(cfg, token, artistId).filter(
    (f) => f.status === 'available' && f.visibility !== 'private',
  );
  const [title, setTitle] = useState('');
  const [type, setType] = useState('demo');
  const [priority, setPriority] = useState<Priority>('medium');
  const [neededBy, setNeededBy] = useState(inDays(14));
  const [phaseId, setPhaseId] = useState('');
  const [note, setNote] = useState('');
  const [fileIds, setFileIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);

  async function submit() {
    setBusy(true);
    setMsg(null);
    try {
      await api(cfg, token, 'POST', `/artists/${artistId}/submissions`, {
        title,
        type,
        priority,
        neededBy,
        ...(phaseId ? { phaseId } : {}),
        ...(note ? { note } : {}),
        fileIds,
      });
      setTitle('');
      setNote('');
      setFileIds([]);
      setMsg({ tone: 'success', text: 'Sent to Blueprint for review.' });
      onSubmitted();
    } catch (e) {
      setMsg({ tone: 'error', text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title="Submit for review">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Title" value={title} onChange={(e) => setTitle(e.target.value)} />
        <SelectField
          label="Type"
          value={type}
          onChange={setType}
          options={SUBMISSION_TYPES.map((t) => ({ value: t.id, label: t.label }))}
        />
        <SelectField
          label="Priority"
          value={priority}
          onChange={(v) => setPriority(v as Priority)}
          options={PRIORITY_OPTIONS}
        />
        <Field
          label="Needed by"
          type="date"
          value={neededBy}
          onChange={(e) => setNeededBy(e.target.value)}
        />
        <SelectField
          label="Plan phase"
          value={phaseId}
          onChange={setPhaseId}
          options={[
            { value: '', label: 'None' },
            ...phases.map((p) => ({ value: p.id, label: p.name })),
          ]}
        />
      </div>
      <label className="mt-4 block space-y-1.5">
        <span className="text-sm font-semibold">Note</span>
        <textarea
          className="min-h-24 w-full rounded-md border border-input bg-white p-3 text-sm"
          value={note}
          maxLength={4000}
          onChange={(e) => setNote(e.target.value)}
          placeholder="What should Blueprint look at?"
        />
      </label>
      {files.length > 0 && (
        <fieldset className="mt-4 space-y-1 text-sm">
          <legend className="font-semibold">Attach files from your library</legend>
          {files.map((f) => (
            <label key={f.fileId} className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={fileIds.includes(f.fileId)}
                onChange={(e) =>
                  setFileIds((ids) =>
                    e.target.checked ? [...ids, f.fileId] : ids.filter((i) => i !== f.fileId),
                  )
                }
              />
              {f.name}
            </label>
          ))}
        </fieldset>
      )}
      <div className="mt-4 flex items-center gap-3">
        <Button variant="cta" disabled={busy || !title.trim()} onClick={() => void submit()}>
          {busy ? 'Sending…' : 'Submit'}
        </Button>
        <span className="text-xs text-muted-foreground">
          Your note is encrypted with your own key.
        </span>
      </div>
      {msg && (
        <div className="mt-3">
          <Notice tone={msg.tone}>{msg.text}</Notice>
        </div>
      )}
    </Card>
  );
}

function SubmissionTable({
  subs,
  names,
  onOpen,
  empty,
}: {
  subs: SubmissionSummary[] | null;
  names?: Record<string, string>;
  onOpen: (s: SubmissionSummary) => void;
  empty: string;
}) {
  if (!subs) return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (subs.length === 0) return <p className="text-sm text-muted-foreground">{empty}</p>;
  return (
    <div className="overflow-x-auto rounded-xl border border-border bg-white">
      <table className="w-full text-sm">
        <thead className="bg-secondary text-left text-xs uppercase tracking-wide text-muted-foreground">
          <tr>
            <th className="px-4 py-2">Priority</th>
            <th className="px-4 py-2">Needed by</th>
            {names && <th className="px-4 py-2">Artist</th>}
            <th className="px-4 py-2">Title</th>
            <th className="px-4 py-2">Type</th>
            <th className="px-4 py-2">Status</th>
          </tr>
        </thead>
        <tbody>
          {subs.map((s) => (
            <tr
              key={s.submissionId}
              className="cursor-pointer border-t border-border hover:bg-secondary/50"
              onClick={() => onOpen(s)}
            >
              <td className="px-4 py-2">
                <PriorityBadge p={s.priority} />
              </td>
              <td className="px-4 py-2">{date(s.neededBy)}</td>
              {names && <td className="px-4 py-2">{names[s.artistId] ?? 'Artist'}</td>}
              <td className="px-4 py-2 font-medium">
                <button className="text-left hover:underline">{s.title}</button>
              </td>
              <td className="px-4 py-2 text-muted-foreground">{TYPE_LABEL[s.type]}</td>
              <td className="px-4 py-2 text-muted-foreground">
                {s.status === 'open' ? 'Waiting for review' : `Reviewed ${date(s.reviewedAt!)}`}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** One submission: details, timing (editable while open), attached files and feedback. */
function SubmissionView({
  cfg,
  token,
  artistId,
  submissionId,
  isBmg,
  onBack,
  onChanged,
}: {
  cfg: AppConfig;
  token: string;
  artistId: string;
  submissionId: string;
  isBmg: boolean;
  onBack: () => void;
  onChanged: () => void;
}) {
  const path = `/artists/${artistId}/submissions/${submissionId}`;
  const [sub, setSub] = useState<SubmissionDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const files = useArtistFiles(cfg, token, artistId);
  const phases = usePhases(cfg, token, artistId);
  const load = useCallback(async () => {
    try {
      setSub(await api<SubmissionDetail>(cfg, token, 'GET', path));
    } catch (e) {
      setError((e as Error).message);
    }
  }, [cfg, token, path]);
  useEffect(() => void load(), [load]);

  async function change(patch: { priority?: string; neededBy?: string }) {
    try {
      await api(cfg, token, 'PATCH', path, patch);
      await load();
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  if (!sub)
    return error ? <Notice tone="error">{error}</Notice> : <p className="text-sm">Loading…</p>;
  const open = sub.status === 'open';
  const fileName = (id: string) => files.find((f) => f.fileId === id)?.name ?? 'File';
  const phase = phases.find((p) => p.id === sub.phaseId)?.name;

  return (
    <div className="space-y-4">
      <button className="text-sm text-muted-foreground hover:underline" onClick={onBack}>
        ← Back
      </button>
      <h2 className="font-title text-2xl">{sub.title}</h2>
      {error && <Notice tone="error">{error}</Notice>}
      {!isBmg && sub.changedByBmgAt && open && (
        <Notice>Blueprint changed the priority or date on {date(sub.changedByBmgAt)}.</Notice>
      )}
      <Card>
        <div className="grid gap-4 sm:grid-cols-3">
          <SelectField
            label="Priority"
            value={sub.priority}
            onChange={(v) => void change({ priority: v })}
            options={PRIORITY_OPTIONS}
            disabled={!open}
          />
          <Field
            label="Needed by"
            type="date"
            value={sub.neededBy}
            disabled={!open}
            onChange={(e) => e.target.value && void change({ neededBy: e.target.value })}
          />
          <div className="space-y-1.5 text-sm">
            <span className="font-semibold">Details</span>
            <p>
              {TYPE_LABEL[sub.type]}
              {phase ? ` · ${phase}` : ''} · sent {date(sub.createdAt)}
            </p>
          </div>
        </div>
        {sub.note && <p className="mt-4 whitespace-pre-wrap text-sm">{sub.note}</p>}
        {sub.fileIds.length > 0 && (
          <div className="mt-4 flex flex-wrap gap-2">
            {sub.fileIds.map((id) => (
              <Button
                key={id}
                variant="ghost"
                className="border border-border"
                onClick={() =>
                  void download(cfg, token, `/artists/${artistId}/files/${id}`).catch((e) =>
                    setError((e as Error).message),
                  )
                }
              >
                {fileName(id)}
              </Button>
            ))}
          </div>
        )}
      </Card>
      {sub.status === 'reviewed' && (
        <Card title="Feedback">
          {sub.feedback && <p className="whitespace-pre-wrap text-sm">{sub.feedback}</p>}
          <p className="mt-2 text-sm text-muted-foreground">
            {sub.feedbackTodoIds.length
              ? `${sub.feedbackTodoIds.length} action point${sub.feedbackTodoIds.length === 1 ? '' : 's'} added to the to-do list.`
              : 'No action points.'}
          </p>
        </Card>
      )}
      {isBmg && open && (
        <FeedbackForm
          cfg={cfg}
          token={token}
          path={path}
          onDone={() => {
            void load();
            onChanged();
          }}
        />
      )}
    </div>
  );
}

/** "Provide feedback": a comment plus action points that become the artist's to-dos. */
function FeedbackForm({
  cfg,
  token,
  path,
  onDone,
}: {
  cfg: AppConfig;
  token: string;
  path: string;
  onDone: () => void;
}) {
  const [comment, setComment] = useState('');
  const [points, setPoints] = useState<{ title: string; due: string }[]>([{ title: '', due: '' }]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const filled = points.filter((p) => p.title.trim());
  const update = (i: number, patch: Partial<{ title: string; due: string }>) =>
    setPoints((ps) => ps.map((p, j) => (j === i ? { ...p, ...patch } : p)));

  async function send() {
    setBusy(true);
    setError(null);
    try {
      await api(cfg, token, 'POST', `${path}/feedback`, {
        comment,
        points: filled.map((p) => ({ title: p.title.trim(), ...(p.due ? { due: p.due } : {}) })),
      });
      onDone();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title="Provide feedback">
      <textarea
        className="min-h-24 w-full rounded-md border border-input bg-white p-3 text-sm"
        placeholder="Overall feedback for the artist"
        value={comment}
        maxLength={4000}
        onChange={(e) => setComment(e.target.value)}
      />
      <p className="mt-4 text-sm font-semibold">Action points (each becomes a to-do)</p>
      <div className="mt-2 space-y-2">
        {points.map((p, i) => (
          <div key={i} className="flex gap-2">
            <input
              className="h-10 flex-1 rounded-md border border-input bg-white px-3 text-sm"
              placeholder={`Action point ${i + 1}`}
              value={p.title}
              maxLength={200}
              onChange={(e) => update(i, { title: e.target.value })}
            />
            <input
              type="date"
              aria-label="Due"
              className="h-10 rounded-md border border-input bg-white px-2 text-sm"
              value={p.due}
              onChange={(e) => update(i, { due: e.target.value })}
            />
          </div>
        ))}
      </div>
      <div className="mt-3 flex gap-2">
        <Button
          variant="ghost"
          disabled={points.length >= 20}
          onClick={() => setPoints((ps) => [...ps, { title: '', due: '' }])}
        >
          + Add point
        </Button>
        <Button
          variant="cta"
          disabled={busy || (!comment.trim() && filled.length === 0)}
          onClick={() => void send()}
        >
          {busy ? 'Sending…' : 'Send feedback'}
        </Button>
      </div>
      {error && (
        <div className="mt-3">
          <Notice tone="error">{error}</Notice>
        </div>
      )}
    </Card>
  );
}

/** One artist's submissions: the artist's own screen, and the BMG workspace tab. */
export function ArtistSubmissions({
  cfg,
  token,
  artistId,
  isBmg,
}: {
  cfg: AppConfig;
  token: string;
  artistId: string;
  isBmg: boolean;
}) {
  const [subs, setSubs] = useState<SubmissionSummary[] | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      setSubs(
        (
          await api<{ submissions: SubmissionSummary[] }>(
            cfg,
            token,
            'GET',
            `/artists/${artistId}/submissions`,
          )
        ).submissions,
      );
    } catch (e) {
      setError((e as Error).message);
    }
  }, [cfg, token, artistId]);
  useEffect(() => void load(), [load]);

  if (openId) {
    return (
      <SubmissionView
        cfg={cfg}
        token={token}
        artistId={artistId}
        submissionId={openId}
        isBmg={isBmg}
        onBack={() => setOpenId(null)}
        onChanged={() => void load()}
      />
    );
  }
  return (
    <div className="space-y-4">
      {!isBmg && (
        <SubmitForm cfg={cfg} token={token} artistId={artistId} onSubmitted={() => void load()} />
      )}
      {error && <Notice tone="error">{error}</Notice>}
      <SubmissionTable
        subs={subs}
        onOpen={(s) => setOpenId(s.submissionId)}
        empty={isBmg ? 'Nothing submitted yet.' : 'You haven’t submitted anything yet.'}
      />
    </div>
  );
}

/** BMG's review queue: sorted by priority, then date needed. */
export function ReviewQueue({
  cfg,
  token,
  artists,
}: {
  cfg: AppConfig;
  token: string;
  artists: ArtistSummary[];
}) {
  const [status, setStatus] = useState<'open' | 'reviewed'>('open');
  const [subs, setSubs] = useState<SubmissionSummary[] | null>(null);
  const [opened, setOpened] = useState<SubmissionSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const names = Object.fromEntries(artists.map((a) => [a.artistId, a.displayName]));
  const load = useCallback(async () => {
    try {
      setSubs(
        (
          await api<{ submissions: SubmissionSummary[] }>(
            cfg,
            token,
            'GET',
            `/review-queue?status=${status}`,
          )
        ).submissions,
      );
    } catch (e) {
      setError((e as Error).message);
    }
  }, [cfg, token, status]);
  useEffect(() => void load(), [load]);

  if (opened) {
    return (
      <SubmissionView
        cfg={cfg}
        token={token}
        artistId={opened.artistId}
        submissionId={opened.submissionId}
        isBmg
        onBack={() => setOpened(null)}
        onChanged={() => void load()}
      />
    );
  }
  return (
    <div className="space-y-4">
      <div className="flex gap-1 border-b border-border" role="tablist">
        {(['open', 'reviewed'] as const).map((s) => (
          <button
            key={s}
            role="tab"
            aria-selected={status === s}
            onClick={() => {
              setSubs(null);
              setStatus(s);
            }}
            className={`-mb-px border-b-2 px-3 py-2 text-sm font-semibold ${status === s ? 'border-accent' : 'border-transparent text-muted-foreground'}`}
          >
            {s === 'open' ? 'Waiting for review' : 'Reviewed'}
          </button>
        ))}
      </div>
      {error && <Notice tone="error">{error}</Notice>}
      <SubmissionTable
        subs={subs}
        names={names}
        onOpen={setOpened}
        empty={status === 'open' ? 'Nothing waiting for review.' : 'Nothing reviewed yet.'}
      />
    </div>
  );
}
