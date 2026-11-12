// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { lockToVisibleViewport } from '../src/lib/viewport.ts';

function fakeViewport(height: number) {
  const listeners: Record<string, (() => void)[]> = {};
  return {
    height,
    offsetTop: 0,
    addEventListener: (t: string, f: () => void) => (listeners[t] ??= []).push(f),
    removeEventListener: (t: string, f: () => void) =>
      (listeners[t] = (listeners[t] ?? []).filter((g) => g !== f)),
    fire: (t: string) => listeners[t]?.forEach((f) => f()),
    count: (t: string) => listeners[t]?.length ?? 0,
  };
}

afterEach(() => {
  document.documentElement.style.removeProperty('--app-height');
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

describe('phone layout follows the visible viewport', () => {
  it('sets --app-height to what is visible, and follows the keyboard', () => {
    vi.stubGlobal('requestAnimationFrame', (f: FrameRequestCallback) => (f(0), 1));
    const vv = fakeViewport(800);
    const win = { visualViewport: vv, document, scrollY: 0, scrollTo: vi.fn() };
    const stop = lockToVisibleViewport(win as unknown as Window);
    expect(document.documentElement.style.getPropertyValue('--app-height')).toBe('800px');
    vv.height = 480; // the keyboard opened
    vv.fire('resize');
    expect(document.documentElement.style.getPropertyValue('--app-height')).toBe('480px');
    stop();
    expect(vv.count('resize')).toBe(0);
  });

  it('puts the page back to the top while a phone chat is showing', () => {
    vi.stubGlobal('requestAnimationFrame', (f: FrameRequestCallback) => (f(0), 1));
    const vv = fakeViewport(480);
    const win = { visualViewport: vv, document, scrollY: 120, scrollTo: vi.fn() };
    lockToVisibleViewport(win as unknown as Window);
    expect(win.scrollTo).not.toHaveBeenCalled();
    document.body.innerHTML = '<div class="wa wa-phone"></div>';
    vv.fire('scroll');
    expect(win.scrollTo).toHaveBeenCalledWith(0, 0);
  });

  it('does nothing without a visual viewport', () => {
    expect(() => lockToVisibleViewport({ document } as unknown as Window)()).not.toThrow();
  });
});
