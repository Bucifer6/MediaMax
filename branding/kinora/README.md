# Kinora brand — Screenlight proposal

This review-branch identity keeps the Kinora name and self-hosted Figtree / Bricolage Grotesque typography. The mark is a **K cut from a strip of film**: a rounded vertical strip and two straight, tapered frames. Flat colour and an open joint replace the former multicolour curved beams. See [research and design rationale](../../docs/UI_RESEARCH.md).

## Colours

| Role | Dark background | Light background |
|---|---|---|
| Ground | `#101416` | `#F4F8F6` |
| Mark and primary | `#63DEC5` | `#137665` |
| Name | `#FFFFFF` | `#162321` |
| Tagline | `#B1C2BE` | `#52655F` |
| UI accent | `#DFBF86` | `#836126` |

Use the supplied dark/light variants; the mint mark is intended for dark backgrounds. Use the black/white monochrome assets when colour cannot be reproduced. Keep proportions, the open joint and clear space of at least the stem width. The simple mark is intended for 16–32 px. The name remains Kinora, capital K and lower-case inora.

## Sources and rebuild

- `scripts/brand/mark.mjs`: geometry, colours, safe-zone points and monochrome mark.
- `scripts/brand/build-masters.mjs`: master SVGs and `web/src/brand/art.ts`.
- `source/glyphs.json`: outlined wordmark and tagline; `source/OFL.txt` contains the font licence.

Run `node scripts/brand-export.mjs` to rebuild all masters, 72 PNG exports and favicon.ico. It updates web, mobile, TV-wrapper and Roku assets together. Run `node scripts/brand/sheet.mjs out.png` to review the lockups, launcher masks and small sizes. Playwright/Chromium and ffmpeg are required, as for the repository screenshot pipeline.

SVGs remain plain paths with no external font, script, raster image or reference. Filenames retain their existing roles: `wordmark-*`, `mark-*`, `lockup-stacked-*`, `app-icon-*`, `splash-*`, `appletv-*`, `roku-*` and store graphics. Light variants use deeper teal for contrast. Generated files should be changed through their sources.

## Compatibility

The stock dark/light theme IDs remain `mediamax` and `mediamax-light`. Server-provided names, uploaded logos, colours and themes still override the defaults. Native app identifiers and legacy URL schemes are unchanged. This is a proposal for owner review, not a published rebrand.
