/**
 * No pinch or double-tap zoom on phones. The viewport tag asks for this, but
 * iOS Safari ignores `user-scalable=no`, so its gesture events are cancelled
 * here too (CSS `touch-action: pan-x pan-y` covers Chrome and Android).
 */
export function preventZoom() {
  const stop = (e: Event) => e.preventDefault();
  // Safari's own pinch events.
  for (const type of ['gesturestart', 'gesturechange', 'gestureend']) {
    document.addEventListener(type, stop, { passive: false });
  }
  // Two-finger moves anywhere else.
  document.addEventListener(
    'touchmove',
    (e) => {
      if (e.touches.length > 1) e.preventDefault();
    },
    { passive: false },
  );
}
