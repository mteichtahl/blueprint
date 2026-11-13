import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../lib/api.ts';
import type { AppConfig } from '../lib/config.ts';
import {
  download,
  formatSize,
  linkFor,
  uploadFile,
  waitUntilScanned,
  type AssetCategory,
  type AssetMeta,
  type AssetUse,
  type FileItem,
} from '../lib/files.ts';
import {
  Button,
  Card,
  Field,
  Icon,
  Notice,
  Select,
  Tag,
  shortDate,
  WaveLoader,
} from '../components/ui.tsx';
import { useFolders } from '../components/Folders.tsx';
import { DangerArea, EditScreen } from '../components/patterns.tsx';
import { pickerLevel } from '../lib/folders.ts';

/**
 * Asset library (screens doc "Assets"): an artist's press photos, artwork,
 * logos, video and audio, with credits and usage approvals. Assets are artist
 * files with extra details, so they are scanned, encrypted and shared exactly
 * like every other file in the workspace.
 */

export const CATEGORY: Record<AssetCategory, string> = {
  'press-photo': 'Press photos',
  artwork: 'Artwork',
  logo: 'Logos',
  video: 'Video',
  audio: 'Audio',
  other: 'Other',
};
export const CATEGORY_ONE: Record<AssetCategory, string> = {
  'press-photo': 'Press photo',
  artwork: 'Artwork',
  logo: 'Logo',
  video: 'Video',
  audio: 'Audio',
  other: 'Other',
};
const USES: { id: AssetUse; label: string }[] = [
  { id: 'press', label: 'Press & media' },
  { id: 'social', label: 'Social posts' },
  { id: 'website', label: 'Blueprint website & newsletter' },
];
const STATUS: Record<AssetMeta['status'], ['n' | 'c' | 's', string]> = {
  approved: ['n', 'Approved'],
  'in-review': ['c', 'In review'],
  draft: ['s', 'Draft'],
};
const PLACEHOLDER: Record<AssetCategory, string> = {
  'press-photo': 'bg-[#011935] text-[#D3D8DE]',
  artwork: 'bg-[#E6E9ED] text-[#5C6775]',
  logo: 'bg-white text-primary border border-input',
  video: 'bg-[#5C6775] text-[#F1F4F7]',
  audio: 'bg-[#E6E9ED] text-[#5C6775]',
  other: 'bg-[#E6E9ED] text-[#5C6775]',
};

export function guessCategory(type: string): AssetCategory {
  if (type.startsWith('video/')) return 'video';
  if (type.startsWith('audio/')) return 'audio';
  if (type === 'image/svg+xml') return 'logo';
  if (type.startsWith('image/')) return 'press-photo';
  return 'other';
}

const isImage = (f: FileItem) =>
  f.contentType.startsWith('image/') && f.contentType !== 'image/svg+xml';
const titleFrom = (name: string) =>
  name
    .replace(/\.[^.]+$/, '')
    .replace(/[_-]+/g, ' ')
    .trim() || name;
const ext = (f: FileItem) => (f.name.split('.').pop() ?? '').toUpperCase();

/** Image size, read in the browser before upload. */
async function measure(file: File): Promise<{ width: number; height: number } | undefined> {
  if (!file.type.startsWith('image/') || file.type === 'image/svg+xml') return undefined;
  try {
    const bmp = await createImageBitmap(file);
    const out = { width: bmp.width, height: bmp.height };
    bmp.close();
    return out;
  } catch {
    return undefined;
  }
}

/** Short-lived links for previews, fetched once per file while the page is open. */
export function useThumbs(cfg: AppConfig, token: string, artistId: string, files: FileItem[]) {
  const [urls, setUrls] = useState<Record<string, string>>({});
  const asked = useRef(new Set<string>());
  useEffect(() => {
    for (const f of files) {
      if (f.status !== 'available' || !isImage(f) || asked.current.has(f.fileId)) continue;
      asked.current.add(f.fileId);
      void linkFor(cfg, token, `/artists/${artistId}/files/${f.fileId}`)
        .then((u) => setUrls((m) => ({ ...m, [f.fileId]: u })))
        .catch(() => undefined);
    }
  }, [cfg, token, artistId, files]);
  return urls;
}

