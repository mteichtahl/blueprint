import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import { api, type ArtistSummary } from '../lib/api.ts';
import type { AppConfig } from '../lib/config.ts';
import {
  download,
  EDIT_ACCESS_LABEL,
  fileTypeOf,
  formatSize,
  uploadVersion,
  waitForVersion,
  type EditAccess,
  type FileItem,
  type FileUse,
  type Person,
} from '../lib/files.ts';
import { makeThumbnail } from '../lib/thumbnail.ts';
import { FileThumb } from '../components/FileThumb.tsx';
import {
  Avatar,
  Button,
  Card,
  Field,
  Icon,
  Notice,
  shortDate,
  Tag,
  WaveLoader,
} from '../components/ui.tsx';

/**
 * A document's own pages (rev 8): tapping a document anywhere opens its
 * **detail** page (preview, owner, who can see and edit it, Download and
 * Edit). **Edit** is a page of its own: the name, who can see it, who can
 * edit it, handing it to someone else, and Delete at the bottom.
 */

const VISIBILITY_LABEL: Record<NonNullable<FileItem['visibility']>, string> = {
  normal: 'The artist and Blueprint',
  'bmg-only': 'Blueprint only',
  private: 'Only the artist (private)',
};
const SHARING_LABEL: Record<NonNullable<FileItem['sharing']>, string> = {
  'bmg-only': 'Blueprint only',
  'all-artists': 'Blueprint and all artists',
  selected: 'Blueprint and chosen artists',
};

export interface DocumentPageProps {
  cfg: AppConfig;
  token: string;
  /** The collection the document lives in: `/library/files` or `/artists/<id>/files`. */
  collection: string;
  fileId: string;
  /** What the list already knows, so the page shows at once. */
  initial?: FileItem;
  /** Library sharing: the artists it can be shared with (Blueprint only). */
  artists?: ArtistSummary[];
  /** Back to the list. */
  onBack: () => void;
  /** Something changed: refresh the list (with the document as it is now, when known). */
  onChanged: (next?: FileItem) => void;
}

function whoCanSee(f: FileItem, names: Record<string, string>): string {
  if (f.scope === 'library') {
    if (f.sharing === 'selected') {
      const who = f.sharedWithArtistIds.map((id) => names[id] ?? 'an artist').join(', ');
      return who ? `Blueprint and ${who}` : 'Blueprint only';
    }
    return SHARING_LABEL[f.sharing ?? 'bmg-only'];
  }
  return VISIBILITY_LABEL[f.visibility ?? 'normal'];
}

function whoCanEdit(f: FileItem, people: Person[] | null): string {
  if (f.editAccess === 'everyone') {
    return f.scope === 'library' ? 'Everyone at Blueprint' : EDIT_ACCESS_LABEL.everyone;
  }
  if (f.editAccess === 'owner') return 'Only the owner (locked)';
  const n = f.editorIds.length;
  if (people && n) {
    const by = new Map(people.map((p) => [p.sub, p.displayName]));
    return `The owner and ${f.editorIds.map((s) => by.get(s) ?? 'someone').join(', ')}`;
  }
  return n ? `The owner and ${n} ${n === 1 ? 'person' : 'people'}` : 'The owner and chosen people';
}

/** Badge beside the name: locked, or how many can edit it. */
function AccessBadge({ f }: { f: FileItem }) {
  if (f.locked) return <Tag tone="n">🔒 Locked</Tag>;
  if (f.editAccess === 'chosen') {
    const n = f.editorIds.length;
    return <Tag tone="s">{n ? `Editable by ${n + 1} people` : 'Owner and chosen people'}</Tag>;
  }
  return <Tag tone="s">{f.scope === 'library' ? 'Editable by Blueprint' : 'Editable by all'}</Tag>;
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 border-b border-input py-2.5 last:border-b-0 sm:flex-row sm:gap-4">
      <dt className="text-sm font-bold sm:w-40 sm:flex-none">{label}</dt>
      <dd className="min-w-0 flex-1 text-[15px] [overflow-wrap:anywhere]">{children}</dd>
    </div>
  );
}

