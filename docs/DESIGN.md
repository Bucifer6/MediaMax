# Lumen: the Kinora design language

> The interface is lit by the films.

Lumen is the look of the Kinora web app (and the TV app, which is the same app in TV mode). The picture on
screen supplies the light: the featured title's artwork tints the whole page with a soft glow that drifts behind
frosted-glass surfaces and cross-fades as the hero or the focused title changes. The active theme stays the base;
artwork light is layered on top of it and never costs readability.

Screenshots: `docs/screenshots/home.jpg`, `item-movie.jpg`, `peek.jpg`, `command-palette.jpg`, `login.jpg`,
`profiles.jpg`, `player.jpg`, `trickplay.jpg`, `tv-mode.jpg`, `home-light.jpg`, `item-light.jpg`, `mobile-home.jpg`,
`admin-dashboard.jpg`, and the theme gallery `themes-grid.jpg`.

## Building blocks

| Piece | Where |
| --- | --- |
| Ambient light (palette sampling, contrast fitting, store) | `web/src/theme/ambient.ts` |
| The light field behind the app | `web/src/components/AmbientLight.tsx` |
| Visual-effects level (lite / full) | `web/src/theme/fx.ts` |
| Rail, command bar, tab bar | `web/src/components/Layout.tsx`, `styles/layout.css` |
| Command palette (⌘K / Ctrl+K / "/") | `web/src/components/CommandPalette.tsx` (lazy chunk) |
| Peek cards | `web/src/components/Peek.tsx` (store, handlers) + `PeekCard.tsx` (lazy chunk) |
| Card light-catch and tilt | `web/src/hooks/useCardLight.ts` |
| Poster → title page transition | `web/src/utils/viewTransition.ts` |
| Signed-out light field | `web/src/components/LightField.tsx` |
| Fonts | `web/src/styles/fonts.css` |
| Everything Lumen adds on top of the base styles | `web/src/styles/lumen.css` |

## Colour and themes

Every colour still comes from the theme (`server/src/services/themes.ts`, Branding Studio) through the existing
CSS variables set by `web/src/theme/applyTheme.ts`:

| Theme field | Variable | Used for |
| --- | --- | --- |
| colours | `--c-primary`, `--c-bg`, `--c-surface`, `--c-text`, … | everything; glass is `color-mix()` of `--c-surface` |
| radius | `--radius`, `--radius-sm`, `--radius-lg` | buttons, panels, the rail, peek cards, palette |
| poster shape | `--poster-radius` | posters, peek cards, Continue Watching frames |
| card size | `--card-w` | rows and grids (Continue Watching frames are 2× wide) |
| font | `--font`, `--font-display` | text face; headings use the display face (below) |
| mode | `data-mode` | light themes get lighter glass, softer shadows, multiply-blended grain |

Lumen adds derived tokens in `styles/base.css`: `--glass-bg`, `--glass-bg-strong`, `--glass-border`, `--glass-hi`
(the 1 px top highlight), `--glass-blur`, and the rail geometry (`--rail-w`, `--rail-open-w`, `--rail-gap`).
Starter looks and seasonal themes are ordinary themes, so they apply unchanged.

### Artwork light

1. **Sampling (client-side, cached).** `paletteFor(url)` draws an 80 px copy of the image (the server's resized
   variant, `?w=80`) onto a 24 × 24 canvas and picks three colours from a 4-bit histogram weighted towards saturated
   mid-tones. Results are kept in memory and in `localStorage` (`mm.palettes.v1`, last 240 images), so each image is
   sampled once per browser. Only same-origin `/api/v1/images/…` URLs are sampled; anything else has no palette.
   No server or API changes, and nothing new is exposed.
2. **Fitting to the theme.** `fitToTheme()` blends each colour a little towards the theme background, then darkens
   (dark themes) or lightens (light themes) it until the theme's *muted* text colour has ≥ 4.6:1 contrast on it, so
   body text has far more. The light is painted as gradients from these colours to transparent over the theme
   background, so every pixel is a blend of colours that already pass WCAG AA. (Covered by `web/test/ambient.test.ts`.)
3. **Who sets it.** The hero (current slide), the title page (its backdrop), an open peek card and the command
   palette's highlighted title. Layout resets to the theme's own light on every route change (in a layout effect,
   before pages set theirs). With no artwork the field glows in the theme's primary and accent.
