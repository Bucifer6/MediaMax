# Vibe brand

**Vibe** is the feeling of watching and listening together at home: a film night on the sofa, a record on while
dinner cooks, the match with friends. The product is a media server you own, and the name is what it is for.

The mark is the **Lens**: a disc with a **V** cut through it. The disc is a screen, a lens and a record at once (the
three ways people use Vibe: watch, look, listen); the V is the vibe. It is one path filled with the even-odd rule, so
the V is a real hole: whatever is behind the logo shows through it, in full colour and in one colour alike. It reads
at 16 px, on a TV launcher and under every platform's icon mask.

The disc is filled with the **brand gradient**, sunset to evening (135°): `#FF8A5C` (sunset) → `#E2498A` (rose, at
55 %) → `#7C5CFF` (violet). The gradient belongs to the mark, the splash and small accents only; the interface itself
stays on quiet graphite so the artwork supplies the colour.

The name is always written **Vibe** in prose (capital V). The wordmark is lower case, **vibe**, set in Outfit Bold.

Everything in this folder is generated. Edit the sources, then rebuild:

```bash
node scripts/brand-export.mjs          # rebuild the master SVGs and render every PNG / favicon.ico
node scripts/brand/sheet.mjs out.png   # one-page review sheet (all sizes, icons under platform masks) + png/icon-sizes.png
```

| Source | What it controls |
|---|---|
| [`scripts/brand/mark.mjs`](../../scripts/brand/mark.mjs) | Mark geometry on a 512 grid (disc centre and radius, the V's centreline, stroke width and the heavier small-size stroke) and the brand colours |
| [`scripts/brand/build-masters.mjs`](../../scripts/brand/build-masters.mjs) | Lockups, app icons, splash, TV, Roku, store and social art; writes the SVGs here and `web/src/brand/art.ts` |
| [`source/glyphs.json`](source/glyphs.json) | "vibe" (Outfit Bold) and the tagline (Figtree Bold) as outlines (`scripts/brand/extract-glyphs.py`) |
| [`scripts/brand-export.mjs`](../../scripts/brand-export.mjs) | Renders the PNGs (Playwright/Chromium) and copies them to the web app, the Expo apps, the TV wrappers and the Roku channel |

All shipped SVGs are plain paths: no `<text>`, fonts, scripts or external references (a server test checks this).

## Geometry

On the 512 grid: the disc is centred on (256, 256) with radius 208. The V is a stroke along
(152, 176) → (256, 366) → (360, 176), 60 wide, with round caps and a round outer join; its inner corner stays sharp.
Below 32 px the simplified mark uses a 72-wide V so the hole stays open.

## Files

| File | Use |
|---|---|
| `mark.svg` | Full-colour mark, transparent. The default logo mark (≥ 32 px). |
| `mark-simple.svg` | Same disc with a heavier V, for 16–32 px (favicons, tabs). |
| `mark-mono-black.svg`, `mark-mono-white.svg` | Single colour; the V is a hole. Watermarks, print, embossing, overlays. |
| `wordmark-dark.svg`, `wordmark-light.svg` | Horizontal logo: mark + name. *Dark* = for dark backgrounds (light name). |
| `wordmark-tagline-dark.svg`, `wordmark-tagline-light.svg` | Horizontal logo with "Your media. Your vibe." under the name (README header). |
| `wordmark-mono-black.svg`, `wordmark-mono-white.svg` | Horizontal logo in one colour. |
| `name-dark.svg`, `name-light.svg` | The name alone (when the mark is shown separately). |
| `lockup-stacked-*.svg` | Mark above name above tagline (dark, light, mono black, mono white). |
| `app-icon-dark.svg`, `app-icon-light.svg` | 1024 opaque app icons (iOS, store listings); the disc is 62 % of the icon. |
| `android-foreground.svg`, `android-background.svg`, `android-monochrome.svg` | Android adaptive icon layers; the disc is 48 dp across, inside the 66 dp safe circle of the 108 dp canvas. Monochrome is for Android 13 themed icons. |
| `notification-icon.svg` | White silhouette (heavier V) for Android notification small icons. |
| `favicon.svg` | Simplified mark, full bleed on transparent (the gradient reads on light and dark tab strips). |
| `icon-maskable.svg` | PWA maskable icon (full-bleed background, disc well inside the 80 % safe circle). |
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
| Brand gradient | `#FF8A5C` → `#E2498A` (55 %) → `#7C5CFF` | Sunset → rose → violet, 135°. The mark, splash and small accents only |
| Ground (dark background) | `#0C0C10` | App icon, splash, default theme background; evening glow `#231A33` |
| Light ground | `#F7F6FA` | Light splash, light theme background |
| Name on dark | `#F2F1F6` | The UI's text colour |
| Ink (name on light) | `#15131C` | |
| Tagline | `#B4B2C2` on dark, `#4E4B5C` on light | |

UI theme "Vibe" (the default for new installs; id `mediamax`, kept for existing settings) uses graphite surfaces, the
rose as its primary and the violet as its accent; "Vibe Light" is the light version. Both pass the WCAG AA checks in
`server/test/aidj.test.ts` and `server/test/brand.test.ts`.

## Typeface

**Outfit** Bold (the name; letter-spacing −0.035 em) and **Figtree** Bold (the tagline), both licensed under the
[SIL Open Font License 1.1](source/OFL.txt). The logo files contain outlines only, so no font is shipped or needed to
display them; the web app self-hosts both faces for the interface (Outfit for display, Figtree for text).

## Usage

- **Clear space:** keep free space around the logo of at least half the disc's radius on every side.
- **Minimum sizes:** full-colour mark 32 px (below that use `mark-simple`, down to 16 px); horizontal wordmark 24 px
  high on screen / 10 mm in print; stacked lockup 64 px high (drop the tagline below that rather than shrinking it).
- **Backgrounds:** the mark works on dark and light grounds; use the *dark* wordmark on dark or photographic
  backgrounds (add a dark scrim behind busy images) and the *light* one on white or light grey. On mid-tone or
  coloured backgrounds use a mono file.
- **App icons:** use the generated icons; they already respect each platform's safe zone and mask.

**Do**

- Use the files as supplied, scaled proportionally.
- Use the mono versions for single-colour printing, embossing, watermarks and overlays.
- Write the name with a capital V in prose (Vibe); the wordmark is lower case by design.

**Don't**

- Fill the V, recolour the gradient, reverse its direction or use it as a large background.
- Re-type the name in another font, add effects (outlines, glows, drop shadows), or stretch/rotate the logo.
- Put the mark inside another circle or outline; the disc is the container.

## Former names

The product was called MediaMax, then Kinora. Identifiers that existing installs and apps depend on keep those names
(environment variables, the Docker image, service and data folder names, URL schemes, bundle ids, HTTP headers); see
the note in the [README](../../README.md).

## White label

The server's Branding Studio overrides all of this: an uploaded logo, wide logo, favicon, app icon, splash logo and
colours replace the Vibe defaults in the web app, the TV wrappers and the mobile/TV apps. When the server is renamed,
the apps show the new name instead of the Vibe wordmark. Native app icons for a white-label build come from
`apps/mobile/branding/<brand>/` (see `apps/mobile/README.md`).