function useDocument(cfg: AppConfig, token: string, path: string, initial?: FileItem) {
  const [file, setFile] = useState<FileItem | null>(initial ?? null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      // Where it's used, and (for its owner) who can be given edit access.
      setFile(await api<FileItem>(cfg, token, 'GET', `${path}?include=uses,people`));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [cfg, token, path]);
  useEffect(() => void load(), [load]);
  return { file, setFile, error, setError, load };
}

export function DocumentPage(props: DocumentPageProps) {
  const [editing, setEditing] = useState(false);
  const path = `${props.collection}/${props.fileId}`;
  const doc = useDocument(props.cfg, props.token, path, props.initial);
  const f = doc.file;
  // The list's copy has no people or uses; keep the last full ones across updates.
  const [people, setPeople] = useState<Person[] | null>(null);
  const [uses, setUses] = useState<Pick<FileItem, 'uses' | 'hiddenUses' | 'inUse'> | null>(null);
  useEffect(() => {
    if (f?.people) setPeople(f.people);
    if (f?.uses) setUses({ uses: f.uses, hiddenUses: f.hiddenUses ?? 0, inUse: !!f.inUse });
  }, [f]);

  if (!f) {
    return (
      <Card title="Document" action={<BackButton onClick={props.onBack} label="Library" />}>
        {doc.error ? <Notice tone="error">{doc.error}</Notice> : <WaveLoader />}
      </Card>
    );
  }
  if (editing) {
    return (
      <EditDocument
        {...props}
        file={f}
        people={people}
        onDone={(next) => {
          if (next) doc.setFile(next);
          setEditing(false);
          props.onChanged();
        }}
        onDeleted={() => {
          props.onChanged();
          props.onBack();
        }}
        uses={uses}
        onVersion={(next) => {
          doc.setFile(next);
          props.onChanged();
        }}
      />
    );
  }
  return (
    <DocumentDetail
      {...props}
      file={f}
      people={people}
      error={doc.error}
      onError={doc.setError}
      uses={uses}
      onEdit={() => setEditing(true)}
      onChanged={(next) => {
        if (next) doc.setFile(next);
        props.onChanged();
      }}
    />
  );
}

function BackButton({ onClick, label }: { onClick: () => void; label: string }) {
  return (
    <Button size="sm" variant="ghost" onClick={onClick}>
      ← {label}
    </Button>
  );
}

