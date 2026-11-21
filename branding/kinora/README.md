# Kinora brand

**Kinora** comes from *kino* (cinema); a kinora was an 1890s home-movie viewer. The product is a home cinema you own,
so the name fits, and the logo draws it literally.

The mark is a **K made of projector light**: the stem is the projector (a solid periwinkle → indigo bar) and the K's
two arms are **beams of warm light** that leave from one point beside the stem and widen as they travel, ending on an
arc like light landing on a curved screen. The notch between the beams is the K's crotch. It follows the Lumen design
language ([`docs/DESIGN.md`](../../docs/DESIGN.md): *the interface is lit by the films*): the light comes from the
picture, and the brand is that light. It is three plain shapes, so it reads at 16 px, in one colour and on a TV
launcher.

The name is always written **Kinora** (capital K, the rest lower case). In the wordmark the tittle of the **i** is lit
in the beam colours: a point of projector light.

Everything in this folder is generated. Edit the sources, then rebuild:

```bash
node scripts/brand-export.mjs          # rebuild the master SVGs and render every PNG / favicon.ico
node scripts/brand/sheet.mjs out.png   # one-page review sheet (all sizes, icons under platform masks) + png/icon-sizes.png
```

| Source | What it controls |
|---|---|
| [`scripts/brand/mark.mjs`](../../scripts/brand/mark.mjs) | Mark geometry on a 512 grid: stem, apex, beam angles and radius, corner radii, colours |
| [`scripts/brand/build-masters.mjs`](../../scripts/brand/build-masters.mjs) | Lockups, app icons, splash, TV, Roku, store and social art; writes the SVGs here and `web/src/brand/art.ts` |
| [`source/glyphs.json`](source/glyphs.json) | "Kinora" (Bricolage Grotesque ExtraBold) and the tagline (Figtree Bold) as outlines (`scripts/brand/extract-glyphs.py`) |
| [`scripts/brand-export.mjs`](../../scripts/brand-export.mjs) | Renders the PNGs (Playwright/Chromium) and copies them to the web app, the Expo apps, the TV wrappers and the Roku channel |

All shipped SVGs are plain paths: no `<text>`, fonts, scripts or external references (a server test checks this).

## Files

| File | Use |
|---|---|
| `mark.svg` | Full-colour mark, transparent. The default logo mark (≥ 48 px). |
| `mark-simple.svg` | Flat mark with a slightly wider notch, for 16–32 px (favicons, tabs). |
| `mark-mono-black.svg`, `mark-mono-white.svg` | Single colour. Watermarks, print, embossing, overlays. |
| `wordmark-dark.svg`, `wordmark-light.svg` | Horizontal logo: mark + name. *Dark* = for dark backgrounds (white name). |
| `wordmark-tagline-dark.svg`, `wordmark-tagline-light.svg` | Horizontal logo with "YOUR OWN HOME CINEMA." justified under the name (README header). |
| `wordmark-mono-black.svg`, `wordmark-mono-white.svg` | Horizontal logo in one colour. |
| `name-dark.svg`, `name-light.svg` | The name alone (when the mark is shown separately). |
| `lockup-stacked-*.svg` | Mark above name above tagline (dark, light, mono black, mono white). |
| `app-icon-dark.svg`, `app-icon-light.svg` | 1024 opaque app icons (iOS, store listings), mark optically centred. |
| `android-foreground.svg`, `android-background.svg`, `android-monochrome.svg` | Android adaptive icon layers; the mark sits inside the 66 dp safe circle of the 108 dp canvas. Monochrome is for Android 13 themed icons. |
| `notification-icon.svg` | White silhouette for Android notification small icons. |
| `favicon.svg` | Simplified mark on a dark rounded square (reads on light and dark tab strips). |
| `icon-maskable.svg` | PWA maskable icon (full-bleed background, mark inside the 80 % safe circle). |
| `splash-dark.svg`, `splash-light.svg` | 1920 × 1080 splash (stacked lockup). |
| `og-image.svg` | 1200 × 630 social preview. |
| `tv-banner.svg` | Android TV launcher banner (320 × 180; also rendered at 1280 × 720 for the store). |
| `appletv-icon-front.svg`, `appletv-icon-back.svg`, `appletv-icon.svg` | Apple TV app icon layers (parallax) and the flattened version. |
| `appletv-topshelf.svg`, `appletv-topshelfwide.svg` | Apple TV top shelf (1920 × 720) and wide top shelf (2320 × 720). |
| `roku-icon-fhd.svg`, `roku-icon-hd.svg`, `roku-poster.svg`, `spinner.svg` | Roku focus icons (336 × 210, 290 × 218), channel poster (540 × 405) and loading spinner. |
| `play-feature-graphic.svg` | Google Play feature graphic (1024 × 500). |
| `png/` | Rendered PNGs of the above at common sizes; `png/store/` has the store-listing sizes; `png/icon-sizes.png` previews the icon from 256 to 16 px. |