export function useArtistFiles(cfg: AppConfig, token: string, artistId: string) {
  const [files, setFiles] = useState<FileItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      setFiles(
        (await api<{ files: FileItem[] }>(cfg, token, 'GET', `/artists/${artistId}/files`)).files,
      );
    } catch (e) {
      setError((e as Error).message);
    }
  }, [cfg, token, artistId]);
  useEffect(() => void load(), [load]);
  return { files, error, setError, load };
}

export function Thumb({
  file,
  url,
  className = '',
}: {
  file: FileItem;
  url?: string;
  className?: string;
}) {
  const cat = file.asset?.category ?? guessCategory(file.contentType);
  if (url) {
    return <img src={url} alt="" className={`aspect-square w-full object-cover ${className}`} />;
  }
  return (
    <div
      className={`flex aspect-square w-full items-center justify-center p-2 text-center text-[13px] ${PLACEHOLDER[cat]} ${className}`}
    >
      {file.status === 'pending'
        ? 'Scanning…'
        : cat === 'video'
          ? `▶ Video${file.asset?.durationSeconds ? ` · ${Math.round(file.asset.durationSeconds)}s` : ''}`
          : cat === 'audio'
            ? `Audio · ${ext(file)}`
            : CATEGORY_ONE[cat]}
    </div>
  );
}

type Filter = 'all' | AssetCategory | 'press';