function DocumentDetail({
  cfg,
  token,
  collection,
  file: f,
  artists = [],
  people,
  error,
  onError,
  onBack,
  onEdit,
  onChanged,
  uses,
}: DocumentPageProps & {
  file: FileItem;
  people: Person[] | null;
  uses: Pick<FileItem, 'uses' | 'hiddenUses' | 'inUse'> | null;
  error: string | null;
  onError: (e: string | null) => void;
  onEdit: () => void;
}) {
  const names = Object.fromEntries(artists.map((a) => [a.artistId, a.displayName]));
  const path = `${collection}/${f.fileId}`;
  return (
    <Card
      title={<h2 className="t text-[19px]">Document</h2>}
      action={<BackButton onClick={onBack} label="Library" />}
    >
      <div className="flex flex-wrap items-start gap-4">
        <FileThumb
          src={f.thumbnailUrl}
          kind={f.fileType.kind}
          ext={f.fileType.ext}
          label={f.fileType.label}
          size={128}
        />
        <div className="flex min-w-0 flex-[1_1_220px] flex-col gap-1.5">
          <h3 className="t text-[22px] leading-tight [overflow-wrap:anywhere]">{f.displayName}</h3>
          {f.title && <span className="src [overflow-wrap:anywhere]">{f.name}</span>}
          <span className="src">
            {f.fileType.label} · {formatSize(f.size)}
          </span>
          <span className="flex flex-wrap gap-1.5">
            <AccessBadge f={f} />
            {f.status !== 'available' && (
              <Tag tone={f.status === 'pending' ? 's' : 'c'}>
                {f.status === 'pending' ? 'Scanning' : 'Rejected'}
              </Tag>
            )}
          </span>
        </div>
      </div>
      {f.status === 'rejected' && f.rejectReason && <Notice tone="error">{f.rejectReason}</Notice>}
      <PendingVersionNotice f={f} />
      {error && <Notice tone="error">{error}</Notice>}
      <div className="flex flex-wrap gap-2">
        <Button
          variant="navy"
          disabled={f.status !== 'available'}
          onClick={() =>
            void download(cfg, token, path).catch((e) => onError((e as Error).message))
          }
        >
          <Icon name="download" size={16} />
          Download
        </Button>
        {(f.canEdit || f.canManage) && (
          <Button variant="ghost" onClick={onEdit}>
            <Icon name="pencil" size={16} />
            Edit
          </Button>
        )}
      </div>
      <dl className="flex flex-col">
        <Row label="Owner">
          <span className="flex items-center gap-2.5">
            <Avatar name={f.ownerName} userSub={f.ownerId} />
            <span>
              <b className="block">
                {f.ownerName}
                {f.ownedByMe && ' (you)'}
              </b>
              {f.ownerJobTitle && <span className="src block">{f.ownerJobTitle}</span>}
            </span>
          </span>
        </Row>
        <Row label="Uploaded">{shortDate(f.createdAt)}</Row>
        <Row label="Version">
          {f.version > 1 ? (
            <>
              Version {f.version} · {f.versionUploadedByName}, {shortDate(f.versionCreatedAt)}
              {f.versionNote && <span className="src block">“{f.versionNote}”</span>}
            </>
          ) : (
            'Version 1'
          )}
        </Row>
        <Row label="Who can see it">{whoCanSee(f, names)}</Row>
        <Row label="Who can edit it">{whoCanEdit(f, people)}</Row>
      </dl>
      <WhereUsed uses={uses} />
      {f.versions.length > 0 && (
        <VersionHistory
          cfg={cfg}
          token={token}
          path={path}
          f={f}
          onError={onError}
          onChanged={onChanged}
        />
      )}
    </Card>
  );
}

const USE_LABEL: Record<FileUse['kind'], string> = {
  submission: 'Submission for review',
  'brand-kit': 'Brand kit',
  asset: 'Asset library',
  chat: 'Chat',
};

/** Every place the document is used; places you can't open are counted. */
function WhereUsed({ uses }: { uses: Pick<FileItem, 'uses' | 'hiddenUses'> | null }) {
  return (
    <section
      aria-labelledby="where-used"
      className="flex flex-col gap-1.5 border-t border-input pt-3"
    >
      <h3 id="where-used" className="text-[15px] font-bold">
        Where it’s used
      </h3>
      {!uses ? (
        <WaveLoader />
      ) : (uses.uses ?? []).length === 0 && !uses.hiddenUses ? (
        <p className="src">Not used anywhere yet.</p>
      ) : (
        <ul className="flex flex-col">
          {(uses.uses ?? []).map((u) => (
            <li
              key={`${u.kind}-${u.id}`}
              className="flex items-center gap-3 border-b border-input py-2 last:border-b-0"
            >
              <span className="min-w-0 flex-1">
                <b className="block [overflow-wrap:anywhere]">{u.title}</b>
                <span className="src">
                  {USE_LABEL[u.kind]}
                  {u.detail ? ` · ${u.detail}` : ''}
                </span>
              </span>
              {u.kind === 'chat' ? (
                <Tag tone="s">chat</Tag>
              ) : (
                u.blocks && <Tag tone="n">In use</Tag>
              )}
            </li>
          ))}
          {!!uses.hiddenUses && (
            <li className="src py-2">
              + {uses.hiddenUses} {uses.hiddenUses === 1 ? 'place' : 'places'} you don’t have access
              to
            </li>
          )}
        </ul>
      )}
    </section>
  );
}

/** A new version on its way, or one that wasn't kept. */
function PendingVersionNotice({ f }: { f: FileItem }) {
  const p = f.pendingVersion;
  if (!p || p.v <= f.version) return null;
  if (p.status === 'pending') {
    return (
      <Notice>
        {p.restoredFrom
          ? `Bringing back version ${p.restoredFrom} as version ${p.v}…`
          : `Version ${p.v} (${p.name}) is being checked for malware. It replaces this one when it’s clean.`}
      </Notice>
    );
  }
  return (
    <Notice tone="error">
      Version {p.v} ({p.name}) was not kept: {p.rejectReason ?? 'it failed the malware scan'}.
    </Notice>
  );
}

