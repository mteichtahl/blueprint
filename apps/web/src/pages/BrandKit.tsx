import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, ApiError } from '../lib/api.ts';
import type { AppConfig } from '../lib/config.ts';
import type { FileItem } from '../lib/files.ts';
import {
  Button,
  Card,
  Field,
  Notice,
  Select,
  Tag,
  TextArea,
  shortDate,
  WaveLoader,
} from '../components/ui.tsx';
import { Thumb, useArtistFiles, useThumbs } from './Assets.tsx';

/**
 * Brand kit (screens doc "Brand kit"): logos, colours, fonts, voice and
 * language, socials and imagery. The artist and Blueprint both edit one kit,
 * and Blueprint uses it for posts, press kits and the website.
 */

type Role = 'primary' | 'background' | 'accent' | 'text' | 'other';
interface Kit {
  version: number;
  logos: { fileId: string; label: string }[];
  logoRules: string;
  colours: { name: string; hex: string; role: Role }[];
  fonts: { headline: string; body: string };
  voice: { words: string; sayLike: string; avoid: string; bio: string };
  socials: { instagram: string; tiktok: string; youtube: string; spotify: string; website: string };
  imagery: { note: string; fileIds: string[] };
  updatedAt?: string;
  updatedByName?: string;
}

const ROLES: { value: Role; label: string }[] = [
  { value: 'primary', label: 'Primary' },
  { value: 'background', label: 'Background' },
  { value: 'accent', label: 'Accent' },
  { value: 'text', label: 'Text' },
  { value: 'other', label: 'Other' },
];
const FONTS = [
  'League Spartan',
  'Archivo Narrow',
  'Lexend Exa',
  'Inter',
  'Montserrat',
  'Poppins',
  'Playfair Display',
  'DM Serif Display',
  'Space Grotesk',
  'Bebas Neue',
  'Oswald',
  'Work Sans',
  'Libre Baskerville',
  'Cormorant Garamond',
  'Syne',
];
const SOCIALS: { id: keyof Kit['socials']; label: string; placeholder: string }[] = [
  { id: 'instagram', label: 'Instagram', placeholder: '@handle' },
  { id: 'tiktok', label: 'TikTok', placeholder: '@handle' },
  { id: 'youtube', label: 'YouTube', placeholder: 'Channel name or link' },
  { id: 'spotify', label: 'Spotify', placeholder: 'Artist link' },
  { id: 'website', label: 'Website', placeholder: 'https://' },
];
const HEX = /^#[0-9a-fA-F]{6}$/;

// ── Contrast (WCAG 2.2), mirrored from the API's brand model ──────────────
function luminance(hex: string): number {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const lin = c.map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * lin[0]! + 0.7152 * lin[1]! + 0.0722 * lin[2]!;
}
export function contrastRatio(a: string, b: string): number {
  const [l1, l2] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return Math.round(((l1 + 0.05) / (l2 + 0.05)) * 100) / 100;
}
function checks(colours: Kit['colours']) {
  const pick = (r: Role) => colours.find((c) => c.role === r && HEX.test(c.hex));
  const pairs: [string, Role, Role][] = [
    ['Text on background', 'text', 'background'],
    ['Primary on background', 'primary', 'background'],
    ['Accent on background', 'accent', 'background'],
    ['Background on primary', 'background', 'primary'],
  ];
  return pairs.flatMap(([label, f, b]) => {
    const fg = pick(f);
    const bg = pick(b);
    if (!fg || !bg) return [];
    const ratio = contrastRatio(fg.hex, bg.hex);
    const grade = ratio >= 4.5 ? 'AA' : ratio >= 3 ? 'AA large only' : 'Fails';
    return [{ label, fg: fg.hex, bg: bg.hex, ratio, grade }];
  });
}

/** Light or dark text for a swatch label, whichever reads better. */
const onColour = (hex: string) =>
  HEX.test(hex) && contrastRatio(hex, '#FFFFFF') >= contrastRatio(hex, '#011935')
    ? '#FFFFFF'
    : '#011935';

