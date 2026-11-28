/**
 * Picture modes and automatic letterbox detection for the web/TV player.
 *
 * "Auto" samples small video frames (64 px wide) and looks for black bars baked into the picture (a 2.39:1 film
 * mastered into a 16:9 frame). The zoom that removes them is the smallest found over a few samples, so a dark scene
 * never zooms in further than the real bars allow. Pure functions (the canvas sampling lives in the player).
 */

export type PictureMode = 'fit' | 'fill' | 'zoom' | 'stretch' | 'auto';
export const PICTURE_MODES: PictureMode[] = ['fit', 'auto', 'fill', 'zoom', 'stretch'];
export const PICTURE_LABELS: Record<PictureMode, string> = { fit: 'Fit', auto: 'Auto (remove black bars)', fill: 'Fill screen', zoom: 'Zoom', stretch: 'Stretch' };

/** A row counts as black when its brightest pixel is below this (0–255): noise and film grain stay under it. */
const BLACK = 28;
/** Bars thinner than this (share of the height) are ignored: overscan and encoder edges. */
const MIN_BAR = 0.04;
/** Never zoom more than this (a 4:3 inside 16:9 would otherwise blow up). */
const MAX_ZOOM = 1.34;

/**
 * Black bar size (share of the height, per side) in an RGBA frame; the smaller of the top and bottom bars, so an
 * off-centre picture isn't cropped. 0 when there are none or the whole frame is dark.
 */
export function detectBars(rgba: Uint8ClampedArray, width: number, height: number): number {
  if (width <= 0 || height <= 0 || rgba.length < width * height * 4) return 0;
  const rowMax = (y: number) => {
    let m = 0;
    const base = y * width * 4;
    for (let x = 0; x < width; x++) {
      const i = base + x * 4;
      const v = Math.max(rgba[i], rgba[i + 1], rgba[i + 2]);
      if (v > m) m = v;
    }
    return m;
  };
  let top = 0;
  while (top < height / 2 && rowMax(top) < BLACK) top++;
  let bottom = 0;
  while (bottom < height / 2 && rowMax(height - 1 - bottom) < BLACK) bottom++;
  // An all-dark frame (fade to black) says nothing about bars.
  if (top >= height / 2 - 1 || bottom >= height / 2 - 1) return 0;
  const bar = Math.min(top, bottom) / height;
  return bar >= MIN_BAR ? bar : 0;
}

/** The zoom that removes bars of this size on each side (1 = none), capped. */
export function zoomForBars(bar: number): number {
  if (!(bar > 0)) return 1;
  return Math.min(MAX_ZOOM, Math.round((1 / (1 - 2 * bar)) * 1000) / 1000);
}

/** Combine samples: the smallest bar seen wins (one bright frame proves the bars aren't bigger). */
export function settleBars(samples: number[]): number {
  if (samples.length < 3) return 0;
  return Math.min(...samples);
}

/**
 * CSS for a picture mode: object-fit plus a scale for zoom / auto. Auto never zooms beyond what the screen gains:
 * on a 16:9 screen a scope film inside a 16:9 frame already fills the width, so removing its bars would only crop
 * the sides (zoom 1); on a 21:9 screen the same film fills it (≈1.31).
 */
export function pictureStyle(mode: PictureMode, autoZoom: number, screenAspect = 16 / 9, frameAspect = 16 / 9): { objectFit: 'contain' | 'cover' | 'fill'; scale: number } {
  switch (mode) {
    case 'fill': return { objectFit: 'cover', scale: 1 };
    case 'stretch': return { objectFit: 'fill', scale: 1 };
    case 'zoom': return { objectFit: 'contain', scale: 1.33 };
    case 'auto': {
      const room = screenAspect > 0 && frameAspect > 0 ? Math.max(1, screenAspect / frameAspect) : 1;
      return { objectFit: 'contain', scale: Math.round(Math.min(autoZoom, room) * 1000) / 1000 };
    }
    default: return { objectFit: 'contain', scale: 1 };
  }
}
