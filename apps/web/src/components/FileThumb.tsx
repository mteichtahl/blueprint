import { useEffect, useState } from 'react';
import type { FileKind } from '../lib/files.ts';
import { Icon, type IconName } from './ui.tsx';

/**
 * A file's square in lists and tables: its preview image when it has one,
 * otherwise a tile for its type (PDF, DOCX, MP3…) in the brand colours.
 */

const TILE: Record<FileKind, { bg: string; fg: string; icon: IconName }> = {
  pdf: { bg: '#B5403C', fg: '#FFFFFF', icon: 'file' },
  image: { bg: '#E6E9ED', fg: '#011935', icon: 'file' },
  video: { bg: '#011935', fg: '#F1F4F7', icon: 'file' },
  audio: { bg: '#011935', fg: '#F1F4F7', icon: 'file' },
  document: { bg: '#DCE6F2', fg: '#011935', icon: 'file' },
  spreadsheet: { bg: '#5C6775', fg: '#FFFFFF', icon: 'file' },
  presentation: { bg: '#F7DEDC', fg: '#9C3532', icon: 'file' },
  archive: { bg: '#E6E9ED', fg: '#5C6775', icon: 'file' },
  text: { bg: '#F1F4F7', fg: '#5C6775', icon: 'file' },
  design: { bg: '#F7DEDC', fg: '#011935', icon: 'file' },
  other: { bg: '#E6E9ED', fg: '#011935', icon: 'file' },
};

/** Short text on the tile: the extension, else the kind. */
function badge(kind: FileKind, ext: string): string {
  if (ext && ext.length <= 4) return ext.toUpperCase();
  return (
    {
      pdf: 'PDF',
      image: 'IMG',
      video: 'VID',
      audio: 'AUD',
      document: 'DOC',
      spreadsheet: 'XLS',
      presentation: 'PPT',
      archive: 'ZIP',
      text: 'TXT',
      design: 'ART',
      other: 'FILE',
    } as const
  )[kind];
}

export function FileThumb({
  src,
  kind,
  ext,
  label,
  size = 40,
  loading = false,
}: {
  /** A preview image (signed link, or an object URL for a file not uploaded yet). */
  src: string | null;
  kind: FileKind;
  ext: string;
  /** The type in words, for screen readers ("PDF", "Word document"). */
  label: string;
  size?: number;
  /** Still making the preview. */
  loading?: boolean;
}) {
  const [broken, setBroken] = useState(false);
  useEffect(() => setBroken(false), [src]);
  const tile = TILE[kind] ?? TILE.other;
  const box = { width: size, height: size };
  if (loading) {
    return (
      <span
        role="status"
        className="inline-flex flex-none items-center justify-center rounded-lg border border-input bg-white"
        style={box}
      >
        <span
          aria-hidden="true"
          className="inline-block animate-spin rounded-full border-2 border-[rgba(1,25,53,0.15)] border-t-[#011935] motion-reduce:[animation-duration:2.4s]"
          style={{ width: size * 0.4, height: size * 0.4 }}
        />
        <span className="sr-only">Making a preview</span>
      </span>
    );
  }
  if (src && !broken) {
    return (
      <span
        className="inline-flex flex-none overflow-hidden rounded-lg border border-input bg-white"
        style={box}
      >
        <img
          src={src}
          alt=""
          loading="lazy"
          className="h-full w-full object-cover"
          onError={() => setBroken(true)}
        />
        <span className="sr-only">{label}</span>
      </span>
    );
  }
  const text = badge(kind, ext);
  return (
    <span
      className="inline-flex flex-none flex-col items-center justify-center gap-0.5 rounded-lg font-bold leading-none"
      style={{ ...box, background: tile.bg, color: tile.fg }}
      title={label}
    >
      {size >= 48 && <Icon name={tile.icon} size={Math.round(size * 0.3)} strokeWidth={2.2} />}
      <span
        aria-hidden="true"
        style={{ fontSize: Math.max(9, Math.round(size * (text.length > 3 ? 0.22 : 0.26))) }}
      >
        {text}
      </span>
      <span className="sr-only">{label}</span>
    </span>
  );
}
