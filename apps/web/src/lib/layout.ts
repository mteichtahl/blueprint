import { useEffect, useState } from 'react';

/**
 * Rev 16: which layout the artist app uses. Automatic follows the screen (desktop
 * from 1024px wide, so laptops and iPads held sideways; the phone layout below
 * that). The choice is saved on this device, like light and dark mode.
 */
export type LayoutChoice = 'auto' | 'phone' | 'desktop';

const KEY = 'bmg-artist-layout';
const EVENT = 'bmg-artist-layout-change';

export const DESKTOP_QUERY = '(min-width: 1024px)';
/** "Desktop layout" still falls back to the phone layout below this width. */
export const DESKTOP_FLOOR_QUERY = '(min-width: 640px)';

export function readLayoutChoice(): LayoutChoice {
  try {
    const v = window.localStorage.getItem(KEY);
    return v === 'phone' || v === 'desktop' ? v : 'auto';
  } catch {
    return 'auto';
  }
}

export function saveLayoutChoice(choice: LayoutChoice) {
  try {
    if (choice === 'auto') window.localStorage.removeItem(KEY);
    else window.localStorage.setItem(KEY, choice);
  } catch {
    // Storage can be unavailable (private mode); the choice then lasts for this visit.
  }
  window.dispatchEvent(new CustomEvent<LayoutChoice>(EVENT, { detail: choice }));
}

/** The saved choice, kept in step between Profile and the app shell. */
export function useLayoutChoice(): [LayoutChoice, (c: LayoutChoice) => void] {
  const [choice, setChoice] = useState<LayoutChoice>(readLayoutChoice);
  useEffect(() => {
    const onChange = (e: Event) => {
      const detail = (e as CustomEvent<LayoutChoice>).detail;
      setChoice(detail ?? readLayoutChoice());
    };
    const onStorage = (e: StorageEvent) => e.key === KEY && setChoice(readLayoutChoice());
    window.addEventListener(EVENT, onChange);
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener(EVENT, onChange);
      window.removeEventListener('storage', onStorage);
    };
  }, []);
  return [choice, saveLayoutChoice];
}

function useMedia(query: string): boolean {
  const get = () => typeof window !== 'undefined' && window.matchMedia?.(query).matches === true;
  const [matches, setMatches] = useState(get);
  useEffect(() => {
    const mq = window.matchMedia?.(query);
    if (!mq) return;
    const on = () => setMatches(mq.matches);
    on();
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, [query]);
  return matches;
}

/** Pure rule, for tests: which layout a choice gives at a window size. */
export function desktopFor(choice: LayoutChoice, wide: boolean, aboveFloor: boolean): boolean {
  if (choice === 'phone') return false;
  if (choice === 'desktop') return aboveFloor;
  return wide;
}

/**
 * True when the artist app should use its desktop layout. Follows the window
 * live: resizing or turning a tablet swaps the layout without reloading.
 */
export function useArtistDesktop(): boolean {
  const [choice] = useLayoutChoice();
  const wide = useMedia(DESKTOP_QUERY);
  const aboveFloor = useMedia(DESKTOP_FLOOR_QUERY);
  return desktopFor(choice, wide, aboveFloor);
}
