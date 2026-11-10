import { useEffect, useMemo, useState } from 'react';

/**
 * The full emoji picker for chat and to-do threads (rev 7): search, categories,
 * recently used and skin tones. The emoji list (Emojibase, MIT) is bundled
 * with the app and loads the first time the picker opens, so nothing is
 * fetched from another site.
 */

interface RawEmoji {
  label: string;
  unicode: string;
  group?: number;
  order?: number;
  tags?: string[];
  skins?: { unicode: string }[];
}
export interface Emoji {
  label: string;
  unicode: string;
  group: number;
  order: number;
  tags: string[];
  /** Light → dark skin tone versions, where the emoji has them. */
  skins?: string[];
}

/** Emojibase groups, without "Component" (bare skin-tone swatches). */
export const GROUPS = [
  { id: 0, label: 'Smileys', icon: '😀' },
  { id: 1, label: 'People', icon: '👋' },
  { id: 3, label: 'Animals & nature', icon: '🐻' },
  { id: 4, label: 'Food & drink', icon: '🍔' },
  { id: 5, label: 'Travel & places', icon: '🚗' },
  { id: 6, label: 'Activities', icon: '⚽' },
  { id: 7, label: 'Objects', icon: '🎸' },
  { id: 8, label: 'Symbols', icon: '❤️' },
  { id: 9, label: 'Flags', icon: '🏁' },
] as const;

export const SKIN_TONES = ['✋', '✋🏻', '✋🏼', '✋🏽', '✋🏾', '✋🏿'];

/** Keeps the emoji people can pick, in Emojibase's order. */
export function prepare(raw: readonly RawEmoji[]): Emoji[] {
  return raw
    .filter((e) => e.group !== undefined && e.group !== 2 && e.order !== undefined)
    .map((e) => ({
      label: e.label,
      unicode: e.unicode,
      group: e.group!,
      order: e.order!,
      tags: e.tags ?? [],
      ...(e.skins?.length === 5 ? { skins: e.skins.map((s) => s.unicode) } : {}),
    }))
    .sort((a, b) => a.order - b.order);
}

/** Every word typed must match the start of a word in the name or a tag. */
export function searchEmoji(all: readonly Emoji[], q: string): Emoji[] {
  const words = q.toLowerCase().trim().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  return all.filter((e) => {
    const hay = [...e.label.toLowerCase().split(/[\s:,-]+/), ...e.tags.map((t) => t.toLowerCase())];
    return words.every((w) => hay.some((h) => h.startsWith(w)));
  });
}

/** The emoji with the chosen skin tone (0 = default yellow). */
export const withTone = (e: Emoji, tone: number) =>
  tone > 0 && e.skins ? e.skins[tone - 1]! : e.unicode;

const RECENTS_KEY = 'bmg.emoji.recent';
const SKIN_KEY = 'bmg.emoji.skin';
const readStore = <T,>(key: string, fallback: T): T => {
  try {
    const v = localStorage.getItem(key);
    return v ? (JSON.parse(v) as T) : fallback;
  } catch {
    return fallback;
  }
};
const writeStore = (key: string, value: unknown) => {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Private mode or storage full: recents just aren't remembered.
  }
};

let cache: Promise<Emoji[]> | null = null;
const loadEmoji = () =>
  (cache ??= import('emojibase-data/en/compact.json').then((m) =>
    prepare((m.default ?? m) as unknown as RawEmoji[]),
  ));

export function EmojiPicker({ onPick }: { onPick: (emoji: string) => void }) {
  const [all, setAll] = useState<Emoji[] | null>(null);
  const [error, setError] = useState(false);
  const [q, setQ] = useState('');
  const [group, setGroup] = useState<number | 'recent'>(() =>
    readStore<string[]>(RECENTS_KEY, []).length ? 'recent' : 0,
  );
  const [tone, setTone] = useState(() => readStore<number>(SKIN_KEY, 0));
  const [recent, setRecent] = useState(() => readStore<string[]>(RECENTS_KEY, []));
  useEffect(() => {
    loadEmoji().then(setAll, () => setError(true));
  }, []);

  const shown = useMemo(() => {
    if (!all) return [];
    if (q.trim()) return searchEmoji(all, q).slice(0, 160);
    if (group === 'recent') return [];
    return all.filter((e) => e.group === group);
  }, [all, q, group]);

  function pick(char: string) {
    onPick(char);
    const next = [char, ...recent.filter((r) => r !== char)].slice(0, 32);
    setRecent(next);
    writeStore(RECENTS_KEY, next);
  }

  const cell = (char: string, label: string, key: string) => (
    <button key={key} type="button" title={label} aria-label={label} onClick={() => pick(char)}>
      {char}
    </button>
  );

  return (
    <div className="wa-emoji-picker" role="dialog" aria-label="Emoji">
      <div className="flex items-center gap-2 px-2.5 pt-2">
        <input
          type="search"
          className="min-h-9 min-w-0 flex-1 rounded-lg border border-input bg-white px-3 text-[15px]"
          placeholder="Search emoji"
          aria-label="Search emoji"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <div className="flex" role="radiogroup" aria-label="Skin tone">
          {SKIN_TONES.map((s, i) => (
            <button
              key={s}
              type="button"
              role="radio"
              aria-checked={tone === i}
              aria-label={i === 0 ? 'Default skin tone' : `Skin tone ${i}`}
              className={`size-8 rounded-md text-lg ${tone === i ? 'bg-[#E6E9ED]' : ''}`}
              onClick={() => {
                setTone(i);
                writeStore(SKIN_KEY, i);
              }}
            >
              {s}
            </button>
          ))}
        </div>
      </div>
      {!q.trim() && (
        <div
          className="relative flex gap-0.5 overflow-x-auto px-2.5 pt-1.5"
          role="tablist"
          aria-label="Emoji groups"
        >
          <button
            type="button"
            role="tab"
            aria-selected={group === 'recent'}
            aria-label="Recently used"
            title="Recently used"
            className={`size-9 flex-none rounded-md text-lg ${group === 'recent' ? 'bg-[#E6E9ED]' : ''}`}
            onClick={() => setGroup('recent')}
          >
            🕘
          </button>
          {GROUPS.map((g) => (
            <button
              key={g.id}
              type="button"
              role="tab"
              aria-selected={group === g.id}
              aria-label={g.label}
              title={g.label}
              className={`size-9 flex-none rounded-md text-lg ${group === g.id ? 'bg-[#E6E9ED]' : ''}`}
              onClick={() => setGroup(g.id)}
            >
              {g.icon}
            </button>
          ))}
        </div>
      )}
      <div className="wa-emoji">
        {error && <p className="src col-span-full">Emoji didn&apos;t load. Try again.</p>}
        {!all && !error && <p className="src col-span-full">Loading emoji…</p>}
        {all && !q.trim() && group === 'recent' && recent.length === 0 && (
          <p className="src col-span-full">Emoji you use show up here.</p>
        )}
        {all && !q.trim() && group === 'recent' && recent.map((r, i) => cell(r, r, `r${i}`))}
        {shown.map((e) => cell(withTone(e, tone), e.label, e.unicode))}
        {all && q.trim() && shown.length === 0 && (
          <p className="src col-span-full">No emoji match “{q}”.</p>
        )}
      </div>
    </div>
  );
}
