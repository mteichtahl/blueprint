import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type ArtistSummary } from '../lib/api.ts';
import type { AppConfig } from '../lib/config.ts';
import { download, formatSize, uploadFile, waitUntilScanned, type FileItem } from '../lib/files.ts';
import { Button, Card, Notice } from '../components/ui.tsx';

const VISIBILITY_LABEL: Record<NonNullable<FileItem['visibility']>, string> = {
  normal: 'Shared',
  'bmg-only': 'BMG only',
  private: 'Private',
};
const SHARING_LABEL: Record<NonNullable<FileItem['sharing']>, string> = {
  'bmg-only': 'BMG only',
  'all-artists': 'All artists',
  selected: 'Selected artists',
};

const date = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });

function useFiles(cfg: AppConfig, token: string, collection: string) {
  const [files, setFiles] = useState<FileItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      setFiles((await api<{ files: FileItem[] }>(cfg, token, 'GET', collection)).files);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [cfg, token, collection]);
  useEffect(() => void load(), [load]);
  return { files, error, setError, load };
}

/** Pick a file, upload it, then wait for the malware scan. */
function UploadBox({
  cfg,
  token,
  collection,
  options,
  children,
  onDone,
}: {
  cfg: AppConfig;
  token: string;
  collection: string;
  /** Extra fields for the upload request (visibility or sharing). */
  options: () => Record<string, unknown>;
  children?: React.ReactNode;
  onDone: () => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);

  async function go() {
    if (!file) return;
    setResult(null);
    try {
      setBusy('Uploading…');
      const created = await uploadFile(cfg, token, collection, file, options());
      onDone();
      setBusy('Checking for malware…');
      const settled = await waitUntilScanned(cfg, token, `${collection}/${created.fileId}`);
      setResult(
        !settled
          ? {
              tone: 'success',
              text: 'Uploaded. The scan is taking a while; the file appears when it’s done.',
            }
          : settled.status === 'available'
            ? { tone: 'success', text: `${file.name} is ready.` }
            : {
                tone: 'error',
                text: `${file.name} was not kept: ${settled.rejectReason ?? 'it failed the scan'}.`,
              },
      );
      setFile(null);
      if (input.current) input.current.value = '';
    } catch (e) {
      setResult({ tone: 'error', text: (e as Error).message });
    } finally {
      setBusy(null);
      onDone();
    }
  }

  return (
    <Card title="Upload">
      <div className="flex flex-wrap items-end gap-3">
        <label className="block space-y-1.5">
          <span className="text-sm font-semibold">File</span>
          <input
            ref={input}
            type="file"
            className="block text-sm"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          />
        </label>
        {children}
        <Button variant="cta" disabled={!file || !!busy} onClick={() => void go()}>
          {busy ?? 'Upload'}
        </Button>
      </div>
      <p className="mt-3 text-xs text-muted-foreground">
        Up to 500 MB. Every file is scanned for malware before anyone can open it.
      </p>
      {result && (
        <div className="mt-3">
          <Notice tone={result.tone}>{result.text}</Notice>
        </div>
      )}
    </Card>
  );
}

