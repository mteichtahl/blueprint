import { z } from 'zod';

/**
 * Each artist's brand kit (screens doc "Brand kit"): logos, colours, fonts,
 * voice & language, socials and imagery. The artist and Blueprint can both
 * edit it. Stored at `ARTIST#<id> / BRAND`, with a version for safe saves.
 */

export const BRAND_SK = 'BRAND';
export const MAX_COLOURS = 12;

const Text = (max: number) => z.string().trim().max(max);
const FileId = z.string().regex(/^[a-z0-9]{10,40}$/);
const Hex = z
  .string()
  .trim()
  .regex(/^#[0-9a-fA-F]{6}$/, 'Use a six-digit hex colour like #3B1F3A')
  .transform((h) => h.toUpperCase());

export const COLOUR_ROLES = ['primary', 'background', 'accent', 'text', 'other'] as const;

/** Fonts offered in the picker; any other font name can be typed in too. */
export const FONT_SUGGESTIONS = [
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
] as const;

export const BrandKitBody = z
  .object({
    /** The version you edited, so two people can't silently overwrite each other. */
    version: z.number().int().min(0),
    logos: z
      .array(z.object({ fileId: FileId, label: Text(60) }).strict())
      .max(12)
      .default([]),
    logoRules: Text(500).default(''),
    colours: z
      .array(z.object({ name: Text(40).min(1), hex: Hex, role: z.enum(COLOUR_ROLES) }).strict())
      .max(MAX_COLOURS)
      .default([]),
    fonts: z
      .object({ headline: Text(60).default(''), body: Text(60).default('') })
      .strict()
      .default({ headline: '', body: '' }),
    voice: z
      .object({
        words: Text(120).default(''),
        sayLike: Text(600).default(''),
        avoid: Text(600).default(''),
        bio: Text(1000).default(''),
      })
      .strict()
      .default({ words: '', sayLike: '', avoid: '', bio: '' }),
    socials: z
      .object({
        instagram: Text(60).default(''),
        tiktok: Text(60).default(''),
        youtube: Text(120).default(''),
        spotify: Text(200).default(''),
        website: Text(200).default(''),
      })
      .strict()
      .default({ instagram: '', tiktok: '', youtube: '', spotify: '', website: '' }),
    imagery: z
      .object({ note: Text(600).default(''), fileIds: z.array(FileId).max(8).default([]) })
      .strict()
      .default({ note: '', fileIds: [] }),
  })
  .strict();
export type BrandKitBody = z.infer<typeof BrandKitBody>;

export interface BrandKit extends Omit<BrandKitBody, 'version'> {
  version: number;
  updatedAt?: string;
  updatedBy?: string;
  updatedByName?: string;
}

export const EMPTY_KIT: BrandKit = { ...BrandKitBody.parse({ version: 0 }), version: 0 };

/** Every file a kit points at, so the API can check they belong to this artist. */
export function referencedFiles(kit: Pick<BrandKitBody, 'logos' | 'imagery'>): string[] {
  return [...new Set([...kit.logos.map((l) => l.fileId), ...kit.imagery.fileIds])];
}

// ── Contrast (WCAG 2.2) ───────────────────────────────────────────────────
function luminance(hex: string): number {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const lin = c.map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * lin[0]! + 0.7152 * lin[1]! + 0.0722 * lin[2]!;
}

export function contrastRatio(a: string, b: string): number {
  const [l1, l2] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return Math.round(((l1 + 0.05) / (l2 + 0.05)) * 100) / 100;
}

/** AA for body text needs 4.5:1; large text (24 px, or 19 px bold) needs 3:1. */
export function contrastGrade(ratio: number): 'AA' | 'AA large only' | 'Fails' {
  return ratio >= 4.5 ? 'AA' : ratio >= 3 ? 'AA large only' : 'Fails';
}

/** The pairs worth checking: text and primary on the background, and text on primary. */
export function contrastChecks(colours: BrandKitBody['colours']) {
  const pick = (role: string) => colours.find((c) => c.role === role);
  const pairs: [string, ReturnType<typeof pick>, ReturnType<typeof pick>][] = [
    ['Text on background', pick('text'), pick('background')],
    ['Primary on background', pick('primary'), pick('background')],
    ['Accent on background', pick('accent'), pick('background')],
    ['Background on primary', pick('background'), pick('primary')],
  ];
  return pairs
    .filter(
      (p): p is [string, NonNullable<(typeof p)[1]>, NonNullable<(typeof p)[2]>] =>
        !!p[1] && !!p[2],
    )
    .map(([label, fg, bg]) => {
      const ratio = contrastRatio(fg.hex, bg.hex);
      return { label, fg: fg.hex, bg: bg.hex, ratio, grade: contrastGrade(ratio) };
    });
}
