# UI_MOTION.md — UI motion work: state, decisions, next direction

## SUPERSEDED — full redesign "AGAINST THE CURRENT" (2026-08-06)

Everything below this section is historical. The SIGNAL system (dark-first
web3 editorial: aurora hero, cyan/yellow accents, "the signal" copy) has been
fully replaced by a ground-up redesign on the user's direction: away from
Apple/MacRumors tech-mag polish, toward an irreverent sticker-book zine
(Tyler, the Creator / Golf energy — candy color on butter paper, fat retro
type, nothing corporate).

- **System** `public/design/public.css` (rewritten end-to-end, same class
  hooks): butter-cream paper `#f6eeda` + aubergine ink `#251a2e`; dark theme
  is "after hours" grape `#181022`. Twelve candy story accents (same `.a-*`
  names, retuned hues). Shrikhand is the display face (hero word, billboard,
  zone names, foot mark, story title, drop cap versal); Bricolage Grotesque
  drops to card titles/UI; Newsreader + Space Mono unchanged. Chunky 2.5px
  borders, `--r: 1.15rem` radii, hard offset shadows in ink or accent.
- **Signatures carried over**: index chip `[007]`, the frame (now a candy
  plate: `0.6rem` accent shadow), the sticker (more tilt, bigger shadow).
  New signatures: checkerboard finish lines (ticker + colophon), wavy
  squiggle underlines (masked SVG, tracks `--acc`) on section heads, hero
  doodles (✳ + ✿, bobbing), the hot pink marquee band, the inverted
  aubergine colophon slab, tilted wire cards, hero word + zone names with
  offset accent text-shadow.
- **Copy voice**: irreverent throughout — "fresh off the desk", "no
  algorithm · no autopilot · no apologies", marquee "against the current ✺
  no autopilot ✺ before it's cool ✺ sourced to the teeth ✺ still not
  sorry", "Hot off the desk", "The whole stash", outro "That's all. Go
  touch grass.", 404 "wiped out / bold move looking for it", boot lines
  "watering the flowers / ignoring the group chat". Public copy lives in
  `src/app.mjs`, `src/article-renderer.mjs`, `public/index.html`,
  `public/fx.js` (boot + theme hex `#f6eeda`/`#181022`).
- **Gotcha**: `design.css` (newsroom base) ships a global
  `p a, li a, .prose a { color: var(--green); underline }` that leaks into
  public list links; `public.css` carries a "Link cleanup" block
  neutralizing it on `.indexrow-hit`, `.beatmenu-hit`, `.src-hit`,
  `.ticker-item`, `.foot-col a`, `.zonetail a`. Newsroom CSS untouched;
  newsroom always renders light.
- **Assets**: `public/app.js` rebuilt from `src/app.mjs` (`npm run
  build:client`); `index.html` cache-busters bumped to `?v=current-v1`;
  webmanifest colors updated. CSP already allowed Google Fonts (Shrikhand
  added to the existing fonts link).
- **Verified**: 329/329 tests, lint clean, headless-Chrome screenshots of
  home (light/dark), story, topics, mobile 390px against `wrangler dev`.

The rest of this file is kept as history of the previous systems.

---

## Previous system (historical): SIGNAL (2026-08-05)

Everything below this section is historical. The riso/paste-up design system
(nameplate, knockout windows, detours, riso folios, ambient press loops,
homepage slam) has been fully replaced by a ground-up redesign:

- **Shell** `public/index.html`: new masthead (text wordmark + ✳ spark +
  theme toggle), "The wire" ticker, boot-sequence overlay `#boot`, new colophon.
- **Engine** `public/fx.js` (replaces `public/ambient-fx.js`): theme system
  (`data-theme` on `<html>`, localStorage `anyways.theme`, `?theme=light|dark`
  URL override, dark default unless OS prefers light), boot sequence (first
  `/` visit per session, skipped for reduced motion / `?fx=off`), scramble
  headlines (`[data-scramble]`), reveal-on-scroll (`[data-reveal]` + IO, with
  in-view-at-arm immediate reveal), story readbar + minutes-left chip +
  `[data-drift]` parallax, copy-link buttons. No inline styles in markup;
  JS-driven styles need `style-src-attr 'unsafe-inline'` (worker.mjs CSP).
- **Design system** `public/design/public.css`: dark-first tokens + light
  theme, 12 story accents, grain overlay, aurora hero, billboard lead, wire
  cards, marquee divider, beat modules, index lists, stickers, story page
  (ghost word, drop cap, pull quotes, drifting plate, storybar, sources as
  "The record"). Newsroom CSS was consolidated into `public/design/design.css`
  (identical content in `public/design/newsroom.css`; the preview iframe
  hard-codes design.css). Newsroom always renders light.
