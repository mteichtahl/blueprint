import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api.ts';
import type { AppConfig } from '../lib/config.ts';
import { linkFor, type FileItem } from '../lib/files.ts';
import { Avatar, Button, Card, Chips, Notice, WaveLoader } from './ui.tsx';

/**
 * Profile picture: upload a photo, or pick an image already in the document
 * library or (artists) the asset library. Either way the browser crops it to
 * a centred square, shrinks it and re-encodes it as a JPEG, so what's saved is
 * always a small, plain raster image (the API checks it again).
 */

const SIDE = 384;
const MAX_BYTES = 150 * 1024;

/** Crops to a centred square and re-encodes; lowers the quality until it fits. */
export async function toAvatarDataUrl(blob: Blob): Promise<string> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(blob);
  } catch {
    throw new Error("That file isn't an image this browser can read. Try a JPEG or PNG.");
  }
  const side = Math.min(bitmap.width, bitmap.height);
  const canvas = document.createElement('canvas');
  canvas.width = SIDE;
  canvas.height = SIDE;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error("This browser can't prepare the picture.");
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, SIDE, SIDE);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(
    bitmap,
    (bitmap.width - side) / 2,
    (bitmap.height - side) / 2,
    side,
    side,
    0,
    0,
    SIDE,
    SIDE,
  );
  bitmap.close?.();
  for (const q of [0.88, 0.8, 0.7, 0.6, 0.5]) {
    const url = canvas.toDataURL('image/jpeg', q);
    if (((url.length - url.indexOf(',') - 1) * 3) / 4 <= MAX_BYTES) return url;
  }
  throw new Error('That picture is too detailed to save. Try a different one.');
}

type Source = 'library' | 'assets';
interface Pickable {
  file: FileItem;
  /** The file's API path (for a short-lived link). */
  path: string;
}

const isImage = (f: FileItem) => f.status === 'available' && f.contentType.startsWith('image/');

export function ProfilePicture({
  cfg,
  token,
  userName,
  artistId,
  avatar,
  onChange,
}: {
  cfg: AppConfig;
  token: string;
  userName: string;
  /** Artists can also pick from their own files and assets. */
  artistId: string | null;
  avatar: string | null;
  onChange: (avatar: string | null) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);
  const [picking, setPicking] = useState(false);

  async function save(next: string | null, done: string) {
    setMsg(null);
    try {
      const res = await api<{ avatar: string | null }>(cfg, token, 'PATCH', '/me', {
        avatar: next,
      });
      onChange(res.avatar ?? null);
      setMsg({ tone: 'success', text: done });
    } catch (e) {
      setMsg({ tone: 'error', text: (e as Error).message });
    }
  }

  async function fromBlob(blob: Blob) {
    setBusy('Saving your picture…');
    try {
      await save(await toAvatarDataUrl(blob), 'Profile picture saved.');
    } catch (e) {
      setMsg({ tone: 'error', text: (e as Error).message });
    } finally {
      setBusy(null);
    }
  }

  async function fromFile(p: Pickable) {
    setPicking(false);
    setBusy('Saving your picture…');
    try {
      const url = await linkFor(cfg, token, p.path);
      const res = await fetch(url, { mode: 'cors', credentials: 'omit' });
      if (!res.ok) throw new Error("Couldn't open that file. Please try again.");
      await save(await toAvatarDataUrl(await res.blob()), 'Profile picture saved.');
    } catch (e) {
      const m = (e as Error).message;
      setMsg({
        tone: 'error',
        text: m === 'Failed to fetch' ? "Couldn't open that file. Please try again." : m,
      });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-4">
        <Avatar
          name={userName}
          src={avatar}
          size={88}
          className="!bg-cta !text-[30px] !text-white"
        />
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <b className="text-[15px]">Profile picture</b>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="navy"
              disabled={!!busy}
              onClick={() => input.current?.click()}
            >
              Upload a photo
            </Button>
            <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => setPicking(true)}>
              {artistId ? 'Choose from library or assets' : 'Choose from library'}
            </Button>
            {avatar && (
              <Button
                size="sm"
                variant="ghost"
                disabled={!!busy}
                onClick={() => void save(null, 'Profile picture removed.')}
              >
                Remove
              </Button>
            )}
          </div>
          <span className="src">Square pictures work best; we crop to the middle.</span>
        </div>
        <input
          ref={input}
          type="file"
          accept="image/*"
          className="hidden"
          aria-label="Upload a profile picture"
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (f) void fromBlob(f);
          }}
        />
      </div>
      {busy && <WaveLoader label={busy} />}
      {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
      {picking && (
        <PicturePicker
          cfg={cfg}
          token={token}
          artistId={artistId}
          onPick={(p) => void fromFile(p)}
          onClose={() => setPicking(false)}
        />
      )}
    </div>
  );
}

