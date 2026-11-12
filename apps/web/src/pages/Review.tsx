import { BackLink } from '../components/patterns.tsx';
import { useCallback, useEffect, useRef, useState } from 'react';
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
import { download, formatSize, uploadFile, waitUntilScanned, type FileItem } from '../lib/files.ts';
import { pickerLevel } from '../lib/folders.ts';
import { useFolders } from '../components/Folders.tsx';
import {
  Avatar,
  Button,
  Card,
  Chips,
  DataTable,
  Field,
  Icon,
  Notice,
  RowCard,
  shortDate,
  Tag,
  WaveLoader,
} from '../components/ui.tsx';

const PRIORITY_LABEL: Record<Priority, string> = { high: 'High', medium: 'Medium', low: 'Low' };
/** Canvas badge colours: High deep coral, Medium coral tint, Low slate. */
export const PRIORITY_TAG: Record<Priority, readonly ['k' | 'c' | 's', string]> = {
  high: ['k', 'High'],
  medium: ['c', 'Medium'],
  low: ['s', 'Low'],
};
const TYPE_LABEL = Object.fromEntries(SUBMISSION_TYPES.map((t) => [t.id, t.label]));

const date = shortDate;
const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

/** Where a review stands, in words. */
function reviewState(s: SubmissionSummary): string {
  if (s.status === 'reviewed') return `Completed ${date(s.reviewedAt!)}`;
  return s.feedbackAt ? 'Feedback sent · review open' : 'Waiting for review';
}

function PriorityBadge({ p }: { p: Priority }) {
  return <Tag tone={PRIORITY_TAG[p][0]}>{PRIORITY_TAG[p][1]}</Tag>;
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
      <span className="text-[15px] font-bold">{label}</span>
      <select
        className="min-h-11 w-full rounded-lg border border-input bg-white px-3 text-base shadow-xs"
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
  const reload = useCallback(async () => {
    try {
      setFiles(
        (await api<{ files: FileItem[] }>(cfg, token, 'GET', `/artists/${artistId}/files`)).files,
      );
    } catch {
      setFiles([]);
    }
  }, [cfg, token, artistId]);
  useEffect(() => void reload(), [reload]);
  return { files, reload };
}

/**
 * Files for a submission: pick any ready upload from the library, or upload a
 * new one here. A new upload is scanned for malware first, then ticked.
 * Private files can't be attached (Blueprint can't open them).
 */