- **Markup**: public routes in `src/app.mjs` (home/section/topics/search/404)
  and `src/article-renderer.mjs` (story page) rewritten end-to-end. Data
  access, routing, analytics, newsroom, and the preview-control contract
  (`data-preview-control="opening|hero|detour|inline-image"`) unchanged.

The rest of this file is kept as history of the previous system.

---

## Previous system (historical)

Working notes from the UI/motion conversation. The paste-up choreography is on
branch `ui/paste-up-motion` (unmerged); the ambient press loops and the
homepage lead slam below are implemented in the working tree on top of it
(uncommitted). See the session log at the end for the chronology.

## Current branch state

- Everything lives on branch `ui/paste-up-motion`; `main` is untouched.
- To preview: `npm run dev`, open any story.
- To ship: `git checkout main && git merge ui/paste-up-motion`.
- All motion timings live in the "Paste-up motion" section at the end of
  `public/design/public.css` — delays/durations are plain numbers, one rule
  per beat.

### What the branch contains: paste-up choreography (~1.3s, once per load)

- Rainbow registration strip inks itself left-to-right on page load (site-wide).
- Accent plate lands aligned under the photo, then slips off-register as the
  photo pastes down on top; the photo "develops" (saturation/contrast) as it lands.
- № folio slaps down over-rotated with slight overshoot; ink shadow appears on
  impact, not in flight.
- Headline wipes in behind a paper edge while settling; standfirst rises;
  byline rule draws across.
- Below the fold, pieces paste up on scroll entry (opening paragraph with drop
  cap, pull-quotes, plates, rail, sources, next reads) — once each, then stillness.
- Guardrails: transform/opacity only (plus brief one-off paint effects);
  `prefers-reduced-motion` gets the assembled page (verified: zero pieces
  armed, all visible at 500ms); the newsroom preview is excluded so editors
  don't get re-animated on every draft edit; nothing replays.

### Four issues fixed on the branch

- **Entities** — `decodeEntities()` in `src/article-renderer.mjs` normalizes
  pre-encoded source titles before escaping; source 09 on the Apple story now
  renders `won't` instead of `won&#x27;t`. Covered by a new test.
- **Drop cap** — was an illegible green square (the letter I collapsing into a
  bar). Now a deliberate versal: letter knocked out of an accent plate with ink
  frame and offset shadow, matching the folio stamps. Verified on both stories.
- **Lazy images** — plates with media now wait on accent-tinted paper instead
  of solid ink.
- **Beats index** — each beat gets its own ink on its number, dotted leaders
  stay, and the index closes with an end line.

### Verification done

- 92/92 tests pass, including against the committed state alone.
- Mid-animation and settled screenshots on desktop + mobile.
- Scroll-trigger firing counts; reduced-motion emulation.
- Homepage unchanged and calm.

### Caveats

- Another session was editing this repo concurrently (photo-details dialog in
  `src/app.mjs`, `design.css`, `newsroom-media.test.mjs`, plus a new untracked
  migration for pipeline image rights). All of that was left unstaged; the
  branch carries only this work plus earlier WIP, committed separately as
  `c6681bf`.
- Consequence: the committed `public/app.js` bundle was built from this work's
  sources only — the other session's next `npm run build:client` will fold
  their changes back into the bundle.

## Homepage vs article: the difference (analysis)

The two pages currently have two motion vocabularies:

- **Homepage** — one uniform motion. Every top-level block (lead poster,
  briefing cards, detour, section modules, closer) does the same gentle 6px
  rise-and-fade, staggered ~50ms apart over 360ms. Stamp, knockout window,
  photo all just ride up with their block; nothing has its own movement. Plus
  the strip inking, which runs on every page.
- **Article** — the generic rise is switched off
  (`.route-story main > .comp { animation: none; }`) and each element gets its
  own choreographed beat (plate slip, photo develop, stamp slap, headline wipe,
  byline rule). Below the fold, nothing animates at load; pieces wait for
  scroll and paste up on entry, once.

Three seams where the switch is felt:

1. Shared components move differently across pages (№ stamp slams on article,
   merely rises on homepage; knockout window pastes down on article, only
   rises on homepage).
2. Below-fold timing differs (homepage animates at load; article defers to
   scroll).
3. Interior pages (beats, sections, search) side with the homepage's generic
   rise — the article is the lone outlier, so home → story is where you feel
   the switch.

## New direction (decided)

Article pages should get **something else**: **subtle constant animation** —
that becomes the difference between homepage and articles. (Initially the
homepage was to stay as-is; the user later asked for the lead poster to get the
slam treatment too — see "Homepage lead slam".)