export function AssetLibrary({
  cfg,
  token,
  artistId,
  artistName,
  isArtist,
  compact = false,
  onOpenBrandKit,
}: {
  cfg: AppConfig;
  token: string;
  artistId: string;
  artistName: string;
  isArtist: boolean;
  compact?: boolean;
  onOpenBrandKit?: () => void;
}) {
  const { files, error, setError, load } = useArtistFiles(cfg, token, artistId);
  const assets = useMemo(
    () => (files ?? []).filter((f) => f.asset && f.status !== 'rejected'),
    [files],
  );
  const thumbs = useThumbs(cfg, token, artistId, assets);
  const [filter, setFilter] = useState<Filter>('all');
  const [q, setQ] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);
  const [category, setCategory] = useState<AssetCategory | 'auto'>('auto');
  const [keepPrivate, setKeepPrivate] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [addAt, setAddAt] = useState<string | null>(null);
  const { list: folderList } = useFolders(cfg, token, `/artists/${artistId}/folders`);
  const picker = useRef<HTMLInputElement>(null);
  const first = artistName.split(' ')[0];

  const counts = (c: AssetCategory) => assets.filter((a) => a.asset!.category === c).length;
  const shown = assets
    .filter((a) =>
      filter === 'all'
        ? true
        : filter === 'press'
          ? a.asset!.approvedFor.includes('press') && a.asset!.status === 'approved'
          : a.asset!.category === filter,
    )
    .filter(
      (a) =>
        !q.trim() ||
        `${a.asset!.title} ${a.name} ${a.asset!.credit ?? ''}`
          .toLowerCase()
          .includes(q.trim().toLowerCase()),
    );
  const open = assets.find((a) => a.fileId === openId) ?? (compact ? undefined : shown[0]);

  async function upload(list: FileList | null, replacing?: FileItem) {
    const file = list?.[0];
    if (!file) return;
    setError(null);
    setBusy(`Uploading ${file.name}…`);
    try {
      const dims = await measure(file);
      const base = replacing?.asset;
      const asset: AssetMeta = {
        category: base?.category ?? (category === 'auto' ? guessCategory(file.type) : category),
        title: base?.title ?? titleFrom(file.name),
        ...(base?.credit ? { credit: base.credit } : {}),
        approvedFor: base?.approvedFor ?? [],
        status: base?.status === 'approved' ? 'in-review' : (base?.status ?? 'draft'),
        ...(dims ?? {}),
      };
      const created = await uploadFile(cfg, token, `/artists/${artistId}/files`, file, {
        visibility:
          replacing?.visibility === 'private' || (isArtist && keepPrivate) ? 'private' : 'normal',
        asset,
      });
      await load();
      setOpenId(created.fileId);
      setBusy('Scanning for malware…');
      const done = await waitUntilScanned(
        cfg,
        token,
        `/artists/${artistId}/files/${created.fileId}`,
      );
      if (done?.status === 'rejected')
        setError(`${file.name} was rejected: ${done.rejectReason ?? 'it failed the malware scan'}`);
      if (replacing && done?.status === 'available') {
        // The old version leaves the asset library; deleting it is only allowed for your own uploads.
        await api(
          cfg,
          token,
          'DELETE',
          `/artists/${artistId}/files/${replacing.fileId}/asset`,
        ).catch(() => undefined);
        await api(cfg, token, 'DELETE', `/artists/${artistId}/files/${replacing.fileId}`).catch(
          () => undefined,
        );
      }
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
      if (picker.current) picker.current.value = '';
    }
  }

  const otherFiles = (files ?? []).filter((f) => !f.asset && f.status === 'available');
  // Rev 10: "Add from files" browses the Library's folders, one level at a time.
  const level = pickerLevel(folderList?.folders ?? [], otherFiles, addAt);
  const parentName = level.here?.parentId
    ? (folderList?.folders.find((f) => f.folderId === level.here!.parentId)?.name ?? '…')
    : 'Library';

  return (
    <div className="flex flex-wrap items-start gap-5">
      <Card
        className="min-w-0 flex-[3_1_520px]"
        title="Asset library"
        action={
          <span className="flex flex-wrap items-center gap-2">
            <label className="flex min-h-10 items-center rounded-lg border border-input px-2.5">
              <span className="sr-only">Search assets</span>
              <input
                type="search"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder={`Search ${assets.length} asset${assets.length === 1 ? '' : 's'}`}
                className="w-40 border-0 bg-transparent text-[15px] outline-0"
              />
            </label>
            <Button
              size="sm"
              variant="cta"
              disabled={!!busy}
              onClick={() => picker.current?.click()}
            >
              Upload
            </Button>
          </span>
        }
      >
        <input
          ref={picker}
          type="file"
          className="sr-only"
          aria-label="Choose a file to add to the asset library"
          onChange={(e) => void upload(e.target.files)}
        />
        <div className="flex flex-wrap items-end gap-3">
          <Select
            label="Upload as"
            value={category}
            onChange={(e) => setCategory(e.target.value as AssetCategory | 'auto')}
            options={[
              { value: 'auto', label: 'Work it out from the file' },
              ...(Object.keys(CATEGORY_ONE) as AssetCategory[]).map((c) => ({
                value: c,
                label: CATEGORY_ONE[c],
              })),
            ]}
          />
          {isArtist && (
            <label className="flex min-h-11 items-center gap-2">
              <input
                className="chk"
                type="checkbox"
                checked={keepPrivate}
                onChange={(e) => setKeepPrivate(e.target.checked)}
              />
              Keep private (only you can see it)
            </label>
          )}
          {otherFiles.length > 0 && (
            <Button size="sm" variant="ghost" onClick={() => setAdding((v) => !v)}>
              Add from {isArtist ? 'my' : `${first}'s`} files
            </Button>
          )}
        </div>
        {adding && (
          <div className="flex flex-col rounded-lg border border-input p-2">
            {level.here && (
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setAddAt(level.here!.parentId ?? null)}
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
                className="li flex items-center gap-2 text-left"
                onClick={() => setAddAt(f.folderId)}
              >
                <Icon name="folder" size={16} />
                <span className="flex-1 font-bold">{f.name}</span>
                <span aria-hidden="true">›</span>
              </button>
            ))}
            {level.files.length === 0 && level.folders.length === 0 && (
              <p className="src">Nothing in this folder.</p>
            )}
            {level.files.map((f) => (
              <button
                key={f.fileId}
                type="button"
                className="li text-left"
                onClick={() =>
                  void api(cfg, token, 'PUT', `/artists/${artistId}/files/${f.fileId}/asset`, {
                    category: guessCategory(f.contentType),
                    title: f.title || titleFrom(f.name),
                    approvedFor: [],
                    status: 'draft',
                  })
                    .then(() => load())
                    .then(() => {
                      setAdding(false);
                      setOpenId(f.fileId);
                    })
                    .catch((e: Error) => setError(e.message))
                }
              >
                <span className="flex-1">{f.displayName}</span>
                <span className="src">{formatSize(f.size)}</span>
              </button>
            ))}
          </div>
        )}
        {busy && <Notice>{busy}</Notice>}
        {error && <Notice tone="error">{error}</Notice>}

        <nav aria-label="Filter assets" className="flex flex-wrap gap-1.5">
          {(
            [
              ['all', `All · ${assets.length}`],
              ...(['press-photo', 'artwork', 'logo', 'video', 'audio'] as AssetCategory[]).map(
                (c) => [c, `${CATEGORY[c]} · ${counts(c)}`],
              ),
              ['press', 'Approved for press'],
            ] as [Filter, string][]
          ).map(([id, label]) => (
            <Button
              key={id}
              size="sm"
              variant={filter === id ? 'navy' : 'ghost'}
              aria-pressed={filter === id}
              onClick={() => setFilter(id)}
            >
              {label}
            </Button>
          ))}
        </nav>

        {files === null ? (
          <WaveLoader />
        ) : shown.length === 0 ? (
          <p className="src">
            {assets.length === 0
              ? `No assets yet. Upload press photos, artwork, logos, video or audio${isArtist ? '' : ` for ${first}`}.`
              : 'Nothing matches.'}
          </p>
        ) : (
          <div
            className={`grid gap-3.5 ${compact ? 'grid-cols-2' : 'grid-cols-2 sm:grid-cols-3 lg:grid-cols-4'}`}
          >
            {shown.map((a) => {
              const [tone, label] =
                a.visibility === 'private' ? (['s', 'Private'] as const) : STATUS[a.asset!.status];
              const selected = open?.fileId === a.fileId;
              return (
                <button
                  key={a.fileId}
                  type="button"
                  onClick={() => setOpenId(a.fileId)}
                  aria-pressed={selected}
                  className={`flex flex-col gap-1.5 text-left ${selected ? 'outline-2 outline-offset-2 outline-[#D9534F]' : ''}`}
                >
                  <Thumb file={a} url={thumbs[a.fileId]} />
                  <b className="text-sm">{a.asset!.title}</b>
                  <Tag tone={tone}>{label}</Tag>
                </button>
              );
            })}
          </div>
        )}
      </Card>

      {open?.asset && (
        <AssetDetails
          key={open.fileId}
          cfg={cfg}
          token={token}
          artistId={artistId}
          artistName={artistName}
          file={open}
          url={thumbs[open.fileId]}
          onChanged={load}
          onReplace={(fl) => void upload(fl, open)}
          onError={setError}
          {...(onOpenBrandKit ? { onOpenBrandKit } : {})}
        />
      )}
    </div>
  );
}

