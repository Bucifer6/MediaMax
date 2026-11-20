# MediaMax brand

The MediaMax logo is a ribbon folded into an **M**: the left stroke and left diagonal in cyan → blue, the
right diagonal and leg in magenta → purple, and the right leg ending in a rounded **play button**. The name
is always written **MediaMax** (one word, capital M twice), never "Media Max" or "Mediamax".

Everything in this folder is generated. Edit the sources, then rebuild:

```bash
node scripts/brand-export.mjs          # rebuild the master SVGs and render every PNG / favicon.ico
node scripts/brand/sheet.mjs out.png   # one-page review sheet (all sizes, icons under platform masks)
```

| Source | What it controls |
|---|---|
| [`scripts/brand/mark.mjs`](../../scripts/brand/mark.mjs) | Mark geometry on a 512 grid: stroke width, slope, corner radii, play button, colours |
| [`scripts/brand/build-masters.mjs`](../../scripts/brand/build-masters.mjs) | Lockups, app icons, splash, TV, social image; writes the SVGs here and `web/src/brand/art.ts` |
| [`source/glyphs.json`](source/glyphs.json) | "MediaMax" and the tagline as outlines from Plus Jakarta Sans (`scripts/brand/extract-glyphs.mjs`) |
| [`scripts/brand-export.mjs`](../../scripts/brand-export.mjs) | Renders the PNGs (Playwright/Chromium) and copies them to the web app, the Expo apps and the TV wrappers |

All shipped SVGs are plain paths: no `<text>`, fonts, scripts or external references (a server test checks this).

## Files

| File | Use |
|---|---|
| `mark.svg` | Full-colour mark, transparent. The default logo mark (≥ 48 px). |
| `mark-simple.svg` | Flat two-tone mark without fold shading, for 16–32 px (favicons, tabs). |
| `mark-mono-black.svg`, `mark-mono-white.svg` | Single colour; fold lines are cut out so the ribbon still reads. Watermarks, print, embossing. |
| `wordmark-dark.svg`, `wordmark-light.svg` | Horizontal logo: mark + name. *Dark* = for dark backgrounds (white "Media"). |
| `wordmark-tagline-dark.svg`, `wordmark-tagline-light.svg` | Horizontal logo with "STREAM WITHOUT LIMITS." justified under the name (README header). |
| `wordmark-mono-black.svg`, `wordmark-mono-white.svg` | Horizontal logo in one colour. |
| `name-dark.svg`, `name-light.svg` | The name alone (when the mark is shown separately). |
| `lockup-stacked-*.svg` | Mark above name above tagline (dark, light, mono black, mono white). |
| `app-icon-dark.svg`, `app-icon-light.svg` | 1024 opaque app icons (iOS, store listings): mark ~70 % wide, optically centred. |
| `android-foreground.svg`, `android-background.svg`, `android-monochrome.svg` | Android adaptive icon layers; the mark sits inside the 66 dp safe circle of the 108 dp canvas. Monochrome is for Android 13 themed icons. |
| `notification-icon.svg` | White silhouette for Android notification small icons. |
| `favicon.svg` | Simplified mark on a dark rounded square (reads on light and dark tab strips). |
| `icon-maskable.svg` | PWA maskable icon (full-bleed background, mark inside the 80 % safe circle). |
| `splash-dark.svg`, `splash-light.svg` | 1920 × 1080 splash (stacked lockup). |
| `og-image.svg` | 1200 × 630 social preview. |
| `tv-banner.svg` | Android TV launcher banner (320 × 180). |
| `appletv-icon-front.svg`, `appletv-icon-back.svg`, `appletv-icon.svg` | Apple TV app icon layers (parallax) and the flattened version. |
| `appletv-topshelf.svg`, `appletv-topshelfwide.svg` | Apple TV top shelf (1920 × 720) and wide top shelf (2320 × 720). |
| `png/` | Rendered PNGs of the above at common sizes. |