Concept: **the press never quite stops running.** The homepage is a finished
object; the article is a live press run. Constant motion, but small enough
that you feel it more than see it. Fits the design language: print artifacts,
and print is never perfectly still.

### Proposed ambient loops

1. **Registration drift.** The accent plate behind the hero (and the accent
   bar on pull-quotes) slowly breathes ±1–2px and a fraction of a degree, on
   long offset loops (9–13s, staggered phases so they never sync). The photo
   stays put — only the color wanders, like a press that can't hold perfect
   alignment. The signature move: the misregistration joke, alive. Two or
   three composited transform loops, effectively free on performance.
2. **The stamp re-inks.** Every ~12–18s the № folio presses a hair deeper for
   a split second — a 400ms pulse of rotation and shadow, like someone leaned
   on the stamp again. Blink and you miss it; catch it once and you watch for
   it. The one people screenshot.
3. **The strip tracks your reading.** The rainbow strip under the nav quietly
   slides its gradient with scroll progress — a press registration mark
   doubling as a progress bar. Pure CSS scroll-driven animation
   (`animation-timeline: scroll()`), no JS; where unsupported it just sits
   still.
4. **(Optional, boldest) Newsprint flicker.** A 2–3% opacity paper grain over
   article pages only, jittering in stepped 6fps jumps. Makes the page feel
   printed-on rather than rendered-on. Most distinctive and most dangerous
   (reads as screen flicker above ~3%) — treat as a separate yes/no.

### Guardrails (unchanged)

- `prefers-reduced-motion` gets a completely static page.
- Loops pause when the tab is hidden or the element is off-screen.
- Transform/opacity only — no filter animation on the big images this time.

### What happens to the existing load choreography

~~Retired, mostly.~~ (Original proposal — superseded.) The actual decision was
to **keep** the article load choreography and layer the ambient loops on top of
it via the composable `translate`/`rotate` properties. Retiring it later is
still possible (delete the beats from the "Paste-up motion" section), but that
call is deferred until the ambient version has been seen in a browser.

## Decisions and implementation: ambient press loops

User decisions: article pages get loops **1 + 2 + 3**; newsprint grain (4) was
not built. The article load choreography is **kept** — the loops layer on top
of it (they animate the composable `translate`/`rotate` properties, so they
never fight the paste-up `transform`s). Whether to retire it is still open.
The homepage keeps its gentle rise everywhere **except the lead poster**, which
now gets the full slam treatment at the user's request (see below).

Implemented (uncommitted, on top of `ui/paste-up-motion`):

- `public/ambient-fx.js` — tiny switch loaded from `public/index.html` (CSP
  forbids inline scripts, so it is a file). Adds `fx-ambient` to `<html>`, which
  arms all three loops. `?fx=off` disables everything; `?fx=no-drift`,
  `?fx=no-stamp`, `?fx=no-strip` (comma-combinable) disable individual loops.
  Also carries the loop-3 fallback: where `animation-timeline: scroll()` is
  unsupported (Safari, Firefox) it adds `fx-strip-js` and drives `--strip-x`
  from a passive, rAF-throttled scroll listener (skipped for reduced motion).
- `public/design/public.css`, "Ambient press loops (story pages)" section —
  three labeled blocks, one per loop:
  1. **Registration drift** — the hero plate breathes ±~1.5px / ±0.14deg on an
     11s loop, delayed 1.4s so the paste-up landing reads first.
  2. **The stamp re-inks** — the hero № folio presses ~1px deeper for ~0.5s
     once per 12s loop (first press ≈12.7s after load).
  3. **The reading strip** — a 0.3rem rainbow hairline pinned to the top of the
     viewport on story pages, inking in like the nameplate strip, then sliding
     its inks with scroll progress. Pure CSS scroll-driven animation in
     Chromium; the JS fallback in ambient-fx.js covers every other browser.

Guardrails held: the newsroom preview iframe never loads the switch script, so
loops can't arm there (belt and suspenders: the plate/stamp selectors also keep
`:not([data-article-preview])`); `prefers-reduced-motion` kills loops 1–2 via
the existing `!important` reset and hides the hairline via `display: none`;
JS-off readers get the normal still page; loops 1–2 are compositor-only
transforms, loop 3 paints a 0.3rem strip on scroll (CSS timeline or one style
write per frame via the fallback).

## Homepage lead slam