/** Images from the document library and (artists) the asset library. */
function PicturePicker({
  cfg,
  token,
  artistId,
  onPick,
  onClose,
}: {
  cfg: AppConfig;
  token: string;
  artistId: string | null;
  onPick: (p: Pickable) => void;
  onClose: () => void;
}) {
  const [source, setSource] = useState<Source>('library');
  const [items, setItems] = useState<Record<Source, Pickable[]> | null>(null);
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    const shared = api<{ files: FileItem[] }>(cfg, token, 'GET', '/library/files')
      .then((r) => r.files)
      .catch(() => [] as FileItem[]);
    const own = artistId
      ? api<{ files: FileItem[] }>(cfg, token, 'GET', `/artists/${artistId}/files`)
          .then((r) => r.files)
          .catch(() => [] as FileItem[])
      : Promise.resolve([] as FileItem[]);
    Promise.all([shared, own])
      .then(([lib, mine]) => {
        if (!live) return;
        const ownPath = (f: FileItem) => ({
          file: f,
          path: `/artists/${artistId}/files/${f.fileId}`,
        });
        setItems({
          library: [
            ...mine.filter((f) => isImage(f) && !f.asset).map(ownPath),
            ...lib.filter(isImage).map((f) => ({ file: f, path: `/library/files/${f.fileId}` })),
          ],
          assets: mine.filter((f) => isImage(f) && f.asset).map(ownPath),
        });
      })
      .catch((e) => live && setError((e as Error).message));
    return () => {
      live = false;
    };
  }, [cfg, token, artistId]);

  const list = items?.[source] ?? [];
  // A short-lived link per image, asked for once each.
  const asked = useRef(new Set<string>());
  useEffect(() => {
    for (const p of items?.[source] ?? []) {
      if (asked.current.has(p.file.fileId)) continue;
      asked.current.add(p.file.fileId);
      void linkFor(cfg, token, p.path)
        .then((u) => setThumbs((m) => ({ ...m, [p.file.fileId]: u })))
        .catch(() => undefined);
    }
  }, [cfg, token, items, source]);

  return (
    <Card
      title="Choose a picture"
      action={
        <Button size="sm" variant="ghost" onClick={onClose}>
          Close
        </Button>
      }
    >
      {artistId && (
        <Chips
          value={source}
          onChange={setSource}
          label="Where from"
          options={[
            { id: 'library', label: 'Library' },
            { id: 'assets', label: 'Assets' },
          ]}
        />
      )}
      {error && <Notice tone="error">{error}</Notice>}
      {!items && !error && <WaveLoader />}
      {items && list.length === 0 && (
        <p className="src">
          No images in your {source === 'assets' ? 'asset library' : 'document library'} yet.
        </p>
      )}
      {list.length > 0 && (
        <div className="grid grid-cols-3 gap-3 sm:grid-cols-5">
          {list.map((p) => (
            <button
              key={p.file.fileId}
              type="button"
              className="flex flex-col gap-1 text-left"
              onClick={() => onPick(p)}
            >
              {thumbs[p.file.fileId] ? (
                <img
                  src={thumbs[p.file.fileId]}
                  alt=""
                  className="aspect-square w-full rounded-lg object-cover"
                />
              ) : (
                <span className="aspect-square w-full rounded-lg bg-secondary" />
              )}
              <span className="line-clamp-1 text-sm">{p.file.asset?.title ?? p.file.name}</span>
            </button>
          ))}
        </div>
      )}
    </Card>
  );
}
