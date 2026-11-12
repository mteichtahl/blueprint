/**
 * Keeps the phone layout the height of what's actually visible, so the chat's
 * message box stays locked to the bottom of the screen.
 *
 * `100dvh` doesn't shrink for the on-screen keyboard on iOS (Safari or the
 * installed app): the page is taller than what's visible and iOS scrolls it up
 * to show the field, so the message box floats and the header slides away.
 * The visual viewport is what's really on screen, so its height goes into
 * `--app-height`, which the full-screen frames use (index.css). While a phone
 * chat is showing, any page scroll iOS adds is put back to the top.
 */
export function lockToVisibleViewport(win: Window = window): () => void {
  const vv = win.visualViewport;
  if (!vv) return () => undefined;
  const root = win.document.documentElement;
  let frame = 0;
  const update = () => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      root.style.setProperty('--app-height', `${Math.round(vv.height)}px`);
      // Only the chat's messages scroll on a phone; the page itself never should.
      if (win.document.querySelector('.wa-phone') && (win.scrollY || vv.offsetTop)) {
        win.scrollTo(0, 0);
      }
    });
  };
  update();
  vv.addEventListener('resize', update);
  vv.addEventListener('scroll', update);
  return () => {
    cancelAnimationFrame(frame);
    vv.removeEventListener('resize', update);
    vv.removeEventListener('scroll', update);
  };
}