export function BrandKit({
  cfg,
  token,
  artistId,
  artistName,
  isArtist,
  compact = false,
  onOpenAssets,
}: {
  cfg: AppConfig;
  token: string;
  artistId: string;
  artistName: string;
  isArtist: boolean;
  compact?: boolean;
  onOpenAssets?: () => void;
}) {
  const first = artistName.split(' ')[0] ?? artistName;
  const [saved, setSaved] = useState<Kit | null>(null);
  const [kit, setKit] = useState<Kit | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [picking, setPicking] = useState<'logo' | 'imagery' | null>(null);
  const { files } = useArtistFiles(cfg, token, artistId);
  const images = useMemo(
    () =>
      (files ?? []).filter((f) => f.status === 'available' && f.contentType.startsWith('image/')),
    [files],
  );
  const byId = useMemo(() => new Map(images.map((f) => [f.fileId, f])), [images]);
  const thumbs = useThumbs(cfg, token, artistId, images);

  const load = useCallback(async () => {
    try {
      const k = await api<Kit>(cfg, token, 'GET', `/artists/${artistId}/brand-kit`);
      setSaved(k);
      setKit(k);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [cfg, token, artistId]);
  useEffect(() => void load(), [load]);

  if (!kit || !saved) return error ? <Notice tone="error">{error}</Notice> : <WaveLoader />;

  const dirty = JSON.stringify(kit) !== JSON.stringify(saved);
  const badHex = kit.colours.some((c) => !HEX.test(c.hex) || !c.name.trim());
  const set = <K extends keyof Kit>(k: K, v: Kit[K]) => {
    setNote(null);
    setKit({ ...kit, [k]: v });
  };
  const colour = (role: Role, fallback: string) =>
    kit.colours.find((c) => c.role === role && HEX.test(c.hex))?.hex ?? fallback;

  async function save() {
    if (!kit) return;
    setSaving(true);
    setError(null);
    try {
      const body: Partial<Kit> = { ...kit };
      delete body.updatedAt;
      delete body.updatedByName;
      const next = await api<Kit>(cfg, token, 'PUT', `/artists/${artistId}/brand-kit`, body);
      setSaved(next);
      setKit(next);
      setNote('Brand kit saved.');
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        setError(
          'Someone else changed the brand kit while you were editing. We loaded their version; please make your change again.',
        );
        await load();
      } else setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  function pick(f: FileItem) {
    if (!kit) return;
    if (picking === 'logo' && !kit.logos.some((l) => l.fileId === f.fileId)) {
      set('logos', [
        ...kit.logos,
        {
          fileId: f.fileId,
          label: (f.asset?.title ?? f.name.replace(/\.[^.]+$/, '')).slice(0, 60),
        },
      ]);
    }
    if (picking === 'imagery' && !kit.imagery.fileIds.includes(f.fileId)) {
      set('imagery', { ...kit.imagery, fileIds: [...kit.imagery.fileIds, f.fileId] });
    }
    setPicking(null);
  }

  const contrast = checks(kit.colours);
  const bg = colour('background', '#FFFFFF');
  const fg = colour('text', '#011935');
  const accent = colour('primary', colour('accent', '#D9534F'));

  const header = (
    <div className="flex flex-wrap items-center gap-3 print:hidden">
      <span className="src flex-1">
        {isArtist ? 'You and Blueprint' : `${first} and Blueprint`} can both edit
        {saved.updatedAt
          ? ` · last change by ${saved.updatedByName ?? 'Blueprint'}, ${shortDate(saved.updatedAt)}`
          : ' · not saved yet'}
      </span>
      <Button variant="ghost" size="sm" onClick={() => window.print()}>
        Export PDF
      </Button>
      <Button
        variant="cta"
        size="sm"
        disabled={!dirty || saving || badHex}
        onClick={() => void save()}
      >
        {saving ? 'Saving…' : 'Save'}
      </Button>
    </div>
  );

  const picker = picking && (
    <Card
      title={picking === 'logo' ? 'Pick a logo' : 'Pick photos for the style guide'}
      action={
        <Button size="sm" variant="ghost" onClick={() => setPicking(null)}>
          Close
        </Button>
      }
    >
      {images.length === 0 ? (
        <p className="src">
          No images yet.{' '}
          {onOpenAssets ? (
            <button type="button" className="font-bold underline" onClick={onOpenAssets}>
              Upload to the asset library
            </button>
          ) : (
            'Upload one to the asset library first'
          )}
          .
        </p>
      ) : (
        <div className="grid grid-cols-3 gap-3 sm:grid-cols-5">
          {images.map((f) => (
            <button
              key={f.fileId}
              type="button"
              className="flex flex-col gap-1 text-left"
              onClick={() => pick(f)}
            >
              <Thumb file={f} url={thumbs[f.fileId]} />
              <span className="line-clamp-1 text-sm">{f.asset?.title ?? f.name}</span>
            </button>
          ))}
        </div>
      )}
    </Card>
  );

  const logos = (
    <Card title="Logos" className="bk-card">
      {kit.logos.length > 0 && (
        <div className={`grid gap-3 ${compact ? 'grid-cols-2' : 'grid-cols-3'}`}>
          {kit.logos.map((l, i) => {
            const f = byId.get(l.fileId);
            return (
              <div key={l.fileId} className="flex flex-col gap-1.5">
                {f ? (
                  <Thumb
                    file={f}
                    url={thumbs[f.fileId]}
                    className="rounded-lg border border-input !object-contain"
                  />
                ) : (
                  <div className="flex aspect-square items-center justify-center rounded-lg bg-secondary text-sm">
                    File removed
                  </div>
                )}
                <input
                  aria-label="Logo name"
                  className="rounded border border-input px-2 py-1 text-sm print:border-0"
                  value={l.label}
                  maxLength={60}
                  onChange={(e) =>
                    set(
                      'logos',
                      kit.logos.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)),
                    )
                  }
                />
                <button
                  type="button"
                  className="self-start text-sm underline print:hidden"
                  onClick={() =>
                    set(
                      'logos',
                      kit.logos.filter((_, j) => j !== i),
                    )
                  }
                >
                  Remove
                </button>
              </div>
            );
          })}
        </div>
      )}
      {kit.logos.length < 12 && (
        <Button
          size="sm"
          variant="ghost"
          className="self-start print:hidden"
          onClick={() => setPicking('logo')}
        >
          Add logo from assets
        </Button>
      )}
      <TextArea
        label="Logo rules"
        value={kit.logoRules}
        maxLength={500}
        placeholder="Keep clear space; never stretch; white version on photos."
        onChange={(e) => set('logoRules', e.target.value)}
      />
    </Card>
  );

  const colours = (
    <Card title="Colours" className="bk-card">
      <div className="flex flex-col gap-2">
        {kit.colours.map((c, i) => {
          const upd = (patch: Partial<Kit['colours'][number]>) =>
            set(
              'colours',
              kit.colours.map((x, j) => (j === i ? { ...x, ...patch } : x)),
            );
          return (
            <div key={i} className="flex flex-wrap items-end gap-2">
              <label className="relative h-14 w-14 shrink-0 overflow-hidden rounded-lg border border-input">
                <span className="sr-only">Pick {c.name || 'colour'}</span>
                <span
                  className="absolute inset-0"
                  style={{
                    background: HEX.test(c.hex) ? c.hex : '#FFFFFF',
                    color: onColour(c.hex),
                  }}
                />
                <input
                  type="color"
                  className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
                  value={HEX.test(c.hex) ? c.hex.toLowerCase() : '#ffffff'}
                  onChange={(e) => upd({ hex: e.target.value.toUpperCase() })}
                />
              </label>
              <div className="min-w-[110px] flex-1">
                <Field
                  label="Name"
                  value={c.name}
                  maxLength={40}
                  onChange={(e) => upd({ name: e.target.value })}
                />
              </div>
              <div className="w-[110px]">
                <Field
                  label="Hex"
                  value={c.hex}
                  maxLength={7}
                  aria-invalid={!HEX.test(c.hex)}
                  onChange={(e) => upd({ hex: e.target.value.trim().toUpperCase() })}
                />
              </div>
              <div className="w-[130px]">
                <Select
                  label="Used for"
                  value={c.role}
                  options={ROLES}
                  onChange={(e) => upd({ role: e.target.value as Role })}
                />
              </div>
              <Button
                size="sm"
                variant="ghost"
                className="print:hidden"
                aria-label={`Remove ${c.name || 'colour'}`}
                onClick={() =>
                  set(
                    'colours',
                    kit.colours.filter((_, j) => j !== i),
                  )
                }
              >
                Remove
              </Button>
            </div>
          );
        })}
      </div>
      {badHex && (
        <Notice tone="error">Each colour needs a name and a six-digit hex like #3B1F3A.</Notice>
      )}
      {kit.colours.length < 12 && (
        <Button
          size="sm"
          variant="ghost"
          className="self-start print:hidden"
          onClick={() =>
            set('colours', [
              ...kit.colours,
              {
                name: '',
                hex: '#011935',
                role:
                  (['primary', 'background', 'accent', 'text'] as Role[]).find(
                    (r) => !kit.colours.some((c) => c.role === r),
                  ) ?? 'other',
              },
            ])
          }
        >
          Add colour
        </Button>
      )}
      {contrast.length > 0 ? (
        <ul className="m-0 flex list-none flex-col gap-1 p-0">
          {contrast.map((c) => (
            <li key={c.label} className="li">
              <span
                className="rounded px-2 py-0.5 text-sm font-bold"
                style={{ background: c.bg, color: c.fg }}
              >
                Aa
              </span>
              <span className="flex-1">{c.label}</span>
              <span className="src">{c.ratio}:1</span>
              <Tag tone={c.grade === 'AA' ? 'n' : c.grade === 'Fails' ? 'k' : 'c'}>{c.grade}</Tag>
            </li>
          ))}
        </ul>
      ) : (
        <p className="src m-0">
          Mark a text, primary and background colour to check they're readable together.
        </p>
      )}
    </Card>
  );

  const fontInput = (k: keyof Kit['fonts'], label: string) => (
    <label className="flex flex-col gap-1.5">
      <span className="text-[15px] font-bold">{label}</span>
      <input
        list="bk-fonts"
        className="min-h-11 w-full rounded-lg border border-input bg-white px-3 text-base"
        value={kit.fonts[k]}
        maxLength={60}
        placeholder="Pick or type a font"
        onChange={(e) => set('fonts', { ...kit.fonts, [k]: e.target.value })}
      />
    </label>
  );
  const fonts = (
    <Card title="Fonts" className="bk-card">
      <datalist id="bk-fonts">
        {FONTS.map((f) => (
          <option key={f} value={f} />
        ))}
      </datalist>
      <div className="grid gap-3 sm:grid-cols-2">
        {fontInput('headline', 'Headlines')}
        {fontInput('body', 'Body')}
      </div>
      <div className="flex flex-col gap-1.5 rounded-lg p-4" style={{ background: bg, color: fg }}>
        <span
          className="text-[26px] leading-tight font-bold"
          style={{
            fontFamily: `"${kit.fonts.headline || 'League Spartan'}", "League Spartan", sans-serif`,
            color: accent,
          }}
        >
          New single out Friday
        </span>
        <span
          style={{
            fontFamily: `"${kit.fonts.body || 'Archivo Narrow'}", "Archivo Narrow", sans-serif`,
          }}
        >
          {kit.voice.bio.trim().split(/(?<=\.)\s/)[0] ||
            `${artistName} — live this weekend. Tickets at the link.`}
        </span>
      </div>
      <p className="src m-0">
        The preview uses the font if it's installed on this device; Blueprint's designers use the
        real files.
      </p>
    </Card>
  );

  const voice = (
    <Card title="Voice & language" className="bk-card">
      <Field
        label="Three words"
        value={kit.voice.words}
        maxLength={120}
        placeholder="Warm, cheeky, honest"
        onChange={(e) => set('voice', { ...kit.voice, words: e.target.value })}
      />
      <TextArea
        label="Say things like"
        value={kit.voice.sayLike}
        maxLength={600}
        onChange={(e) => set('voice', { ...kit.voice, sayLike: e.target.value })}
      />
      <TextArea
        label="Avoid"
        value={kit.voice.avoid}
        maxLength={600}
        onChange={(e) => set('voice', { ...kit.voice, avoid: e.target.value })}
      />
      {!compact && (
        <TextArea
          label="Short bio"
          value={kit.voice.bio}
          maxLength={1000}
          onChange={(e) => set('voice', { ...kit.voice, bio: e.target.value })}
        />
      )}
    </Card>
  );

  const socials = (
    <Card title="Socials & imagery" className="bk-card">
      <div className="grid gap-3 sm:grid-cols-2">
        {SOCIALS.map((s) => (
          <Field
            key={s.id}
            label={s.label}
            value={kit.socials[s.id]}
            placeholder={s.placeholder}
            maxLength={
              s.id === 'instagram' || s.id === 'tiktok' ? 60 : s.id === 'youtube' ? 120 : 200
            }
            onChange={(e) => set('socials', { ...kit.socials, [s.id]: e.target.value })}
          />
        ))}
      </div>
      <span className="text-[15px] font-bold">Photo style</span>
      <div className="grid grid-cols-4 gap-2">
        {kit.imagery.fileIds.map((id) => {
          const f = byId.get(id);
          return (
            <div key={id} className="flex flex-col gap-1">
              {f ? (
                <Thumb file={f} url={thumbs[id]} className="rounded" />
              ) : (
                <div className="aspect-square rounded bg-secondary" />
              )}
              <button
                type="button"
                className="self-start text-sm underline print:hidden"
                onClick={() =>
                  set('imagery', {
                    ...kit.imagery,
                    fileIds: kit.imagery.fileIds.filter((x) => x !== id),
                  })
                }
              >
                Remove
              </button>
            </div>
          );
        })}
        {kit.imagery.fileIds.length < 8 && (
          <button
            type="button"
            className="flex aspect-square items-center justify-center rounded border border-dashed border-input text-sm print:hidden"
            onClick={() => setPicking('imagery')}
          >
            + Add photo
          </button>
        )}
      </div>
      <TextArea
        label="Moodboard note"
        value={kit.imagery.note}
        maxLength={600}
        placeholder="Grainy, warm, shot at night; no studio white backgrounds."
        onChange={(e) => set('imagery', { ...kit.imagery, note: e.target.value })}
      />
    </Card>
  );

  return (
    <div className="brand-kit flex flex-col gap-5">
      <h2 className="t hidden text-[26px] print:block">{first}'s brand kit</h2>
      {header}
      {error && <Notice tone="error">{error}</Notice>}
      {note && !dirty && <Notice tone="success">{note}</Notice>}
      {picker}
      {compact ? (
        <>
          {logos}
          {colours}
          {fonts}
          {voice}
          {socials}
          <Notice>Blueprint uses your kit for posts, press kits and the website.</Notice>
        </>
      ) : (
        <div className="grid gap-5 lg:grid-cols-2">
          {logos}
          {colours}
          {fonts}
          {voice}
          <div className="lg:col-span-2">{socials}</div>
        </div>
      )}
    </div>
  );
}
