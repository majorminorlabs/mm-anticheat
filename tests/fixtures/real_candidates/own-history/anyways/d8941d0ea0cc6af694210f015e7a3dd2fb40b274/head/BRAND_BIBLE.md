# Anyways brand bible

Status: current code audit

Audited: 2026-08-10

This document records the visual system that is actually defined in the
repository. Hex values and font names below are copied from source code. They
are not sampled from screenshots or inferred from rendered pixels.

## Source of truth

The public shell loads styles in this order from `public/index.html`:

1. `public/design/design.css`
2. `public/design/public.css`

The body receives `public-site` for every route except `/newsroom`, and
`newsroom-site` for newsroom routes in `src/app.mjs`. Because `public.css` is
loaded after `design.css`, public selectors and tokens can override earlier
shared values. The exact cascade matters here.

The repository already contains related design documentation:

- `docs/design/anyways-design.md` is the public design direction, titled “The
  Composed Edition”. It describes the risograph vocabulary, article
  compositions, marginalia, and editorial rules, but its typography and some
  palette names do not match every current CSS value.
- `UI_MOTION.md` is a historical decision log. Its current-direction section
  describes the sticker-book redesign, but it is explicitly marked superseded
  and should not replace the loaded CSS as a token reference.
- `fonts/LeagueGothic-OFL.md` documents the local League Gothic font asset.

`public/design/newsroom.css` is present but is not linked by the current HTML
shell. The loaded newsroom stylesheet is the newsroom portion of
`public/design/design.css`.

## Brand character

The public edition is an irreverent editorial zine. The code describes it as
butter paper, aubergine ink, candy accents, fat retro type, chunky borders,
hard offset shadows, tilted stickers, doodles, signal bars, and a playful
motion layer. It is intentionally editorial and tactile rather than a smooth
technology or corporate interface.

The newsroom is the desk behind the public edition. It uses the same broad
paper-and-ink family, but its final cascade is quieter: ruled sections,
editorial headings, mono labels, compact controls, and restrained red hover
states. It should read as a working desk, not as another public story page.

## Typography

### Public edition roles

| Role | Exact family stack in code | Source and use |
| --- | --- | --- |
| Display | `"League Gothic Italic", "Arial Narrow", Arial, sans-serif` | `public/design/public.css:14`; local `public/design/LeagueGothic-Italic.woff2`; masthead, large display headings, marquee, ghost words, and outro display. |
| Head/UI | `"Bricolage Grotesque", "Arial Black", Arial, sans-serif` | `public/design/public.css:15`; card titles, index titles, and selected interface headings. |
| Editorial serif | `"Newsreader", Georgia, "Times New Roman", serif` | `public/design/public.css:16`; body copy and editorial reading text. |
| Mono/meta | `"Space Mono", ui-monospace, "SF Mono", Menlo, Consolas, monospace` | `public/design/public.css:17`; labels, metadata, chips, share controls, ticker metadata, and desk-like microcopy. |

The HTML imports these Google font families and ranges:

- Bricolage Grotesque, optical size `12..96`, weight `200..800`
- Newsreader, optical size `6..72`, weights `400`, `500`, and `600`, with
  selected italic styles
- Space Mono, normal weights `400` and `700`, plus italic `400`

The exact import is in `public/index.html:15-18`.

The local League Gothic face is declared as:

```css
@font-face {
  font-family: "League Gothic Italic";
  src: url("/design/LeagueGothic-Italic.woff2") format("woff2");
  font-style: normal;
  font-weight: 400;
  font-display: swap;
}
```

The family name includes “Italic”, but the declaration sets `font-style:
normal`. That is the exact implementation behavior.

### Shared and newsroom declarations

The shared base in `public/design/design.css:22-23` declares:

- Serif: `"Newsreader", Georgia, "Times New Roman", serif`
- Mono: `"IBM Plex Mono", ui-monospace, "SF Mono", Menlo, Consolas, monospace`

The newsroom refresh later overrides the shared values in
`public/design/design.css:1091-1103`:

- Display: `"Shrikhand", "Cooper Black", Georgia, serif`
- Mono: `"Space Mono", ui-monospace, "SF Mono", Menlo, Consolas, monospace`

Shrikhand is not imported by `public/index.html` and no local Shrikhand asset
exists in the repo. The effective newsroom display therefore depends on the
browser falling back to `Cooper Black`, then Georgia, unless another external
font source is supplied. This is a code discrepancy, not a guessed visual
match.