4. **Tinted buttons.** `tintFrom()` picks the most saturated artwork colour and adjusts it until a white or near-black
   label has ≥ 4.6:1; it is published as `--art-tint` / `--art-tint-text` and used by the title page's buttons.
   The High Contrast theme never gets a tint.

## Typography

- **Display: Bricolage Grotesque** (variable: weight 200–800 + optical size). Characterful at hero sizes, tidy at
  row-title sizes thanks to optical sizing. Used for `h1`/`h2`, hero and title-page titles, row titles, stat values,
  the reel counter, peek titles.
- **Text: Figtree** (variable: weight 300–900, upright + italic). Highly legible at small sizes, friendly geometric
  shapes that sit well beside Bricolage.

Both are self-hosted from `@fontsource-variable/*` npm packages (`styles/fonts.css`): no font CDN at runtime,
Latin + Latin Extended subsets only (Romanian ș ț ă î â, Central European, Turkish, …), `font-display: swap`.

Theme mapping (`displayFont()` in `applyTheme.ts`): themes using Figtree (or the old generic Inter / Plus Jakarta
Sans) get the Lumen pairing; a theme with a face of its own (Film Noir's Playfair, Playground's Baloo, …) uses it for
headings too, so its character survives. Built-in themes that used Inter or Plus Jakarta Sans now use the self-hosted
pairing and have no font URL; the few themes with a distinctive face still load it from their font URL, as before.

## Layout

- **Rail.** A slim floating glass rail (68 px; 76 px on TV) with icons. It widens to 248 px with labels on hover or
  when anything inside it has keyboard / D-pad focus. It floats over the page (clip-path reveal, no reflow).
  Libraries, Live & IPTV and You are collapsible groups (state remembered per device); Admin and Settings sit at the
  foot. Every destination of the old sidebar is still in it.
- **Command bar.** Transparent over the hero, glass once the page scrolls: the ⌘K trigger, notifications, account.
- **Command palette.** ⌘K / Ctrl+K / "/" anywhere. Titles and channels (server search), people (Discover, when
  requests are on), every page the rail offers, admin pages for admins, settings pages and actions (switch profile,
  shortcuts, sign out). "Search everything" opens the full search page. Arrow keys + Enter; on TV the options are
  D-pad stops. Moving over a title lights the page with its artwork.
- **Phones (≤ 900 px).** A floating glass tab bar (Home, Search, Live, My List, More); "More" opens the rail as a
  drawer with labels.

## Home

- **Hero.** Full-bleed under the rail and command bar. Layers: backdrop slides (slow Ken Burns, cross-fade),
  trailer preview (fades in after 3 s when previews are on, as before), shade + vignette, static film grain, logo
  layer, info layer. Scroll parallax moves the backdrop slower than the page and lifts/fades the title block.
  Auto-advance is shown as a **reel**: a sprocketed film-strip of the featured titles with a counter; the current
  frame fills as its time runs out (pauses on hover / focus / while a trailer plays).
- **Rows.** Staggered entrance down the page, native momentum on touch / trackpads plus mouse drag with inertia,
  soft edge fades where there's more to scroll, glass arrow buttons.
- **Posters.** Light-catch sheen that follows the pointer and a gentle 3D tilt; lift + ring on focus.
- **Peek cards.** After a short dwell (650 ms hover, 1.1 s D-pad focus) an expanded card grows out of the poster:
  backdrop (or trailer), logo/title, year · runtime · rating, genres, progress and Play / My List / More info. It is
  drawn in a portal over the page, so rows never reflow, and closes on leave, scroll, Esc or the remote's Back.
- **Continue Watching.** Wide frames with the title, episode and "min left" inside the picture and the progress bar
  along the bottom edge.
- **Top 10.** Huge outlined display numerals, filled from below with the page's light.

## Title page

- Poster → title page is a **shared-element transition** (View Transitions API) where supported: the card hands its
  item over in history state so the page can draw the poster and backdrop on the first frame. Elsewhere (TV
  browsers, Firefox, lite mode, reduced motion) the page simply fades in.
