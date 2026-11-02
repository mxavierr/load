// Tells the extension that you are actively using this page (visible, focused, and you
// moved, typed or scrolled in the last minute). Nothing about the page content is sent,
// only its address and title.
(() => {
  let last = 0;
  const mark = () => { last = Date.now(); };
  for (const ev of ['mousemove', 'mousedown', 'keydown', 'scroll', 'wheel', 'touchstart']) addEventListener(ev, mark, { passive: true, capture: true });
  const beat = () => {
    if (document.visibilityState !== 'visible' || !document.hasFocus()) return;
    if (Date.now() - last > 60e3) return;
    try {
      browser.runtime.sendMessage({ type: 'beat', url: location.href, title: document.title }).catch(() => {});
    } catch { /* extension reloaded */ }
  };
  mark();
  setInterval(beat, 20e3);
  addEventListener('focus', () => { mark(); beat(); });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { mark(); beat(); } });
})();