function AttachFiles({
  cfg,
  token,
  artistId,
  files,
  reload,
  selected,
  onChange,
}: {
  cfg: AppConfig;
  token: string;
  artistId: string;
  files: FileItem[];
  reload: () => Promise<void>;
  selected: string[];
  onChange: (ids: string[]) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);
  const usable = files
    .filter((f) => f.status === 'available' && f.visibility !== 'private')
    // The artist's own uploads first, newest first.
    .sort(
      (a, b) =>
        Number(b.uploadedByMe) - Number(a.uploadedByMe) || b.createdAt.localeCompare(a.createdAt),
    );
  const toggle = (id: string, on: boolean) =>
    onChange(on ? [...selected, id] : selected.filter((i) => i !== id));
  // Rev 10: browse the Library's folders, one level at a time.
  const { list: folderList } = useFolders(cfg, token, `/artists/${artistId}/folders`);
  const [at, setAt] = useState<string | null>(null);
  const level = pickerLevel(folderList?.folders ?? [], usable, at);
  const parentName = level.here?.parentId
    ? (folderList?.folders.find((f) => f.folderId === level.here!.parentId)?.name ?? '…')
    : 'My library';

  async function upload(file: File) {
    setMsg(null);
    try {
      setBusy(`Uploading ${file.name}…`);
      const created = await uploadFile(cfg, token, `/artists/${artistId}/files`, file, {
        visibility: 'normal',
      });
      setBusy('Checking for malware…');
      const settled = await waitUntilScanned(
        cfg,
        token,
        `/artists/${artistId}/files/${created.fileId}`,
      );
      await reload();
      if (settled?.status === 'available') {
        if (selected.length < 10) onChange([...selected, created.fileId]);
        setMsg({ tone: 'success', text: `${file.name} is ready and attached.` });
      } else if (!settled) {
        setMsg({
          tone: 'success',
          text: 'Uploaded. The scan is taking a while; tick the file once it shows here.',
        });
      } else {
        setMsg({
          tone: 'error',
          text: `${file.name} was not kept: ${settled.rejectReason ?? 'it failed the scan'}.`,
        });
      }
    } catch (e) {
      setMsg({ tone: 'error', text: (e as Error).message });
    } finally {
      setBusy(null);
      if (input.current) input.current.value = '';
    }
  }

  return (
    <fieldset className="mt-4 flex flex-col gap-2 text-[15px]">
      <legend className="mb-1 font-bold">Files</legend>
      {usable.length === 0 ? (
        <p className="src">No files in your library yet. Upload one below.</p>
      ) : (
        <div className="flex max-h-72 flex-col gap-1 overflow-y-auto rounded-lg border border-input p-2">
          {level.here && (
            <div className="flex items-center gap-2 px-1">
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => setAt(level.here!.parentId ?? null)}
              >
                ← {parentName}
              </Button>
              <b className="min-w-0 truncate">{level.here.name}</b>
            </div>
          )}
          {level.folders.map((f) => (
            <button
              key={f.folderId}
              type="button"
              onClick={() => setAt(f.folderId)}
              className="flex min-h-9 items-center gap-2.5 rounded-md px-1 text-left hover:bg-[#F6F8FA] dark:hover:bg-secondary"
            >
              <Icon name="folder" size={16} />
              <span className="min-w-0 flex-1 truncate font-bold">{f.name}</span>
              <span aria-hidden="true">›</span>
            </button>
          ))}
          {level.files.length === 0 && level.folders.length === 0 && (
            <p className="src px-1">Nothing in this folder.</p>
          )}
          {level.files.map((f) => (
            <label key={f.fileId} className="flex min-h-9 items-center gap-2.5 px-1">
              <input
                type="checkbox"
                className="chk"
                checked={selected.includes(f.fileId)}
                disabled={!selected.includes(f.fileId) && selected.length >= 10}
                onChange={(e) => toggle(f.fileId, e.target.checked)}
              />
              <span className="min-w-0 flex-1 truncate">{f.displayName}</span>
              <span className="src whitespace-nowrap">
                {f.uploadedByMe ? 'Your upload' : 'From Blueprint'} · {formatSize(f.size)}
              </span>
            </label>
          ))}
        </div>
      )}
      <label className="flex min-h-11 cursor-pointer items-center justify-center gap-2 rounded-lg border border-dashed border-[#9AA4B0] bg-background px-3 text-[15px] font-bold">
        <Icon name="upload" size={16} />
        {busy ?? 'Upload a new file'}
        <input
          ref={input}
          type="file"
          className="sr-only"
          disabled={!!busy}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void upload(f);
          }}
        />
      </label>
      <span className="src">
        {selected.length} of 10 attached · private files can’t be attached, as Blueprint can’t open
        them.
      </span>
      {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
    </fieldset>
  );
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
  const { files, reload } = useArtistFiles(cfg, token, artistId);
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
        <span className="text-[15px] font-bold">Note</span>
        <textarea
          className="min-h-24 w-full rounded-lg border border-input bg-white p-3 text-base shadow-xs"
          value={note}
          maxLength={4000}
          onChange={(e) => setNote(e.target.value)}
          placeholder="What should Blueprint look at?"
        />
      </label>
      <AttachFiles
        cfg={cfg}
        token={token}
        artistId={artistId}
        files={files}
        reload={reload}
        selected={fileIds}
        onChange={setFileIds}
      />
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
  if (!subs) return <WaveLoader />;
  if (subs.length === 0) return <p className="src pb-5">{empty}</p>;
  return (
    <>
      <DataTable
        label="Submissions"
        cards={subs.map((s) => (
          <RowCard
            key={s.submissionId}
            title={s.title}
            status={<PriorityBadge p={s.priority} />}
            sub={[
              names ? (names[s.artistId] ?? 'Artist') : '',
              TYPE_LABEL[s.type],
              s.fileIds.length
                ? `${s.fileIds.length} file${s.fileIds.length === 1 ? '' : 's'}`
                : '',
            ]
              .filter(Boolean)
              .join(' · ')}
            tags={
              <span className="src">
                {s.status === 'open' && !s.feedbackAt
                  ? `Needed by ${date(s.neededBy)}`
                  : reviewState(s)}
              </span>
            }
            onOpen={() => onOpen(s)}
          />
        ))}
      >
        <thead>
          <tr>
            <th scope="col">Upload</th>
            {names && <th scope="col">Artist</th>}
            <th scope="col">Priority</th>
            <th scope="col">Needed by</th>
            <th scope="col">Status</th>
          </tr>
        </thead>
        <tbody>
          {subs.map((s) => (
            <tr key={s.submissionId} className="cursor-pointer" onClick={() => onOpen(s)}>
              <td>
                <button type="button" className="text-left">
                  <b className="block">{s.title}</b>
                  <span className="src">
                    {TYPE_LABEL[s.type]}
                    {s.fileIds.length
                      ? ` · ${s.fileIds.length} file${s.fileIds.length === 1 ? '' : 's'}`
                      : ''}
                  </span>
                </button>
              </td>
              {names && (
                <td>
                  <span className="flex items-center gap-2">
                    <Avatar name={names[s.artistId] ?? 'Artist'} artistId={s.artistId} size={28} />
                    {names[s.artistId] ?? 'Artist'}
                  </span>
                </td>
              )}
              <td>
                <PriorityBadge p={s.priority} />
              </td>
              <td>{date(s.neededBy)}</td>
              <td className="src">{reviewState(s)}</td>
            </tr>
          ))}
        </tbody>
      </DataTable>
      <div className="flex items-center py-3 text-[15px]">
        <b>{subs.length}</b>&nbsp;<span className="text-muted-foreground">submissions</span>
      </div>
    </>
  );
}