- The backdrop runs full-bleed and dissolves into the ambient light (mask) instead of ending in a hard edge.
- Buttons are tinted from the artwork; metadata is a dotted line; credits sit under a hairline.
- Seasons and episodes are a **film-strip**: frames in a sprocketed band that scrolls sideways.
- Cast portraits are quiet (desaturated) until hovered / focused, then light up and reveal the role.

## Sign-in and "Who's watching?"

An abstract, slowly drifting field of light in the theme colours, with a projector-beam sweep and grain, behind the
server's branding and a glass sign-in card. No library artwork is shown before sign-in (the page is public); an
admin-set login background still shows underneath. Choosing a profile: the tile steps forward while the others fall
away, then sign-in continues.

## Player

Minimal, auto-hiding chrome: display-face title, a larger scrubber (5 → 9 px on hover / focus) with a glowing fill
and trickplay thumbnails in a rounded glass preview, glass panels for audio / subtitles / quality, a glass
"Skip intro" pill with a sweep of light and a glass Up Next card.

## Admin

Same language, calmer and denser: half-strength ambient light, glass side menu, compact stat tiles with display-face
numbers, Now Playing cards with soft depth, tighter tables with tabular figures. No admin flow changed.

## Motion

Tokens in `styles/base.css`:

| Token | Value | Use |
| --- | --- | --- |
| `--dur-1` | 120 ms | press, hover colour |
| `--dur-2` | 200 ms | small state changes |
| `--dur-3` | 320 ms | panels, cards, peek, rail |
| `--dur-4` | 560 ms | page-level entrances |
| `--dur-light` | 1400 ms | ambient light and hero cross-fades |
| `--ease-out` | `cubic-bezier(0.22, 1, 0.36, 1)` | entrances |
| `--ease-in-out` | `cubic-bezier(0.65, 0, 0.35, 1)` | drifts, cross-fades |
| `--ease-spring` | `cubic-bezier(0.34, 1.56, 0.64, 1)` | small overshoot: buttons, icons, peek, palette |
| `--stagger` | 55 ms | row entrance |

Rules: animate `transform` and `opacity` only (the rail reveal uses `clip-path`); exits are faster than entrances;
motion explains where something came from (peek grows out of its poster, palette drops from the top, menus from
their button). No animation library: CSS plus a few small hooks.

**Reduced motion** (`prefers-reduced-motion: reduce`): animations collapse to instant, transitions to 120 ms fades;
no tilt, parallax, Ken Burns, drift or view transitions; peek cards appear without scaling. The ambient light still
changes colour (a fade), and spinners and the hero reel's progress keep running because they carry information.

## Lite mode

`html.lite` (`web/src/theme/fx.ts`) drops the expensive layers while keeping the look finished:

- no `backdrop-filter` anywhere (very slow on TV browsers); glass becomes near-opaque theme surface;
- no drifting light, parallax, Ken Burns, film grain, projector beam, card tilt / sheen, edge masks, row stagger;
- the title backdrop ends in a gradient instead of a mask.

It turns itself on in TV mode, on devices with ≤ 4 logical cores or ≤ 2 GB memory, and when a short idle frame-rate
sample shows a median frame over 28 ms. Viewers can force **Automatic / Full / Lite** in Settings → Appearance →
Visual effects (stored per device as `mm.fx`).

## TV mode

`/?tv=1` (or a TV user agent). D-pad spatial navigation reaches the rail (it opens while focused), the command-bar
trigger, peek-card actions (Down from a focused poster once the peek is open) and palette options. Focus rings are
4 px in the primary colour (inset rings inside the rail). The rail, command bar and content sit inside a 3 % overscan
safe area; full-bleed art still runs to the edges. Back closes an open peek first (focus returns to its poster), then
dialogs, then goes back a page. Lite mode is on by default.

## Accessibility

Keyboard everywhere (skip link, rail groups are buttons with `aria-expanded`, palette is a `combobox` + `listbox`
with `aria-activedescendant` and a focus trap, peek cards are labelled groups), visible focus rings, WCAG AA contrast
kept under the artwork light, reduced-motion support, 44 px touch targets on the tab bar.

## Performance notes

- The command palette and the peek card are lazy chunks, fetched on first use.
- One delegated `pointermove` listener for card tilt; parallax writes one CSS variable per frame.
- Palettes are cached; sampling uses an 80 px image.
- Fonts are two variable files per face (Latin + Latin Extended), loaded only when a glyph needs them.