### Type behavior

- Body size is `1.0625rem` with `line-height: 1.55`.
- Body text uses `font-optical-sizing: auto`, optimized text rendering, and
  antialiasing.
- Public headings use the display family, `font-weight: 400`, `line-height:
  1.02`, `letter-spacing: -0.01em`, and `text-wrap: balance`.
- Public mono labels are commonly uppercase with letter spacing between
  `0.01em` and `0.10em`; the smallest editorial micro labels use
  `0.66rem`.
- The public body measure is `42rem`; the wide layout is `86rem`; the rail is
  `13rem`.
- The shared desk base uses a serif reading face and mono-led labels. Its
  common sizes are `0.68rem` micro, `0.75rem` label, and `0.8rem` metadata.

## Color system

### Public edition: light theme tokens

These are the primary public values from `public/design/public.css:24-41`.

| Token | Exact hex | Meaning |
| --- | --- | --- |
| `--bg` | `#f6eeda` | Butter-paper page background |
| `--bg-raise` | `#fdf6e6` | Raised cards and panels |
| `--bg-sink` | `#eee1c3` | Recessed paper, preview, and stage surfaces |
| `--fg` | `#251a2e` | Aubergine primary ink |
| `--fg-soft` | `#5a4d66` | Secondary text |
| `--fg-faint` | `#8b7f95` | Faint metadata and labels |
| `--line` | `#ddd0b2` | Soft rules |
| `--line-strong` | `#251a2e` | Strong rules and borders |
| `--shadow` | `#251a2e` | Default hard shadow |
| `--inv-bg` | `#251a2e` | Inverted colophon/slab background |
| `--inv-fg` | `#f6eeda` | Inverted slab text |
| `--band` | `#ff6fa5` | Hot marquee band |
| `--on-band` | `#2b0a1c` | Text on the hot band |

Other public geometry tokens are `--bw: 2.5px` and `--r: 1.15rem`.

### Public edition: dark theme tokens

Applied by `html[data-theme="dark"]` in `public/design/public.css:64-79`.

| Token | Exact hex |
| --- | --- |
| `--bg` | `#181022` |
| `--bg-raise` | `#241631` |
| `--bg-sink` | `#0f0917` |
| `--fg` | `#f6eeda` |
| `--fg-soft` | `#c8b8d4` |
| `--fg-faint` | `#8f7fa0` |
| `--line` | `#3a2a4c` |
| `--line-strong` | `#f6eeda` |
| `--shadow` | `#060309` |
| `--inv-bg` | `#f6eeda` |
| `--inv-fg` | `#251a2e` |

Theme selection is controlled by `public/fx.js`: an explicit `?theme=` value
wins, then local storage, then the operating-system preference. The HTML
theme-color values are `#181022` for dark and `#f6eeda` for light.

### Public story accents

`src/app.mjs:372` defines the actual accent order used by published stories.
The later `public.css` definitions are the active public values for these
classes.

| Accent class | `--acc` | `--on-acc` |
| --- | --- | --- |
| `.a-cyan` | `#4db2f5` | `#0c2c44` |
| `.a-magenta` | `#ff6fa5` | `#4a0e2e` |
| `.a-mustard` | `#eda407` | `#3d2b00` |
| `.a-yellow` | `#ffd23f` | `#4d3b00` |
| `.a-brick` | `#e2543e` | `#fff1ea` |
| `.a-cobalt` | `#6a5cf0` | `#f0edff` |
| `.a-coral` | `#ff5d45` | `#430c00` |
| `.a-mint` | `#6fdc9c` | `#0e3a22` |
| `.a-lime` | `#a8e34a` | `#263600` |
| `.a-peach` | `#ffab73` | `#4a1f00` |
| `.a-lavender` | `#c5a3ff` | `#2a1150` |
| `.a-deepgreen` | `#3ecf8e` | `#062e1d` |

The default accent is `.a-magenta`: `--acc: #ff6fa5` and `--on-acc:
#4a0e2e`. Accent assignment is deterministic and avoids recent repeats in
`src/app.mjs:392-400`.

### Shared/newsroom colors

The shared base starts with this paper-and-ink set in
`public/design/design.css:10-20`:

| Token | Exact hex |
| --- | --- |
| `--paper` | `#f6f2e8` |
| `--paper-raised` | `#fbf8f0` |
| `--ink` | `#16211b` |
| `--ink-soft` | `#4c5750` |
| `--ink-faint` | `#657068` |
| `--green` | `#164c37` |
| `--red` | `#b23a1d` |
| `--amber` | `#8a5a12` |
| `--line` | `#d9d2c0` |
| `--line-strong` | `#b7ad96` |

The earlier newsroom block in `design.css:886-900` introduces:

`#f4efe2` paper, `#fffaf0` raised paper, `#071f30` ink,
`#314957` soft ink, `#536873` faint ink, `#087a58` green,
`#e13b2b` red, and `#c9c0ab` line.

The later newsroom refresh in `design.css:1091-1103` changes the component
tokens to:

`#f6eeda` paper, `#fdf6e6` raised paper, `#251a2e` ink,
`#5a4d66` soft ink, `#8b7f95` faint ink, `#251a2e` green,
`#ff6fa5` red, and `#ddd0b2` line.

The public stylesheet also assigns newsroom chrome variables
`--bg: #f4efe2`, `--bg-raise: #fffaf0`, `--bg-sink: #e8e3d2`,
`--fg: #071f30`, `--fg-soft: #314957`, `--fg-faint: #536873`,
`--line: #c9c0ab`, `--line-strong: #071f30`, and `--shadow: #071f30` in
`public/design/public.css:82-95`. Since some newsroom selectors use
`--paper`/`--ink` and others use `--bg`/`--fg`, the newsroom currently has a
mixed effective cascade rather than one single computed palette.

### Additional literal colors in the loaded shared stylesheet

These exact literals are used for newsroom controls, previews, analytics,
status states, and focus/hover treatments in `public/design/design.css`:

`#00c2df`, `#052631`, `#06291a`, `#08333c`, `#087a58`, `#0c3a26`,
`#13b5cf`, `#16211b`, `#164c37`, `#182100`, `#211d00`, `#221d14`,
`#2b4bd8`, `#2c0803`, `#2f4000`, `#3155d9`, `#4a3302`, `#4c5750`,
`#4d4700`, `#512700`, `#571208`, `#57270a`, `#63d6a4`, `#657068`,
`#6fe1b1`, `#7a4fd0`, `#8a5a12`, `#9ecb0f`, `#b23a1d`, `#b3402a`,
`#b7ad96`, `#b8e100`, `#b9a0ff`, `#d6246e`, `#d9a410`, `#d9d2c0`,
`#d9d5cc`, `#ded9cf`, `#e13b2b`, `#eef1fd`, `#eef8f5`, `#efe200`,
`#f1ebfc`, `#f47b20`, `#f6f2e8`, `#fbf8f0`, `#fdeee9`, `#fdf0f5`,
`#ff5c47`, `#ff5d4a`, `#ffab7a`, `#ffad7a`, `#ffdc6b`, `#ffe500`,
`#fff`, `#fff1a6`, and `#fffdf8`.

The loaded public stylesheet contains one additional fallback literal,
`#ff5d9e`, in `accent-color: var(--red, #ff5d9e)`.

### Non-hex color syntax

The code also uses exact non-hex color expressions. Important examples are:

- `rgb(7 31 48 / 3%)`, `rgb(7 31 48 / 16%)`, `rgb(7 31 48 / 22%)`, and
  `rgb(7 31 48 / 52%)` for newsroom grid, shadows, and backdrops
- `rgb(0 194 223 / 28%)` for the analytics chart
- `rgb(244 239 226 / 35%)` for newsroom navigation separators
- `rgb(37 26 46 / 16%)` and `rgb(37 26 46 / 12%)` for article preview
  shadows
- `rgb(0 0 0 / 12%)` for article preview shadows
- `color-mix(in srgb, ...)` for accent-tinted paper, hover rows, transparent
  overlays, and translucent story bars
- `currentColor` and `transparent` for inherited marks, borders, and clear
  surfaces

## Logo and brand assets

The public masthead layers `public/brand/logo-nocursor.svg` and
`public/brand/logo-cursor.svg`. The footer uses
`logo-nobox-dark.png` and `logo-nobox-light.png`; the tab icon is
`public/brand/tab-icon.png`.

The source SVG logo colors are:

- `#ffd23f` yellow background
- `#211d00` dark yellow-ink lettering and cursor details
- `#ff6fa5` cursor accent
- `#f6eeda` light stroke
- `#1a1a1a` dark logo/icon artwork

The logo is a visual asset, not a text lockup rendered with the site font.

## Signature style choices

### Public composition

- Chunky borders use `2.5px`; most public cards and stickers use a
  `1.15rem` radius.
- Offset shadows are hard-edged, usually `0.22rem` to `0.8rem`, and use the
  current ink or story accent rather than a blurred shadow.
- Wire cards tilt by `-0.8deg` and `0.8deg`; stickers start at `-1.6deg`.
  Hover states straighten the element and lift it with a translated hard
  shadow.
- The signal mark is three rising bars. It uses `currentColor` and rounded
  upper corners.
- The page uses an always-on grain overlay at `opacity: 0.05`, increasing to
  `0.07` for the light theme.
- Frames use accent-tinted paper and a dotted/radial print texture. Images
  can appear as billboard, story, card, portrait, square, and fit-contain
  compositions.
- The hero adds aurora-like radial gradients, doodle marks, a large display
  word with an accent text shadow, and an offset accent plate.
- The marquee is a full-width hot-pink band with uppercase display type. The
  colophon is an inverted aubergine slab with a checkerboard finish line.
- Public links are mostly inherited color with accent hover states. The code
  uses underlines, accent bottom rules, dotted leaders, chips, pills, and
  signal bars as editorial marks.

### Motion and interaction

- Motion is opt-in through the `motion` class in `public/fx.js`.
- The boot sequence runs only on the public home route, once per session.
- The public layer animates the spark, ticker, marquee, hot chip, story frame,
  hero aurora, doodles, stickers, loading state, and scroll reveals.
- Transitions use the exact easing tokens `cubic-bezier(0.22, 1, 0.36, 1)`
  and `cubic-bezier(0.34, 1.4, 0.44, 1)`.
- `prefers-reduced-motion: reduce`, `?fx=off`, and no-JavaScript paths are
  designed to leave a still page. Reduced motion removes animation and
  shortens transitions to near-zero.
- Theme changes update the HTML `data-theme` attribute and the theme-color
  meta tag before paint where possible.

### Responsive behavior

- The public layout uses a fluid gutter from `1rem` to `3.5rem`.
- The main public responsive breakpoints are `720px`, `760px`, `1080px`, and
  `1400px`, with smaller component-specific rules at `560px`.
- At mobile widths, sections collapse into a disclosure menu, cards become
  single-column or horizontal snap rows, and the story rail moves into the
  reading flow.
- The newsroom switches its editor grid to one column below `880px`, uses
  compact desk spacing below `720px`, and collapses Source Graph controls
  below `700px`.

## Current implementation notes

1. `public/design/public.css` is the authoritative public token file currently
   loaded by the shell.
2. `public/design/design.css` remains the authoritative loaded newsroom/base
   file, but it contains multiple historical newsroom layers. The final desk
   refresh appears near the end of the file.
3. `public/design/newsroom.css` is an alternate copy that is not linked by
   `public/index.html`.
4. `docs/design/anyways-design.md` names IBM Plex Mono and a different
   risograph palette. Those values are design-history guidance, not the exact
   public CSS currently loaded.
5. `design.css` assigns Shrikhand to the newsroom, but the current HTML only
   imports Bricolage Grotesque, Newsreader, and Space Mono from Google Fonts.
   If Shrikhand is intended to be the newsroom display face, the font import
   or a local font asset needs to be added separately.
6. There are two public accent vocabularies in the repo. The active public
   `src/app.mjs`/`public.css` pair uses `lavender` and `deepgreen`. The shared
   design layer and older design guide use `violet` and `tangerine` with
   different values. New work should follow the `PALETTE` array in
   `src/app.mjs` and the matching later rules in `public.css`.

## Quick reference files

- Public shell and font imports: `public/index.html`
- Public tokens and components: `public/design/public.css`
- Loaded shared/newsroom styles: `public/design/design.css`
- Unlinked newsroom stylesheet: `public/design/newsroom.css`
- Theme and motion controller: `public/fx.js`
- Accent assignment: `src/app.mjs`
- Logo assets: `public/brand/`
- Existing design direction: `docs/design/anyways-design.md`
