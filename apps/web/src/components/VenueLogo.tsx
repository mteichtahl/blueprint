import { useEffect, useState } from 'react';
import { api } from '../lib/api.ts';
import type { AppConfig } from '../lib/config.ts';

/**
 * Venue logos: shown in the venues list, on a venue and in the venue form.
 *
 * A logo is uploaded, or found on the venue's website when "Automatically get
 * logo" is on. Either way the browser shrinks it to at most 256px and saves a
 * PNG (or WebP if that's much smaller), so the server only ever stores a small
 * raster image.
 */

export interface VenueLogoRef {
  version: string;
  source: 'upload' | 'website';
  sourceUrl?: string;
}

/** Logos already fetched, by venue and version (versions change with the image). */
const cache = new Map<string, Promise<string | null>>();

function loadLogo(cfg: AppConfig, token: string, venueId: string, version: string) {
  const key = `${venueId}:${version}`;
  let p = cache.get(key);
  if (!p) {
    p = api<{ dataUrl: string }>(cfg, token, 'GET', `/venues/${venueId}/logo?v=${version}`)
      .then((r) => r.dataUrl)
      .catch(() => {
        cache.delete(key);
        return null;
      });
    cache.set(key, p);
  }
  return p;
}

/** Puts a just-saved logo straight into the cache, so it shows without a refetch. */
export function primeLogo(venueId: string, version: string, dataUrl: string) {
  cache.set(`${venueId}:${version}`, Promise.resolve(dataUrl));
}

export function Spinner({ size = 24, label }: { size?: number; label: string }) {
  return (
    <span role="status" className="inline-flex items-center justify-center">
      <span
        aria-hidden="true"
        className="inline-block animate-spin rounded-full border-[3px] border-[rgba(1,25,53,0.15)] border-t-[#011935] motion-reduce:[animation-duration:2.4s]"
        style={{ width: size, height: size }}
      />
      <span className="sr-only">{label}</span>
    </span>
  );
}

const initialsOf = (name: string) =>
  name
    .replace(/^the\s+/i, '')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join('') || '?';

/** The square a logo sits in: the image, a spinner, or the venue's initials. */
export function LogoTile({
  src,
  name,
  size = 40,
  loading = false,
  loadingLabel = 'Loading logo',
}: {
  src: string | null;
  name: string;
  size?: number;
  loading?: boolean;
  loadingLabel?: string;
}) {
  return (
    <span
      className="inline-flex flex-none items-center justify-center overflow-hidden rounded-lg border border-input bg-white"
      style={{ width: size, height: size }}
    >
      {loading ? (
        <Spinner size={Math.max(16, Math.round(size * 0.4))} label={loadingLabel} />
      ) : src ? (
        <img src={src} alt={`${name} logo`} className="h-full w-full object-contain p-[8%]" />
      ) : (
        <span
          aria-hidden="true"
          className="font-title font-bold text-muted-foreground"
          style={{ fontSize: Math.round(size * 0.36) }}
        >
          {initialsOf(name)}
        </span>
      )}
    </span>
  );
}

/** A saved venue's logo (or its initials). */
export function VenueLogo({
  cfg,
  token,
  venue,
  size = 40,
}: {
  cfg: AppConfig;
  token: string;
  venue: { venueId: string; name: string; logo: VenueLogoRef | null };
  size?: number;
}) {
  const version = venue.logo?.version;
  const [src, setSrc] = useState<string | null>(null);
  const [loading, setLoading] = useState(!!version);
  useEffect(() => {
    let live = true;
    setSrc(null);
    if (!version) {
      setLoading(false);
      return;
    }
    setLoading(true);
    void loadLogo(cfg, token, venue.venueId, version).then((d) => {
      if (!live) return;
      setSrc(d);
      setLoading(false);
    });
    return () => {
      live = false;
    };
  }, [cfg, token, venue.venueId, version]);
  return <LogoTile src={src} name={venue.name} size={size} loading={loading} />;
}

// ── Shrinking an image in the browser ────────────────────────────────────
const MAX_SIDE = 256;
const MAX_BYTES = 150 * 1024;
const bytesOf = (dataUrl: string) =>
  Math.floor(((dataUrl.length - dataUrl.indexOf(',') - 1) * 3) / 4);

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("That image couldn't be opened"));
    img.src = src;
  });
}

/**
 * Draws any image the browser can open (PNG, JPEG, GIF, WebP, ICO, SVG) onto a
 * canvas no bigger than 256px and returns a PNG (or WebP, if smaller) data URL.
 */
export async function toLogoDataUrl(src: string): Promise<string> {
  const img = await loadImage(src);
  // SVGs without a width/height report 0; give them a sensible size.
  let w = img.naturalWidth || 512;
  let h = img.naturalHeight || 512;
  for (let side = MAX_SIDE; side >= 96; side = Math.round(side * 0.75)) {
    const scale = Math.min(1, side / Math.max(w, h));
    const cw = Math.max(1, Math.round(w * scale));
    const ch = Math.max(1, Math.round(h * scale));
    const canvas = document.createElement('canvas');
    canvas.width = cw;
    canvas.height = ch;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error("This browser can't prepare the logo");
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0, cw, ch);
    const png = canvas.toDataURL('image/png');
    if (bytesOf(png) <= MAX_BYTES) return png;
    const webp = canvas.toDataURL('image/webp', 0.9);
    if (webp.startsWith('data:image/webp') && bytesOf(webp) <= MAX_BYTES) return webp;
    w = cw;
    h = ch;
  }
  throw new Error('That logo is too detailed to store. Try a simpler or smaller file.');
}

/** Is this something we can look up? (A domain, with or without https://.) */
export function lookupableUrl(website: string): string | null {
  const v = website.trim();
  if (!v) return null;
  try {
    const u = new URL(/^https?:\/\//i.test(v) ? v : `https://${v}`);
    if (!/^https?:$/.test(u.protocol) || !u.hostname.includes('.')) return null;
    return u.toString();
  } catch {
    return null;
  }
}