function Select({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <label className="block space-y-1.5">
      <span className="text-sm font-semibold">{label}</span>
      <select
        className="h-10 rounded-md border border-input bg-white px-2 text-sm"
        value={value}
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

function StatusBadge({ f }: { f: FileItem }) {
  if (f.status === 'available') return null;
  const pending = f.status === 'pending';
  return (
    <span
      className={`ml-2 rounded px-1.5 py-0.5 text-xs ${pending ? 'bg-secondary' : 'bg-destructive/10 text-destructive'}`}
      title={f.rejectReason ?? undefined}
    >
      {pending ? 'Scanning' : 'Rejected'}
    </span>
  );
}

function FileTable({
  files,
  empty,
  columns,
  onOpen,
}: {
  files: FileItem[] | null;
  empty: string;
  columns: { label: string; cell: (f: FileItem) => React.ReactNode }[];
  onOpen: (f: FileItem) => void;
}) {
  if (!files) return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (files.length === 0) return <p className="text-sm text-muted-foreground">{empty}</p>;
  return (
    <div className="overflow-x-auto rounded-xl border border-border bg-white">
      <table className="w-full text-sm">
        <thead className="bg-secondary text-left text-xs uppercase tracking-wide text-muted-foreground">
          <tr>
            <th className="px-4 py-2">Name</th>
            <th className="px-4 py-2">Size</th>
            {columns.map((c) => (
              <th key={c.label} className="px-4 py-2">
                {c.label}
              </th>
            ))}
            <th className="px-4 py-2">Added</th>
            <th className="px-4 py-2" />
          </tr>
        </thead>
        <tbody>
          {files.map((f) => (
            <tr key={f.fileId} className="border-t border-border">
              <td className="px-4 py-2 font-medium">
                {f.name}
                <StatusBadge f={f} />
              </td>
              <td className="px-4 py-2 text-muted-foreground">{formatSize(f.size)}</td>
              {columns.map((c) => (
                <td key={c.label} className="px-4 py-2">
                  {c.cell(f)}
                </td>
              ))}
              <td className="px-4 py-2 text-muted-foreground">{date(f.createdAt)}</td>
              <td className="px-4 py-2 text-right">
                <Button
                  variant="ghost"
                  disabled={f.status !== 'available'}
                  onClick={() => onOpen(f)}
                >
                  Open
                </Button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * One artist's files: the workspace Library tab (BMG) and the artist's own
 * Library screen. Artists can mark uploads private (only they can open them,
 * enforced by their key); BMG can keep its uploads BMG-only.
 */
export function ArtistFiles({
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
  const collection = `/artists/${artistId}/files`;
  const { files, error, setError, load } = useFiles(cfg, token, collection);
  const [visibility, setVisibility] = useState('normal');

  async function setShared(f: FileItem, shared: boolean) {
    try {
      await api(cfg, token, 'PATCH', `${collection}/${f.fileId}`, {
        visibility: shared ? 'normal' : 'bmg-only',
      });
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const open = (f: FileItem) =>
    void download(cfg, token, `${collection}/${f.fileId}`).catch((e) =>
      setError((e as Error).message),
    );

  return (
    <div className="space-y-4">
      <UploadBox
        cfg={cfg}
        token={token}
        collection={collection}
        options={() => ({ visibility })}
        onDone={() => void load()}
      >
        <Select
          label="Who can see it"
          value={visibility}
          onChange={setVisibility}
          options={
            isBmg
              ? [
                  { value: 'normal', label: 'The artist and Blueprint' },
                  { value: 'bmg-only', label: 'Blueprint only' },
                ]
              : [
                  { value: 'normal', label: 'Me and Blueprint' },
                  { value: 'private', label: 'Only me (private)' },
                ]
          }
        />
      </UploadBox>
      {error && <Notice tone="error">{error}</Notice>}
      <FileTable
        files={files}
        empty="No files yet."
        onOpen={open}
        columns={[
          {
            label: 'Who can see it',
            cell: (f) =>
              isBmg && f.uploaderRole !== 'artist' && f.status === 'available' ? (
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={f.visibility === 'normal'}
                    onChange={(e) => void setShared(f, e.target.checked)}
                  />
                  <span>Shared with artist</span>
                </label>
              ) : (
                VISIBILITY_LABEL[f.visibility ?? 'normal']
              ),
          },
          { label: 'From', cell: (f) => (f.uploaderRole === 'artist' ? 'Artist' : 'Blueprint') },
        ]}
      />
    </div>
  );
}

/**
 * BMG's document library. BMG uploads and decides per file who it's shared
 * with: nobody, every artist, or named artists. Artists see the files shared
 * with them.
 */
export function Library({
  cfg,
  token,
  isBmg,
  artists,
}: {
  cfg: AppConfig;
  token: string;
  isBmg: boolean;
  artists: ArtistSummary[];
}) {
  const collection = '/library/files';
  const { files, error, setError, load } = useFiles(cfg, token, collection);
  const [sharing, setSharing] = useState('bmg-only');
  const [editing, setEditing] = useState<FileItem | null>(null);
  const names = Object.fromEntries(artists.map((a) => [a.artistId, a.displayName]));

  const open = (f: FileItem) =>
    void download(cfg, token, `${collection}/${f.fileId}`).catch((e) =>
      setError((e as Error).message),
    );

  if (!isBmg) {
    return (
      <div className="space-y-4">
        {error && <Notice tone="error">{error}</Notice>}
        <FileTable
          files={files}
          empty="Nothing has been shared with you yet."
          onOpen={open}
          columns={[]}
        />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <UploadBox
        cfg={cfg}
        token={token}
        collection={collection}
        options={() => ({ sharing })}
        onDone={() => void load()}
      >
        <Select
          label="Share with"
          value={sharing}
          onChange={setSharing}
          options={[
            { value: 'bmg-only', label: 'Nobody yet (BMG only)' },
            { value: 'all-artists', label: 'All artists' },
          ]}
        />
      </UploadBox>
      {error && <Notice tone="error">{error}</Notice>}
      <FileTable
        files={files}
        empty="The library is empty."
        onOpen={open}
        columns={[
          {
            label: 'Shared with',
            cell: (f) => (
              <button className="text-left hover:underline" onClick={() => setEditing(f)}>
                {f.sharing === 'selected'
                  ? f.sharedWithArtistIds.map((id) => names[id] ?? 'Artist').join(', ') || 'Nobody'
                  : SHARING_LABEL[f.sharing ?? 'bmg-only']}
              </button>
            ),
          },
        ]}
      />
      {editing && (
        <ShareDialog
          file={editing}
          artists={artists}
          onClose={() => setEditing(null)}
          onSave={async (next) => {
            try {
              await api(cfg, token, 'PATCH', `${collection}/${editing.fileId}`, next);
              setEditing(null);
              await load();
            } catch (e) {
              setError((e as Error).message);
            }
          }}
        />
      )}
    </div>
  );
}

function ShareDialog({
  file,
  artists,
  onClose,
  onSave,
}: {
  file: FileItem;
  artists: ArtistSummary[];
  onClose: () => void;
  onSave: (next: { sharing: string; sharedWithArtistIds: string[] }) => Promise<void>;
}) {
  const [sharing, setSharing] = useState<string>(file.sharing ?? 'bmg-only');
  const [picked, setPicked] = useState<Set<string>>(new Set(file.sharedWithArtistIds));
  const toggle = (id: string) =>
    setPicked((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  return (
    <Card title={`Share “${file.name}”`}>
      <div className="space-y-3 text-sm">
        {(['bmg-only', 'all-artists', 'selected'] as const).map((s) => (
          <label key={s} className="flex items-center gap-2">
            <input
              type="radio"
              name="sharing"
              checked={sharing === s}
              onChange={() => setSharing(s)}
            />
            {SHARING_LABEL[s]}
          </label>
        ))}
        {sharing === 'selected' && (
          <div className="grid gap-1 pl-6 sm:grid-cols-2">
            {artists.map((a) => (
              <label key={a.artistId} className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={picked.has(a.artistId)}
                  onChange={() => toggle(a.artistId)}
                />
                {a.displayName}
              </label>
            ))}
            {artists.length === 0 && <p className="text-muted-foreground">No artists yet.</p>}
          </div>
        )}
        <div className="flex gap-2 pt-2">
          <Button
            onClick={() =>
              void onSave({
                sharing,
                sharedWithArtistIds: sharing === 'selected' ? [...picked] : [],
              })
            }
          >
            Save
          </Button>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
        </div>
      </div>
    </Card>
  );
}