/**
 * Earlier versions, newest first. Each can be downloaded; people who can
 * edit the document can bring one back (it becomes the newest version).
 */
function VersionHistory({
  cfg,
  token,
  path,
  f,
  onError,
  onChanged,
}: {
  cfg: AppConfig;
  token: string;
  path: string;
  f: FileItem;
  onError: (e: string | null) => void;
  onChanged: (next?: FileItem) => void;
}) {
  const [busy, setBusy] = useState<number | null>(null);
  const restoring = f.pendingVersion?.status === 'pending';
  async function restore(v: number) {
    setBusy(v);
    onError(null);
    try {
      const next = await api<FileItem>(cfg, token, 'POST', `${path}/versions`, { restoreFrom: v });
      onChanged(next);
      const done = await waitForVersion(cfg, token, path, next.pendingVersion?.v ?? f.version + 1);
      if (done) onChanged(done);
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }
  return (
    <section
      aria-labelledby="versions"
      className="flex flex-col gap-1.5 border-t border-input pt-3"
    >
      <h3 id="versions" className="text-[15px] font-bold">
        Version history
      </h3>
      <ul className="flex flex-col">
        <li className="flex items-center gap-3 border-b border-input py-2">
          <span className="min-w-0 flex-1">
            <b className="block">Version {f.version} (current)</b>
            <span className="src">
              {f.name} · {formatSize(f.size)} · {f.versionUploadedByName},{' '}
              {shortDate(f.versionCreatedAt)}
            </span>
          </span>
        </li>
        {f.versions.map((v) => (
          <li
            key={v.v}
            className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-input py-2 last:border-b-0"
          >
            <span className="min-w-0 flex-[1_1_200px]">
              <b className="block">Version {v.v}</b>
              <span className="src block [overflow-wrap:anywhere]">
                {v.name} · {formatSize(v.size)} · {v.uploadedByName}, {shortDate(v.createdAt)}
              </span>
              {v.note && <span className="src block">“{v.note}”</span>}
            </span>
            <span className="flex gap-1.5">
              <Button
                size="sm"
                variant="ghost"
                aria-label={`Download version ${v.v}`}
                onClick={() =>
                  void download(cfg, token, path, v.v).catch((e) => onError((e as Error).message))
                }
              >
                <Icon name="download" size={15} />
                <span className="max-sm:sr-only">Download</span>
              </Button>
              {f.canEdit && (
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={`Restore version ${v.v}`}
                  disabled={restoring || busy !== null}
                  onClick={() => void restore(v.v)}
                >
                  {busy === v.v ? 'Restoring…' : 'Restore'}
                </Button>
              )}
            </span>
          </li>
        ))}
      </ul>
      <span className="src">
        Restoring makes that version the newest one; nothing is lost. Submissions for review keep
        the version that was sent.
      </span>
    </section>
  );
}

/**
 * Upload a new version (rev 8). The name, sharing, owner, who can edit it and
 * everywhere it's used stay the same; it replaces the current version once
 * the malware scan is clean.
 */
function NewVersion({
  cfg,
  token,
  path,
  f,
  onUploaded,
}: {
  cfg: AppConfig;
  token: string;
  path: string;
  f: FileItem;
  onUploaded: (next: FileItem) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [note, setNote] = useState('');
  const [thumb, setThumb] = useState<Blob | null | undefined>(null);
  const [thumbUrl, setThumbUrl] = useState<string | null>(null);
  const making = useRef<Promise<Blob | null> | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);
  const checking = f.pendingVersion?.status === 'pending' && f.pendingVersion.v > f.version;

  useEffect(() => {
    if (!thumb) {
      setThumbUrl(null);
      return;
    }
    const url = URL.createObjectURL(thumb);
    setThumbUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [thumb]);

  function pick(next: File | null) {
    setFile(next);
    setResult(null);
    if (!next) {
      setThumb(null);
      making.current = null;
      return;
    }
    setThumb(undefined);
    const p = makeThumbnail(next);
    making.current = p;
    void p.then((b) => {
      if (making.current === p) setThumb(b);
    });
  }

  async function go() {
    if (!file) return;
    setResult(null);
    try {
      setBusy('Uploading…');
      const preview = thumb === undefined ? await making.current : thumb;
      const started = await uploadVersion(cfg, token, path, file, {
        note,
        thumbnail: preview ?? null,
      });
      onUploaded(started);
      const v = started.pendingVersion?.v ?? f.version + 1;
      setBusy('Checking for malware…');
      const settled = await waitForVersion(cfg, token, path, v);
      if (settled) onUploaded(settled);
      setResult(
        !settled
          ? {
              tone: 'success',
              text: 'Uploaded. The scan is taking a while; it replaces this version when it’s done.',
            }
          : settled.version >= v
            ? { tone: 'success', text: `Version ${v} is now the current version.` }
            : {
                tone: 'error',
                text: `Version ${v} was not kept: ${settled.pendingVersion?.rejectReason ?? 'it failed the scan'}.`,
              },
      );
      pick(null);
      setNote('');
      if (input.current) input.current.value = '';
    } catch (e) {
      setResult({ tone: 'error', text: (e as Error).message });
    } finally {
      setBusy(null);
    }
  }

  const type = file ? fileTypeOf(file) : null;
  const changesType =
    !!type &&
    !!f.fileType.ext &&
    !!type.ext &&
    type.ext.toLowerCase() !== f.fileType.ext.toLowerCase();
  return (
    <section
      aria-labelledby="new-version"
      className="flex flex-col gap-3 border-t border-input pt-4"
    >
      <h3 id="new-version" className="text-[15px] font-bold">
        Upload a new version
      </h3>
      <p className="src">
        Replaces version {f.version}. The name, sharing and everywhere it’s used stay the same, and
        earlier versions are kept in the history.
      </p>
      <label className="flex min-h-[80px] cursor-pointer flex-col items-center justify-center gap-1.5 rounded-[10px] border border-dashed border-[#9AA4B0] bg-background px-4 py-3 text-center">
        {file && type ? (
          <span className="flex w-full items-center gap-3 text-left">
            <FileThumb
              src={thumbUrl}
              kind={type.kind}
              ext={type.ext}
              label={type.label}
              size={56}
              loading={thumb === undefined}
            />
            <span className="min-w-0 flex-1">
              <b className="line-clamp-2 block text-[15px] [overflow-wrap:anywhere]">{file.name}</b>
              <span className="src">
                {type.label} · {formatSize(file.size)}
              </span>
              <span className="src block underline">Choose a different file</span>
            </span>
          </span>
        ) : (
          <>
            <Icon name="upload" size={20} />
            <b className="text-[15px]">Choose the new version</b>
            <span className="src">Up to 500 MB · scanned for malware first</span>
          </>
        )}
        <input
          ref={input}
          type="file"
          className="sr-only"
          disabled={!!busy || checking}
          onChange={(e) => pick(e.target.files?.[0] ?? null)}
        />
      </label>
      {changesType && (
        <Notice>
          This version is a {type!.label}; the current one is a {f.fileType.label}.
        </Notice>
      )}
      <Field
        label="What changed? (optional)"
        value={note}
        maxLength={300}
        onChange={(e) => setNote(e.target.value)}
        placeholder="e.g. Updated set times"
      />
      {checking && !busy && (
        <Notice>A new version is still being checked. Try again in a minute.</Notice>
      )}
      <span>
        <Button variant="navy" disabled={!file || !!busy || checking} onClick={() => void go()}>
          <Icon name="upload" size={16} />
          {busy ?? 'Upload new version'}
        </Button>
      </span>
      {result && <Notice tone={result.tone}>{result.text}</Notice>}
    </section>
  );
}

/** Delete with a second click to confirm (no browser dialogs). */
function DeleteZone({
  f,
  uses,
  onDelete,
}: {
  f: FileItem;
  uses: Pick<FileItem, 'uses' | 'hiddenUses' | 'inUse'> | null;
  onDelete: () => Promise<void>;
}) {
  const blocking = (uses?.uses ?? []).filter((u) => u.blocks);
  const chats = (uses?.uses ?? []).filter((u) => u.kind === 'chat').length;
  // Blocked by places this person can't see: the server counts them in inUse.
  const hiddenBlocking = !!uses?.inUse && blocking.length === 0;
  const blocked = !!uses?.inUse;
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!confirm) return;
    const t = setTimeout(() => setConfirm(false), 6000);
    return () => clearTimeout(t);
  }, [confirm]);
  return (
    <section
      aria-labelledby="delete-doc"
      className="mt-2 flex flex-col gap-2 rounded-[10px] border border-[#E7B9B7] bg-[#FDF3F2] p-3.5"
    >
      <h3 id="delete-doc" className="text-[15px] font-bold text-[#8E2F2C]">
        Delete this document
      </h3>
      {blocked ? (
        <>
          <p className="text-sm">
            {blocking.length > 0
              ? `This document is used in ${blocking.length} ${blocking.length === 1 ? 'place' : 'places'}. Remove it from ${blocking.length === 1 ? 'there' : 'them'} before deleting.`
              : 'This document is used somewhere you can’t see.'}
          </p>
          {blocking.length > 0 && (
            <ul className="list-disc pl-5 text-sm">
              {blocking.map((u) => (
                <li key={`${u.kind}-${u.id}`}>
                  {USE_LABEL[u.kind]}: {u.title}
                  {u.detail ? ` (${u.detail})` : ''}
                </li>
              ))}
            </ul>
          )}
          {hiddenBlocking && <p className="src">Ask Blueprint to remove it there.</p>}
        </>
      ) : (
        <p className="src">
          It’s removed for everyone it’s shared with
          {chats > 0 &&
            `, and shows as “This file was deleted” in ${chats} ${chats === 1 ? 'chat' : 'chats'}`}
          . An admin can still recover it for 35 days.
        </p>
      )}
      {error && <Notice tone="error">{error}</Notice>}
      <span>
        <Button
          variant={confirm ? 'cta' : 'ghost'}
          disabled={busy || blocked || !uses}
          aria-label={confirm ? `Confirm delete ${f.displayName}` : `Delete ${f.displayName}`}
          onClick={async () => {
            if (!confirm) return setConfirm(true);
            setBusy(true);
            setError(null);
            try {
              await onDelete();
            } catch (e) {
              setError((e as Error).message);
              setBusy(false);
              setConfirm(false);
            }
          }}
        >
          <Icon name="trash" size={16} />
          {busy ? 'Deleting…' : confirm ? 'Click again to delete' : 'Delete'}
        </Button>
      </span>
    </section>
  );
}