Where they end up: `web/public/` (favicon.ico/svg/16/32, apple-touch-icon, PWA icons incl. maskable, og-image,
`brand/`), `apps/mobile/assets/` (icon, adaptive icon, splash, notification icon, `brand/`, `tv/`),
`tv/shared/brand/` (Samsung Tizen / LG webOS / Hisense VIDAA icons and splash) and `apps/roku/images/` (focus icons,
splash, logo, spinner). The web app inlines the mark and the outlined name from `web/src/brand/art.ts` (header, rail,
login, setup, profile picker, splash).

## Colours

| Role | Hex | Notes |
|---|---|---|
| Ground (dark background) | `#0D0C1D` | App icon, splash, default theme background; glow `#1F1C45` |
| Light ground | `#F7F6FF` | Light splash, light theme background |
| Ink | `#14122B` | The name on light backgrounds |
| Stem | `#A9AEFF` → `#5B45F0` | Periwinkle → indigo, top to bottom (`#7569FA` flat at small sizes) |
| Beams | `#FFE6A6` → `#FFAA4D` → `#F4506E` | Lamp white-gold → amber → rose, radiating from the apex |
| Tittle of the i | `#FFD27A` → `#FF8A5B` on dark, `#F59E0B` → `#E2475F` on light | |
| Tagline | `#BDB9E6` on dark, `#4D4973` on light | |

UI theme "Kinora" (the default for new installs; id `mediamax`, kept for existing settings) takes its primary from
the stem and its accent from the beams; "Kinora Light" is the light version. Both pass the WCAG AA checks in
`server/test/aidj.test.ts` and `server/test/brand.test.ts`.

## Typeface

The Lumen pairing: **Bricolage Grotesque** ExtraBold at its display optical size (the name) and **Figtree** Bold (the
tagline, tracked to the name's width), both licensed under the [SIL Open Font License 1.1](source/OFL.txt). The logo
files contain outlines only, so no font is shipped or needed to display them; the web app self-hosts both faces for
the interface.

## Usage

- **Clear space:** keep free space around the logo of at least the stem's width on every side.
- **Minimum sizes:** full-colour mark 48 px high (below that use `mark-simple`, down to 16 px); horizontal wordmark
  24 px high on screen / 12 mm in print; stacked lockup 64 px high (drop the tagline below that rather than shrinking it).
- **Backgrounds:** the mark works on dark and light grounds; use the *dark* wordmark on dark or photographic backgrounds
  (add a dark scrim behind busy images) and the *light* one on white or light grey. On mid-tone or coloured backgrounds
  use a mono file.
- **App icons:** use the generated icons; they already respect each platform's safe zone and mask.

**Do**

- Use the files as supplied, scaled proportionally.
- Use the mono versions for single-colour printing, embossing, watermarks and overlays.
- Write the name as one word with a capital K: Kinora.

**Don't**

- Recolour the stem or the beams, swap their colours, or fill the notch between the beams.
- Re-type the name in another font, add effects (outlines, glows, drop shadows), or stretch/rotate the logo.
- Detach the beams from the stem or rotate them; the light always travels to the right.

## White label

The server's Branding Studio overrides all of this: an uploaded logo, wide logo, favicon, app icon, splash logo and
colours replace the Kinora defaults in the web app, the TV wrappers and the mobile/TV apps. When the server is renamed,
the apps show the new name instead of the Kinora wordmark. Native app icons for a white-label build come from
`apps/mobile/branding/<brand>/` (see `apps/mobile/README.md`).