Where they end up: `web/public/` (favicon.ico/svg/16/32, apple-touch-icon, PWA icons incl. maskable, og-image,
`brand/`), `apps/mobile/assets/` (icon, adaptive icon, splash, notification icon, `brand/`, `tv/`) and
`tv/shared/brand/` (Samsung Tizen / LG webOS icons and splash). The web app inlines the mark and the outlined
name from `web/src/brand/art.ts` (header, sidebar, login, setup, profile picker, splash).

## Colours

| Role | Hex | Notes |
|---|---|---|
| Ground (dark background) | `#0A0F22` | App icon, splash, default theme background |
| Light ground | `#F5F7FF` | Light splash, light theme background |
| Ink | `#0B1026` | "Media" on light backgrounds (18.8:1 on white) |
| Left stroke | `#00F5E9` → `#04BDF2` → `#2362FA` | Cyan → blue |
| Fold (left diagonal) | `#07D8EF` → `#4777F9` | Lighter band in front of the stroke |
| Right diagonal | `#F03CF2` → `#6723D5` | Magenta → purple |
| Right leg | `#C93BEF` → `#5A1FC4` | Behind the diagonal, a step darker |
| Play button | `#F045FF` → `#6427FA` | Magenta → violet |
| "Max" on dark | `#00F5E9` → `#04BDF2` → `#2362FA` | 13.8 → 3.8 : 1 on `#0A0F22` |
| "Max" on light | `#0891B2` → `#1D6FE8` → `#2362FA` | 3.7 → 5.0 : 1 on white (large-text AA ≥ 3:1) |
| Tagline | `#B9C3E6` on dark, `#48537A` on light | 10.9:1 and 7.5:1 |

UI theme "MediaMax" (the default for new installs) uses primary `#1FB6F5` with `#04101F` button text (8.3:1),
accent `#E040F0`, surfaces `#121936` / `#1A2247`. "MediaMax Light" uses primary `#1D63E8` with white text.
Both pass the WCAG AA checks in `server/test/aidj.test.ts` and `server/test/brand.test.ts`.

## Typeface

**Plus Jakarta Sans** ExtraBold (name) and Bold (tagline, tracked to the name's width), by Tokotype, licensed
under the [SIL Open Font License 1.1](source/OFL.txt). The logo files contain outlines only, so no font is
shipped or needed to display them. The MediaMax UI themes load Plus Jakarta Sans from Google Fonts so the
interface matches the wordmark; other themes keep their own fonts.

## Usage

- **Clear space:** keep free space around the logo of at least the height of the play button
  (≈ 45 % of the mark's height) on every side.
- **Minimum sizes:** full-colour mark 48 px high (below that use `mark-simple`, down to 16 px);
  horizontal wordmark 24 px high on screen / 12 mm in print; stacked lockup 64 px high (the tagline
  becomes unreadable below that; drop it rather than shrinking it).
- **Backgrounds:** use the *dark* files on dark or photographic backgrounds (add a dark scrim behind busy
  images), the *light* files on white or light grey. On mid-tone or brand-coloured backgrounds use a mono file.
- **App icons:** use the generated icons; they already respect each platform's safe zone and mask.

**Do**

- Use the files as supplied, scaled proportionally.
- Use the mono versions for single-colour printing, embossing, watermarks and Apple TV top shelf overlays.
- Write the name as one word: MediaMax.

**Don't**

- Recolour the gradients, swap the left/right colours, or put the full-colour mark on magenta or cyan.
- Re-type the name in another font, add effects (outlines, glows, drop shadows), or stretch/rotate the logo.
- Separate the play button from the M, or place the mark in a tight container that crops the play tip.
- Use the light wordmark on dark backgrounds (or the reverse): the "Max" gradient differs on purpose.

## White label

The server's Branding Studio overrides all of this: an uploaded logo, wide logo, favicon, app icon, splash
logo and colours replace the MediaMax defaults in the web app, the TV wrappers and the mobile/TV apps. When
the server is renamed, the apps show the new name instead of the MediaMax wordmark. Native app icons for a
white-label build come from `apps/mobile/branding/<brand>/` (see `apps/mobile/README.md`).