The lead poster assembles with the story-page beats — plate lands and slips
off-register, photo pastes down and develops, folio is stamped, headline is
laid on, kicker/standfirst/byline follow. Everything else on the homepage
keeps the generic rise. This is load choreography, not an ambient loop, so it
is **not** gated behind the fx switches. One labeled block ("Homepage lead
paste-up (the slam)") at the end of `public/design/public.css`:

- `main > .edition-lead` has its generic rise switched off (same move as
  `.route-story main > .comp`).
- The `stamp-slam` keyframes now read `var(--stamp-ink, var(--ink))` for the
  shadow; the homepage lead sets `--stamp-ink: var(--paper)` because its stamp
  casts a paper shadow on the accent field. Article behavior unchanged.
- Its own reduced-motion reset (`animation: none !important` on every animated
  lead piece) — the shared `.route-story .comp *` reset does not reach the
  homepage, and without it these later, more specific rules would override the
  older non-important resets.
- To drop: delete the block; the lead returns to the plain rise.

### Preview and drop

- Preview: `npx wrangler dev` (or `npm run dev`, which also rebuilds
  `public/app.js` — that will fold any uncommitted `src/` changes into the
  bundle), open a story. Compare against `?fx=off`, `?fx=no-drift`,
  `?fx=no-stamp`, `?fx=no-strip`. Loop 3 works in every browser; only
  Chromium uses the pure-CSS path.
- Drop one loop: delete its labeled block from `public/design/public.css`.
- Drop the homepage slam: delete the "Homepage lead paste-up (the slam)" block.
- Drop the ambient feature: delete the whole "Ambient press loops" section,
  `public/ambient-fx.js`, and its `<script>` tag in `public/index.html`.

### Verification (done, Chromium headless via CDP against `wrangler dev`)

- Default story page: `<html>` gets `fx-ambient`; plate runs
  `paste-reg, reg-drift`; folio runs `stamp-slam, stamp-reink` at durations
  `0.5s, 12s`; hairline present with `strip-ink, strip-track`; scroll-driven
  gradient position tracks exactly (0% at top → 90.4% at 90.4% scroll).
- Strip fallback wiring: forcing `fx-strip-js` drops `strip-track` and the
  hairline's `background-position-x` follows `--strip-x` (verified at 55%).
  The fallback's scroll listener itself only arms where `scroll()` is
  unsupported, so it could not be exercised in Chromium — Safari/Firefox
  deserve a manual look.
- `?fx=no-drift`: plate back to `paste-reg` only, other loops untouched.
- `?fx=off`: no `fx-ambient`, all loops off, load choreography intact.
- Reduced motion: plate/folio `animation-name: none`, hairline `display: none`.
- Homepage slam: lead's generic rise off (`animation-name: none`), every lead
  piece on its beat (`paste-reg`, `paste-photo`, `paste-develop`, `stamp-slam`,
  `rise-in`, `headline-lay`, `rule-draw`), second block still `rise`, no
  hairline on the homepage, reduced-motion all `none`. Mid-beat and settled
  screenshots checked; the stamp keeps its paper shadow.
- 92/92 tests pass.

## Session log

1. **Paste-up branch** (`ui/paste-up-motion`, earlier session): the full
   load-time paste-up choreography for story pages plus four fixes (entities,
   drop cap versal, lazy-image paper, beats-index inks). 92/92 tests; ready to
   merge whenever the user is happy with it in the browser.
2. **Direction change → ambient loops** (this session, uncommitted): user
   found the article animation too different from the homepage and asked for
   subtle *constant* motion on articles instead. Built loops 1 (registration
   drift), 2 (stamp re-ink), 3 (reading strip) behind URL preview switches
   (`?fx=off`, `?fx=no-*`), each a self-contained deletable CSS block; the
   article load choreography was kept underneath them; grain (loop 4) declined.
   Recorded in `UI_MOTION.md` at the user's request.
3. **Refinements** (this session, uncommitted): (a) reading-strip fallback so
   Safari/Firefox get the hairline too — pure-CSS scroll timeline in Chromium,
   `--strip-x` driven by a passive scroll listener elsewhere; (b) stamp re-ink
   cadence 14s → 12s at the user's request; (c) homepage lead poster now gets
   the slam treatment (plate slip, photo develop, stamp with paper shadow via
   new `--stamp-ink`, headline wipe, kicker/standfirst/byline) while the rest
   of the homepage keeps the quiet rise — one deletable block, not gated by the
   fx switches. All verified in headless Chromium (computed styles, toggles,
   reduced motion, screenshots); 92/92 tests still pass.

Open threads: merge or iterate on `ui/paste-up-motion`; commit or discard the
uncommitted ambient + slam work (and whether it joins that branch or waits);
whether to retire the article load choreography after living with the ambient
version; manual strip check in a real Safari/Firefox; the other session's
unstaged work (`src/app.mjs`, `design.css`, `test/newsroom-media.test.mjs`,
dirty `public/app.js`, untracked image-rights migration) still needs its owner
to commit it.