function AssetDetails({
  cfg,
  token,
  artistId,
  artistName,
  file,
  url,
  onChanged,
  onReplace,
  onError,
  onOpenBrandKit,
}: {
  cfg: AppConfig;
  token: string;
  artistId: string;
  artistName: string;
  file: FileItem;
  url?: string;
  onChanged: () => Promise<void>;
  onReplace: (f: FileList | null) => void;
  onError: (m: string) => void;
  onOpenBrandKit?: () => void;
}) {
  const path = `/artists/${artistId}/files/${file.fileId}`;
  const [meta, setMeta] = useState<AssetMeta>(file.asset!);
  const [mode, setMode] = useState<'view' | 'edit'>('view');
  const [busy, setBusy] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  const [media, setMedia] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const replace = useRef<HTMLInputElement>(null);
  const saved = file.asset!;
  const dirty = JSON.stringify(meta) !== JSON.stringify(saved);
  const isMedia = file.contentType.startsWith('video/') || file.contentType.startsWith('audio/');
  const first = artistName.split(' ')[0];

  async function save() {
    setBusy(true);
    setEditError(null);
    try {
      await api(cfg, token, 'PUT', `${path}/asset`, {
        category: meta.category,
        title: meta.title.trim(),
        ...(meta.credit ? { credit: meta.credit } : {}),
        approvedFor: meta.approvedFor,
        status: meta.status,
        ...(meta.width ? { width: meta.width } : {}),
        ...(meta.height ? { height: meta.height } : {}),
        ...(meta.durationSeconds ? { durationSeconds: meta.durationSeconds } : {}),
      });
      await onChanged();
      setNote('Saved.');
      setMode('view');
    } catch (e) {
      setEditError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const toggleUse = (u: AssetUse) =>
    setMeta({
      ...meta,
      approvedFor: meta.approvedFor.includes(u)
        ? meta.approvedFor.filter((x) => x !== u)
        : [...meta.approvedFor, u],
    });

  const replaceInput = (
    <input
      ref={replace}
      type="file"
      className="sr-only"
      aria-label="Choose the replacement file"
      onChange={(e) => onReplace(e.target.files)}
    />
  );

  // P4: Edit is its own screen; removing it from assets is in the danger area.
  if (mode === 'edit') {
    return (
      <div className="min-w-0 flex-[1_1_300px]">
        <EditScreen
          title="Edit asset"
          back={{
            to: saved.title,
            onClick: () => {
              setMeta(saved);
              setMode('view');
            },
          }}
          onSave={save}
          onCancel={() => {
            setMeta(saved);
            setEditError(null);
            setMode('view');
          }}
          busy={busy}
          canSave={dirty && !!meta.title.trim()}
          error={editError}
          danger={
            <DangerArea
              title={`Remove ${saved.title} from assets`}
              action="Remove from assets"
              what="It leaves the asset library. The file itself stays in the library."
              onConfirm={async () => {
                await api(cfg, token, 'DELETE', `${path}/asset`);
                await onChanged();
              }}
            />
          }
        >
          <Field
            label="Title"
            value={meta.title}
            maxLength={120}
            required
            onChange={(e) => setMeta({ ...meta, title: e.target.value })}
          />
          <Select
            label="Kind"
            value={meta.category}
            onChange={(e) => setMeta({ ...meta, category: e.target.value as AssetCategory })}
            options={(Object.keys(CATEGORY_ONE) as AssetCategory[]).map((c) => ({
              value: c,
              label: CATEGORY_ONE[c],
            }))}
          />
          <Field
            label="Credit"
            value={meta.credit ?? ''}
            maxLength={120}
            placeholder="Photographer, designer…"
            onChange={(e) => setMeta({ ...meta, credit: e.target.value })}
          />
          {file.visibility === 'private' ? (
            <p className="src m-0">
              Private: only {first} can see this, so it can't be approved for use.
            </p>
          ) : (
            <>
              <fieldset className="m-0 flex flex-col gap-1 border-0 p-0">
                <legend className="pb-1 text-[15px] font-bold">Approved for</legend>
                {USES.map((u) => (
                  <label key={u.id} className="flex min-h-[34px] items-center gap-3">
                    <input
                      className="chk"
                      type="checkbox"
                      checked={meta.approvedFor.includes(u.id)}
                      onChange={() => toggleUse(u.id)}
                    />
                    {u.label}
                  </label>
                ))}
              </fieldset>
              <Select
                label="Status"
                value={meta.status}
                onChange={(e) =>
                  setMeta({ ...meta, status: e.target.value as AssetMeta['status'] })
                }
                options={[
                  { value: 'draft', label: 'Draft' },
                  { value: 'in-review', label: 'In review' },
                  { value: 'approved', label: 'Approved' },
                ]}
              />
            </>
          )}
          <span className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => replace.current?.click()}
            >
              Replace the file
            </Button>
            <span className="src">Uploads a new version; the details stay.</span>
          </span>
          {replaceInput}
        </EditScreen>
      </div>
    );
  }

  const approved = USES.filter((u) => saved.approvedFor.includes(u.id)).map((u) => u.label);
  const [tone, label] =
    file.visibility === 'private' ? (['s', 'Private'] as const) : STATUS[saved.status];
  return (
    <aside className="card min-w-0 flex-[1_1_300px]" aria-label="Asset details">
      {media && file.contentType.startsWith('video/') ? (
        <video src={media} controls className="aspect-[4/3] w-full bg-black" />
      ) : media && file.contentType.startsWith('audio/') ? (
        <audio src={media} controls className="w-full" />
      ) : url ? (
        <img
          src={url}
          alt={saved.title}
          className="aspect-[4/3] w-full bg-secondary object-contain"
        />
      ) : (
        <div className="aspect-[4/3] w-full">
          <Thumb file={file} className="!aspect-[4/3]" />
        </div>
      )}
      {isMedia && !media && file.status === 'available' && (
        <Button
          size="sm"
          variant="ghost"
          className="self-start"
          onClick={() =>
            void linkFor(cfg, token, path)
              .then(setMedia)
              .catch((e: Error) => onError(e.message))
          }
        >
          {file.contentType.startsWith('video/') ? 'Play video' : 'Play audio'}
        </Button>
      )}
      <span className="flex flex-wrap items-center gap-2">
        <h3 className="t min-w-0 flex-1 text-[20px] leading-tight [overflow-wrap:anywhere]">
          {saved.title}
        </h3>
        <Tag tone={tone}>{label}</Tag>
      </span>
      <div className="li">
        <span className="flex-1">Type</span>
        <b>
          {ext(file)}
          {saved.width && saved.height ? ` · ${saved.width} × ${saved.height}` : ''} ·{' '}
          {formatSize(file.size)}
        </b>
      </div>
      <div className="li">
        <span className="flex-1">Kind</span>
        <b>{CATEGORY_ONE[saved.category]}</b>
      </div>
      {saved.credit && (
        <div className="li">
          <span className="flex-1">Credit</span>
          <b>{saved.credit}</b>
        </div>
      )}
      <div className="li">
        <span className="flex-1">Uploaded by</span>
        <b>
          {file.uploadedByMe ? 'You' : file.uploaderRole === 'artist' ? first : 'Blueprint'} ·{' '}
          {shortDate(file.createdAt)}
        </b>
      </div>
      {file.visibility === 'private' ? (
        <p className="src m-0">
          Private: only {first} can see this, so it can't be approved for use.
        </p>
      ) : (
        <div className="li">
          <span className="flex-1">Approved for</span>
          <b className="text-right">{approved.length ? approved.join(', ') : 'Nothing yet'}</b>
        </div>
      )}
      {note && <Notice tone="success">{note}</Notice>}
      <div className="flex flex-wrap gap-1.5">
        <Button
          size="sm"
          variant="navy"
          disabled={file.status !== 'available'}
          onClick={() => void download(cfg, token, path).catch((e: Error) => onError(e.message))}
        >
          Download
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            setNote(null);
            setMode('edit');
          }}
        >
          <Icon name="pencil" size={16} />
          Edit
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={file.status !== 'available'}
          onClick={() =>
            void linkFor(cfg, token, path)
              .then((u) => navigator.clipboard.writeText(u))
              .then(() => setNote('Link copied. It works for 5 minutes.'))
              .catch((e: Error) => onError(e.message))
          }
        >
          Copy link (5 min)
        </Button>
      </div>
      <span className="src">
        Uses colours and logos from {first}'s{' '}
        {onOpenBrandKit ? (
          <button type="button" className="font-bold underline" onClick={onOpenBrandKit}>
            brand kit
          </button>
        ) : (
          'brand kit'
        )}
        .
      </span>
    </aside>
  );
}
