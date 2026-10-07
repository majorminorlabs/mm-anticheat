/* Anyways · signal engine.
   One classic script, loaded synchronously in <head> (CSP forbids inline
   scripts). Owns: color theme, lightweight text effects, scroll
   reveals, masthead/ticker behavior, story-page progress. Everything is
   additive: no-JS, reduced-motion, and `?fx=off` all get the still page. */
(() => {
  const root = document.documentElement;
  const motionQuery = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
  const fxOff = (new URLSearchParams(location.search).get('fx') || '') === 'off';
  const isPublic = !location.pathname.startsWith('/newsroom');
  let motion = !(motionQuery?.matches) && !fxOff;

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
    if (toggle) {
      toggle.setAttribute('aria-pressed', theme === 'dark' ? 'true' : 'false');
      toggle.setAttribute('aria-label', theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme');
    }
  }

  applyTheme(initialTheme);

  /* ---------- Boot sequence ---------- */

  /* The publication shell must be usable immediately. The old full-screen
     boot treatment was decorative, but it also made first paint and failed
     client loads look like an outage. */
  const shouldBoot = false;
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
      if (!motion) {
        el.style.removeProperty('transform');
        continue;
      }
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
    /* Ticker: duplicate the track for a seamless loop, once. Keep the clone
       out of the accessibility tree and keyboard order. */
    const track = scope.querySelector('#ticker-track');
    if (track && track.children.length && !track.dataset.looped) {
      track.dataset.looped = '1';
      [...track.children].forEach(item => {
        const clone = item.cloneNode(true);
        clone.setAttribute('aria-hidden', 'true');
        clone.setAttribute('inert', '');
        clone.querySelectorAll('a,button,[tabindex]').forEach(control => control.setAttribute('tabindex', '-1'));
        track.appendChild(clone);
      });
    }
    const ticker = scope.querySelector('#ticker');
    const tickerToggle = scope.querySelector('#ticker-toggle');
    if (ticker && tickerToggle && !tickerToggle.dataset.wired) {
      tickerToggle.dataset.wired = '1';
      tickerToggle.addEventListener('click', () => {
        const paused = ticker.classList.toggle('is-paused');
        tickerToggle.setAttribute('aria-pressed', paused ? 'true' : 'false');
        tickerToggle.textContent = paused ? 'Play' : 'Pause';
      });
    }
    /* Scramble marked headlines, once each. */
    for (const el of scope.querySelectorAll('[data-scramble]:not([data-scrambled])')) {
      el.dataset.scrambled = '1';
      scramble(el, Number(el.dataset.scramble) || 750);
    }
    for (const button of scope.querySelectorAll('[data-native-share]:not([data-native-share-ready])')) {
      button.dataset.nativeShareReady = '1';
      if (navigator.share) button.hidden = false;
    }
    reveals(scope);
  }

  /* Copy-link buttons (story share row). */
  document.addEventListener('click', event => {
    const nativeShare = event.target.closest('[data-native-share]');
    if (nativeShare && navigator.share) {
      navigator.share({
        title: nativeShare.dataset.shareTitle || document.title,
        url: nativeShare.dataset.shareUrl || location.href
      }).then(() => announce('Story shared.')).catch(error => {
        if (error?.name !== 'AbortError') announce('Share failed. You can copy the story link instead.');
      });
      return;
    }
    const button = event.target.closest('[data-copy-link]');
    if (!button) return;
    const done = () => {
      const label = button.dataset.label || button.textContent;
      button.dataset.label = label;
      button.textContent = 'copied ✓';
      button.classList.add('is-copied');
      announce('Story link copied.');
      setTimeout(() => { button.textContent = label; button.classList.remove('is-copied'); }, 1600);
    };
    const shareUrl = button.dataset.shareUrl || location.href;
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(shareUrl).then(done).catch(() => announce('Copy failed. The story link is available in the address bar.'));
    } else {
      announce('Copy is unavailable. The story link is available in the address bar.');
    }
  });

  function announce(message) {
    const region = document.querySelector('#sr-status');
    if (!region) return;
    region.textContent = '';
    window.setTimeout(() => { region.textContent = message; }, 20);
  }

  function updateMotion(event) {
    motion = !event.matches && !fxOff;
    root.classList.toggle('motion', motion);
    if (!motion) {
      document.querySelectorAll('[data-drift]').forEach(el => el.style.removeProperty('transform'));
      document.querySelectorAll('.ticker-track, .marquee-track').forEach(el => el.style.removeProperty('transform'));
    }
  }
  motionQuery?.addEventListener?.('change', updateMotion);

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