function Radio({
  name,
  checked,
  onChange,
  children,
  disabled,
}: {
  name: string;
  checked: boolean;
  onChange: () => void;
  children: React.ReactNode;
  disabled?: boolean;
}) {
  return (
    <label className="flex min-h-9 items-center gap-2.5 text-[15px]">
      <input type="radio" name={name} checked={checked} onChange={onChange} disabled={disabled} />
      {children}
    </label>
  );
}

function Fieldset({ legend, children }: { legend: string; children: React.ReactNode }) {
  return (
    <fieldset className="flex flex-col gap-1">
      <legend className="pb-1 text-[15px] font-bold">{legend}</legend>
      {children}
    </fieldset>
  );
}

function EditDocument({
  cfg,
  token,
  collection,
  file: f,
  artists = [],
  people,
  onDone,
  onDeleted,
  onVersion,
  uses,
}: DocumentPageProps & {
  file: FileItem;
  people: Person[] | null;
  uses: Pick<FileItem, 'uses' | 'hiddenUses' | 'inUse'> | null;
  onDone: (next?: FileItem) => void;
  onDeleted: () => void;
  /** A new version was uploaded or settled: show it, stay on the Edit page. */
  onVersion: (next: FileItem) => void;
}) {
  const path = `${collection}/${f.fileId}`;
  const library = f.scope === 'library';
  const isPrivate = f.visibility === 'private';
  const [name, setName] = useState(f.title ?? '');
  const [sharing, setSharing] = useState(f.sharing ?? 'bmg-only');
  const [picked, setPicked] = useState<Set<string>>(new Set(f.sharedWithArtistIds));
  const [visibility, setVisibility] = useState(f.visibility ?? 'normal');
  const [access, setAccess] = useState<EditAccess>(f.editAccess);
  const [editors, setEditors] = useState<Set<string>>(new Set(f.editorIds));
  const [newOwner, setNewOwner] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Blueprint decides whether its own uploads are shared with the artist.
  const canSetVisibility =
    !library &&
    f.canManage &&
    f.ownerRole !== 'artist' &&
    f.uploaderRole !== 'artist' &&
    !isPrivate;

  const toggle = (set: Set<string>, id: string) => {
    const n = new Set(set);
    if (n.has(id)) n.delete(id);
    else n.add(id);
    return n;
  };

  async function save() {
    const body: Record<string, unknown> = {};
    if (f.canEdit && name.trim() !== (f.title ?? '')) body.title = name.trim();
    if (f.canManage) {
      if (library) {
        const ids = sharing === 'selected' ? [...picked] : [];
        if (
          sharing !== (f.sharing ?? 'bmg-only') ||
          ids.sort().join() !== [...f.sharedWithArtistIds].sort().join()
        ) {
          body.sharing = sharing;
          body.sharedWithArtistIds = ids;
        }
      } else if (canSetVisibility && visibility !== (f.visibility ?? 'normal')) {
        body.visibility = visibility;
      }
      const ids = access === 'chosen' ? [...editors] : [];
      if (access !== f.editAccess || ids.sort().join() !== [...f.editorIds].sort().join()) {
        body.editAccess = access;
        body.editorIds = ids;
      }
    }
    if (Object.keys(body).length === 0) return onDone();
    setBusy(true);
    setError(null);
    try {
      onDone(await api<FileItem>(cfg, token, 'PATCH', path, body));
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  async function handOver() {
    if (!newOwner) return;
    setBusy(true);
    setError(null);
    try {
      onDone(await api<FileItem>(cfg, token, 'PATCH', path, { ownerId: newOwner }));
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  return (
    <Card
      title={<h2 className="t text-[19px]">Edit document</h2>}
      action={
        <Button size="sm" variant="ghost" onClick={() => onDone()} disabled={busy}>
          ← Back
        </Button>
      }
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onDone();
        }}
      >
        <span className="flex items-center gap-3">
          <FileThumb
            src={f.thumbnailUrl}
            kind={f.fileType.kind}
            ext={f.fileType.ext}
            label={f.fileType.label}
            size={56}
          />
          <span className="min-w-0">
            <b className="block [overflow-wrap:anywhere]">{f.displayName}</b>
            <span className="src">
              {f.fileType.label} · {formatSize(f.size)}
            </span>
          </span>
        </span>

        {f.canEdit ? (
          <Field
            label="Name"
            value={name}
            maxLength={200}
            placeholder={f.name}
            onChange={(e) => setName(e.target.value)}
            hint={`Shown in lists instead of the file name. Leave blank to show the file name (${f.name}).`}
          />
        ) : (
          <Notice>🔒 This document is locked by its owner, so you can’t rename it.</Notice>
        )}

        {f.canManage && library && (
          <Fieldset legend="Who can see it">
            {(['bmg-only', 'all-artists', 'selected'] as const).map((s) => (
              <Radio key={s} name="sharing" checked={sharing === s} onChange={() => setSharing(s)}>
                {SHARING_LABEL[s]}
              </Radio>
            ))}
            {sharing === 'selected' && (
              <div className="grid gap-1 pl-7 sm:grid-cols-2">
                {artists.map((a) => (
                  <label key={a.artistId} className="flex min-h-9 items-center gap-2 text-[15px]">
                    <input
                      type="checkbox"
                      checked={picked.has(a.artistId)}
                      onChange={() => setPicked((s) => toggle(s, a.artistId))}
                    />
                    {a.displayName}
                  </label>
                ))}
                {artists.length === 0 && <p className="src">No artists yet.</p>}
              </div>
            )}
          </Fieldset>
        )}
        {canSetVisibility && (
          <Fieldset legend="Who can see it">
            {(['normal', 'bmg-only'] as const).map((v) => (
              <Radio
                key={v}
                name="visibility"
                checked={visibility === v}
                onChange={() => setVisibility(v)}
              >
                {VISIBILITY_LABEL[v]}
              </Radio>
            ))}
          </Fieldset>
        )}

        {f.canManage &&
          (isPrivate ? (
            <Notice>Private files can only be opened by you, so only you can edit them.</Notice>
          ) : (
            <Fieldset legend="Who can edit it">
              {(['owner', 'chosen', 'everyone'] as const).map((a) => (
                <Fragment key={a}>
                  <Radio name="access" checked={access === a} onChange={() => setAccess(a)}>
                    {a === 'everyone' && library ? 'Everyone at Blueprint' : EDIT_ACCESS_LABEL[a]}
                  </Radio>
                  {/* The people picker sits under "Me and chosen people". */}
                  {a === 'chosen' && (
                    <>
                      {access === 'chosen' && (
                        <div className="flex flex-col gap-1 pl-7">
                          {!people && <WaveLoader />}
                          {people?.length === 0 && (
                            <p className="src">
                              There’s nobody else who can see this document yet.
                            </p>
                          )}
                          {people?.map((p) => (
                            <label
                              key={p.sub}
                              className="flex min-h-11 items-center gap-2.5 text-[15px]"
                            >
                              <input
                                type="checkbox"
                                checked={editors.has(p.sub)}
                                onChange={() => setEditors((s) => toggle(s, p.sub))}
                              />
                              <Avatar name={p.displayName} userSub={p.sub} />
                              <span>
                                <b className="block">{p.displayName}</b>
                                {p.jobTitle && <span className="src block">{p.jobTitle}</span>}
                              </span>
                            </label>
                          ))}
                        </div>
                      )}
                    </>
                  )}
                </Fragment>
              ))}
              <span className="src">
                Editing means renaming it and uploading new versions. Only the owner changes who can
                see it, who can edit it, and deletes it.
              </span>
            </Fieldset>
          ))}

        {error && <Notice tone="error">{error}</Notice>}
        <span className="flex gap-2">
          <Button variant="cta" type="submit" disabled={busy}>
            {busy ? 'Saving…' : 'Save'}
          </Button>
          <Button variant="ghost" type="button" onClick={() => onDone()} disabled={busy}>
            Cancel
          </Button>
        </span>
      </form>

      {f.canEdit && (
        <NewVersion
          cfg={cfg}
          token={token}
          path={path}
          f={f}
          onUploaded={(next) => onVersion(next)}
        />
      )}

      {f.canManage && !isPrivate && (people?.length ?? 0) > 0 && (
        <section
          aria-labelledby="hand-over"
          className="flex flex-col gap-2 border-t border-input pt-4"
        >
          <h3 id="hand-over" className="text-[15px] font-bold">
            Transfer ownership
          </h3>
          <p className="src">
            The new owner decides who can see and edit it.
            {f.editAccess === 'chosen' && ' You stay on as an editor.'}
          </p>
          <span className="flex flex-wrap items-end gap-2">
            <label className="flex min-w-[220px] flex-1 flex-col gap-1.5">
              <span className="sr-only">New owner</span>
              <select
                className="min-h-11 w-full rounded-lg border border-input bg-white px-3 text-base shadow-xs"
                value={newOwner}
                onChange={(e) => setNewOwner(e.target.value)}
              >
                <option value="">Choose the new owner…</option>
                {people?.map((p) => (
                  <option key={p.sub} value={p.sub}>
                    {p.displayName}
                    {p.jobTitle ? ` · ${p.jobTitle}` : ''}
                  </option>
                ))}
              </select>
            </label>
            <Button variant="ghost" disabled={!newOwner || busy} onClick={() => void handOver()}>
              Transfer
            </Button>
          </span>
        </section>
      )}

      {f.canManage && (
        <DeleteZone
          f={f}
          uses={uses}
          onDelete={async () => {
            await api(cfg, token, 'DELETE', path);
            onDeleted();
          }}
        />
      )}
    </Card>
  );
}
