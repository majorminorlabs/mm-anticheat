/* Ambient press loops (story pages) — preview switch.
   Adds `fx-ambient` to <html> so the loops in public/design/public.css arm
   themselves; the newsroom preview iframe never loads this file, so editors
   always see the still page.
   Default: on. `?fx=off` disables all loops; `?fx=no-drift,no-stamp,no-strip`
   disables individual loops. To remove the feature, delete this file, its
   <script> tag in public/index.html, and the "Ambient press loops" section
   of public/design/public.css. */
(() => {
  const tokens = (new URLSearchParams(location.search).get('fx') || '')
    .split(',')
    .map((token) => token.trim())
    .filter(Boolean);
  if (tokens.includes('off')) return;
  const root = document.documentElement;
  root.classList.add('fx-ambient');
  for (const token of tokens) {
    if (/^no-(drift|stamp|strip)$/.test(token)) root.classList.add(`fx-${token}`);
  }
  /* Reading strip fallback: where scroll-driven animations are unsupported
     (Safari, Firefox), track scroll progress here and drive --strip-x. */
  if (!root.classList.contains('fx-no-strip')
      && !CSS.supports('animation-timeline: scroll(root)')
      && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    root.classList.add('fx-strip-js');
    let queued = false;
    const track = () => {
      queued = false;
      const range = root.scrollHeight - window.innerHeight;
      const progress = range > 0 ? Math.min(1, Math.max(0, window.scrollY / range)) : 0;
      root.style.setProperty('--strip-x', `${progress * 100}%`);
    };
    window.addEventListener('scroll', () => {
      if (!queued) {
        queued = true;
        window.requestAnimationFrame(track);
      }
    }, { passive: true });
    track();
  }
})();