/** One submission: details, timing (editable while open), attached files and feedback. */
function SubmissionView({
  cfg,
  token,
  artistId,
  submissionId,
  isBmg,
  backTo,
  onBack,
  onChanged,
}: {
  cfg: AppConfig;
  token: string;
  artistId: string;
  submissionId: string;
  isBmg: boolean;
  /** P8: the page Back goes to ("Review queue", "Submissions"). */
  backTo: string;
  onBack: () => void;
  onChanged: () => void;
}) {
  const path = `/artists/${artistId}/submissions/${submissionId}`;
  const [sub, setSub] = useState<SubmissionDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { files } = useArtistFiles(cfg, token, artistId);
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

  if (!sub) return error ? <Notice tone="error">{error}</Notice> : <WaveLoader />;
  const open = sub.status === 'open';
  const fileName = (id: string) => files.find((f) => f.fileId === id)?.name ?? 'File';
  const phase = phases.find((p) => p.id === sub.phaseId)?.name;

  return (
    <div className="space-y-4">
      <BackLink to={backTo} onClick={onBack} />
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
            {sub.fileIds.map((id) => {
              // The version that was sent stays what was submitted (rev 8).
              const file = files.find((f) => f.fileId === id);
              const sent = sub.fileVersions?.[id] ?? 1;
              const newer = !!file && file.version > sent;
              const kept = !newer || file.versions.some((v) => v.v === sent);
              const path = `/artists/${artistId}/files/${id}`;
              return (
                <span key={id} className="flex flex-col gap-0.5">
                  <Button
                    variant="ghost"
                    className="border border-border"
                    disabled={!file || !kept}
                    onClick={() =>
                      void download(cfg, token, path, newer ? sent : undefined).catch((e) =>
                        setError((e as Error).message),
                      )
                    }
                  >
                    {file ? fileName(id) : 'This file was deleted'}
                  </Button>
                  {newer && (
                    <span className="src">
                      Version {sent} as sent · a newer version exists
                      {!kept && ' (this one is no longer kept)'}
                    </span>
                  )}
                </span>
              );
            })}
          </div>
        )}
      </Card>
      {sub.status === 'reviewed' && (
        <Notice tone="success">
          Review completed {date(sub.reviewedAt!)}.
          {isBmg ? ' The person who asked for it has been told.' : ''}
        </Notice>
      )}
      {(sub.feedbackAt || sub.feedback) && (
        <Card title="Feedback">
          {sub.feedback && <p className="whitespace-pre-wrap text-sm">{sub.feedback}</p>}
          <p className="mt-2 text-sm text-muted-foreground">
            {sub.feedbackTodoIds.length
              ? `${sub.feedbackTodoIds.length} action point${sub.feedbackTodoIds.length === 1 ? '' : 's'} added to the to-do list.`
              : 'No action points.'}
          </p>
        </Card>
      )}
      {isBmg && open && !sub.feedbackAt && (
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
      {isBmg && open && (
        <CompleteReview
          cfg={cfg}
          token={token}
          path={path}
          hasFeedback={!!sub.feedbackAt}
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
  // Most feedback finishes the review; untick to keep it open for another look.
  const [complete, setComplete] = useState(true);
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
        complete,
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
        className="min-h-24 w-full rounded-lg border border-input bg-white p-3 text-base shadow-xs"
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
      <label className="mt-4 flex min-h-9 items-center gap-2.5 text-[15px]">
        <input
          type="checkbox"
          className="chk"
          checked={complete}
          onChange={(e) => setComplete(e.target.checked)}
        />
        Complete the review when I send this
      </label>
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
          {busy ? 'Sending…' : complete ? 'Send feedback and complete' : 'Send feedback'}
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

/**
 * Complete review: ends the review (with or without feedback) and tells whoever
 * asked for it. Feedback can't be added afterwards.
 */
function CompleteReview({
  cfg,
  token,
  path,
  hasFeedback,
  onDone,
}: {
  cfg: AppConfig;
  token: string;
  path: string;
  hasFeedback: boolean;
  onDone: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <Card title="Complete review">
      <p className="m-0 text-sm">
        {hasFeedback
          ? 'Your feedback has been sent. Complete the review when you’re done with it.'
          : 'Done with this one? Complete it without feedback, or send feedback above first.'}{' '}
        Whoever asked for the review is told it’s complete.
      </p>
      <div className="mt-3">
        <Button
          variant={hasFeedback ? 'cta' : 'ghost'}
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setError(null);
            try {
              await api(cfg, token, 'PATCH', path, { complete: true });
              onDone();
            } catch (e) {
              setError((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? 'Completing…' : 'Complete review'}
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
  open,
}: {
  cfg: AppConfig;
  token: string;
  artistId: string;
  isBmg: boolean;
  /** Open this submission straight away (a link from a document's "Where it's used"). */
  open?: { submissionId: string; n: number } | null;
}) {
  const [subs, setSubs] = useState<SubmissionSummary[] | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  useEffect(() => {
    if (open) setOpenId(open.submissionId);
  }, [open]);
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
        backTo="Submissions"
        onBack={() => setOpenId(null)}
        onChanged={() => void load()}
      />
    );
  }
  if (isBmg) {
    return (
      <Card
        className="pb-0"
        title="Submissions"
        action={<span className="src">Priority, then date needed</span>}
      >
        {error && <Notice tone="error">{error}</Notice>}
        <SubmissionTable
          subs={subs}
          onOpen={(s) => setOpenId(s.submissionId)}
          empty="Nothing submitted yet."
        />
      </Card>
    );
  }
  // Artist phone: the form first, then their submissions as cards.
  return (
    <div className="flex flex-col gap-3">
      <SubmitForm cfg={cfg} token={token} artistId={artistId} onSubmitted={() => void load()} />
      {error && <Notice tone="error">{error}</Notice>}
      <div className="eyebrow pt-2 text-muted-foreground">My submissions</div>
      {subs?.length === 0 && <p className="src">You haven’t submitted anything yet.</p>}
      {subs?.map((s) => (
        <button
          key={s.submissionId}
          type="button"
          onClick={() => setOpenId(s.submissionId)}
          className="flex min-h-[52px] items-center gap-3 rounded-[10px] border border-input bg-card px-3 py-2.5 text-left shadow-xs"
        >
          <span className="min-w-0 flex-1">
            <b className="block">{s.title}</b>
            <span className="src">
              {TYPE_LABEL[s.type]} ·{' '}
              {s.status === 'reviewed'
                ? 'Review complete'
                : s.feedbackAt
                  ? 'Feedback ready'
                  : `needed by ${date(s.neededBy)}`}
            </span>
          </span>
          {s.status === 'open' ? <PriorityBadge p={s.priority} /> : <Tag tone="n">Completed</Tag>}
        </button>
      ))}
    </div>
  );
}

/** BMG's review queue: sorted by priority, then date needed. */
export function ReviewQueue({
  cfg,
  token,
  artists,
  onChanged,
  open,
  onClosed,
}: {
  cfg: AppConfig;
  token: string;
  artists: ArtistSummary[];
  /** Lets the shell refresh its queue badge. */
  onChanged?: () => void;
  /** Open this submission straight away (a document's "Where it's used" link). */
  open?: { artistId: string; submissionId: string } | null;
  /** The submission opened from a link was closed. */
  onClosed?: () => void;
}) {
  const [status, setStatus] = useState<'open' | 'reviewed'>('open');
  const [subs, setSubs] = useState<SubmissionSummary[] | null>(null);
  const [opened, setOpened] = useState<Pick<SubmissionSummary, 'artistId' | 'submissionId'> | null>(
    null,
  );
  useEffect(() => {
    if (open) setOpened(open);
  }, [open]);
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
        backTo="Review queue"
        onBack={() => {
          setOpened(null);
          onClosed?.();
        }}
        onChanged={() => {
          void load();
          onChanged?.();
        }}
      />
    );
  }
  return (
    <Card
      className="pb-0"
      title={
        <Chips
          label="Show"
          value={status}
          onChange={(v) => {
            setSubs(null);
            setStatus(v);
          }}
          options={[
            { id: 'open', label: 'Waiting for review' },
            { id: 'reviewed', label: 'Completed' },
          ]}
        />
      }
    >
      {error && <Notice tone="error">{error}</Notice>}
      <SubmissionTable
        subs={subs}
        names={names}
        onOpen={setOpened}
        empty={status === 'open' ? 'Nothing waiting for review.' : 'No completed reviews yet.'}
      />
    </Card>
  );
}
