/* Anyways · signal engine.
   One classic script, loaded synchronously in <head> (CSP forbids inline
   scripts). Owns: color theme, the boot sequence, scramble text, scroll
   reveals, masthead/ticker behavior, story-page progress. Everything is
   additive: no-JS, reduced-motion, and `?fx=off` all get the still page. */
(() => {
  const root = document.documentElement;
  const reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const fxOff = (new URLSearchParams(location.search).get('fx') || '') === 'off';
  const isPublic = !location.pathname.startsWith('/newsroom');
  const motion = !reduceMotion && !fxOff;

  /* ---------- Theme (runs pre-paint) ---------- */

  const THEME_KEY = 'anyways.theme';
  const storedTheme = (() => { try { return localStorage.getItem(THEME_KEY); } catch { return null; } })();
  const paramTheme = new URLSearchParams(location.search).get('theme');
  const prefersLight = window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches;
  const initialTheme = paramTheme === 'light' || paramTheme === 'dark'
    ? paramTheme
    : storedTheme === 'light' || storedTheme === 'dark'
      ? storedTheme
      : prefersLight ? 'light' : 'dark';

  function paintThemeColor(theme) {
    const color = theme === 'light' ? '#f6eeda' : '#181022';
    const metas = document.querySelectorAll('meta[name="theme-color"]');
    if (!metas.length) return;
    if (metas.length === 1) { metas[0].setAttribute('content', color); return; }
    /* Two media-scoped metas ship in the shell; once a reader chooses a theme
       by hand, collapse them to one explicit value. */
    metas.forEach((meta, index) => {
      if (index === 0) { meta.removeAttribute('media'); meta.setAttribute('content', color); }
      else meta.remove();
    });
  }

  function applyTheme(theme) {
    root.dataset.theme = theme;
    paintThemeColor(theme);
    const toggle = document.querySelector('#theme-toggle');
    if (toggle) toggle.setAttribute('aria-pressed', theme === 'dark' ? 'true' : 'false');
  }

  applyTheme(initialTheme);

  /* ---------- Boot sequence ---------- */

  const bootKey = 'anyways.booted';
  const alreadyBooted = (() => { try { return sessionStorage.getItem(bootKey); } catch { return true; } })();
  const shouldBoot = motion && isPublic && !alreadyBooted && location.pathname === '/';
  if (motion) root.classList.add('motion');
  if (shouldBoot) root.classList.add('booting');

  const GLYPHS = '✳<>/\\{}[]#%&@$+=*~abcdefxyz0123456789';

  function scramble(el, duration = 700) {
    if (!el || !motion) return;
    const finalText = el.dataset.text || el.textContent;
    el.dataset.text = finalText;
    const length = finalText.length;
    const start = performance.now();
    const tick = now => {
      const t = Math.min(1, (now - start) / duration);
      const settled = Math.floor(t * length);
      let out = finalText.slice(0, settled);
      for (let i = settled; i < length; i++) {
        out += finalText[i] === ' ' ? ' ' : GLYPHS[(Math.random() * GLYPHS.length) | 0];
      }
      el.textContent = out;
      if (t < 1) requestAnimationFrame(tick);
      else el.textContent = finalText;
    };
    requestAnimationFrame(tick);
  }

  function finishBoot() {
    root.classList.remove('booting');
    root.classList.add('booted');
    try { sessionStorage.setItem(bootKey, '1'); } catch {}
    const boot = document.querySelector('#boot');
    if (boot) {
      boot.classList.add('boot-out');
      setTimeout(() => boot.remove(), 560);
    }
  }

  function runBoot() {
    const boot = document.querySelector('#boot');
    if (!boot || !root.classList.contains('booting')) { finishBoot(); return; }
    const word = boot.querySelector('[data-boot-word]');
    const status = boot.querySelector('[data-boot-status]');
    const blocks = [...boot.querySelectorAll('.boot-blocks i')];
    scramble(word, 650);
    const lines = ['watering the flowers', 'ignoring the group chat', 'checking the vibes', 'locked in'];
    lines.forEach((line, i) => setTimeout(() => { if (status) status.textContent = line; }, i * 300));
    blocks.forEach((block, i) => setTimeout(() => block.classList.add('on'), 120 + i * 65));
    setTimeout(finishBoot, Math.max(1050, 120 + blocks.length * 65 + 250));
  }

  /* ---------- Reveal on scroll ---------- */

  let revealObserver = null;
  function reveals(scope) {
    if (!motion || !('IntersectionObserver' in window)) return;
    if (!revealObserver) {
      revealObserver = new IntersectionObserver(entries => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          entry.target.classList.add('rv-in');
          revealObserver.unobserve(entry.target);
        }
      }, { rootMargin: '0px 0px -6% 0px', threshold: 0.05 });
    }
    for (const el of scope.querySelectorAll('[data-reveal]:not(.rv-arm)')) {
      /* Already in view at arm time: reveal immediately rather than waiting
         on an observer callback. Below the fold, the observer drives it. */
      const rect = el.getBoundingClientRect();
      if (rect.top < window.innerHeight * 0.94 && rect.bottom > 0) {
        el.classList.add('rv-arm', 'rv-in');
        continue;
      }
      el.classList.add('rv-arm');
      revealObserver.observe(el);
    }
  }

  /* ---------- Page chrome behaviors ---------- */

  let ticking = false;
  function onScroll() {
    ticking = false;
    const y = window.scrollY || 0;
    document.body.classList.toggle('is-scrolled', y > 48);
    /* Story reading progress + minutes-left chip. */
    const bar = document.querySelector('.readbar i');
    const left = document.querySelector('[data-minutes-left]');
    if (bar || left) {
      const article = document.querySelector('.story-body');
      const range = article
        ? Math.max(1, article.offsetTop + article.offsetHeight - window.innerHeight)
        : Math.max(1, root.scrollHeight - window.innerHeight);
      const progress = Math.min(1, Math.max(0, y / range));
      if (bar) bar.style.transform = `scaleX(${progress})`;
      if (left) {
        const total = Number(left.dataset.minutesLeft) || 0;
        left.textContent = progress >= 0.98 ? 'done ✳' : `${Math.max(1, Math.ceil(total * (1 - progress)))} min left`;
      }
    }
    /* Slow drift elements: hero aurora, ghost words, hero frames. */
    for (const el of document.querySelectorAll('[data-drift]')) {
      const speed = Number(el.dataset.drift) || 0.08;
      el.style.transform = `translate3d(0, ${(y * speed).toFixed(1)}px, 0)`;
    }
  }
  window.addEventListener('scroll', () => {
    if (!ticking) { ticking = true; requestAnimationFrame(onScroll); }
  }, { passive: true });

  function wireChrome(scope = document) {
    const toggle = scope.querySelector('#theme-toggle');
    if (toggle && !toggle.dataset.wired) {
      toggle.dataset.wired = '1';
      toggle.addEventListener('click', () => {
        const next = root.dataset.theme === 'dark' ? 'light' : 'dark';
        try { localStorage.setItem(THEME_KEY, next); } catch {}
        applyTheme(next);
      });
      toggle.setAttribute('aria-pressed', root.dataset.theme === 'dark' ? 'true' : 'false');
    }
    /* Ticker: duplicate the track for a seamless loop, once. */
    const track = scope.querySelector('#ticker-track');
    if (track && track.children.length && !track.dataset.looped) {
      track.dataset.looped = '1';
      track.innerHTML += track.innerHTML;
    }
    /* Scramble marked headlines, once each. */
    for (const el of scope.querySelectorAll('[data-scramble]:not([data-scrambled])')) {
      el.dataset.scrambled = '1';
      scramble(el, Number(el.dataset.scramble) || 750);
    }
    reveals(scope);
  }

  /* Copy-link buttons (story share row). */
  document.addEventListener('click', event => {
    const button = event.target.closest('[data-copy-link]');
    if (!button) return;
    const done = () => {
      const label = button.dataset.label || button.textContent;
      button.dataset.label = label;
      button.textContent = 'copied ✓';
      button.classList.add('is-copied');
      setTimeout(() => { button.textContent = label; button.classList.remove('is-copied'); }, 1600);
    };
    if (navigator.clipboard?.writeText) navigator.clipboard.writeText(location.href).then(done).catch(() => {});
  });

  /* app.js renders into #app after async data fetches; watch for it. */
  function observeApp() {
    const app = document.querySelector('#app');
    wireChrome();
    if (!app) return;
    wireChrome(app);
    new MutationObserver(mutations => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (node.nodeType === 1) wireChrome(node.parentElement || app);
        }
      }
    }).observe(app, { childList: true });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => { observeApp(); if (shouldBoot) runBoot(); else finishBoot(); });
  } else {
    observeApp();
    if (shouldBoot) runBoot(); else finishBoot();
  }
})();
