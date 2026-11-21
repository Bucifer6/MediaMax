/**
 * Kinora mark geometry: a "K" whose arms are two beams of projector light.
 *
 * The stem is the projector (a solid rounded bar); the K's arms are two wedges of light that leave from one point
 * just right of the stem's centre and widen as they travel, ending on an arc centred on that point, like a beam
 * landing on a curved screen. The notch between the beams is the K's crotch. It reads as a K at 16 px and as a beam of
 * light at launcher size, and it is built from three shapes, so the single-colour versions need no tricks.
 *
 * Everything is constructed on a 512 x 512 grid from a handful of numbers:
 *  - the stem is W wide and spans Y0..Y1;
 *  - the apex A sits a hair (APEX_GAP) right of the stem, on the vertical centre of the stem;
 *  - each beam spans the angles A0..A1 above / below the horizontal, out to radius R from A;
 *  - R is solved so the outer edge of each beam ends level with the stem's top / bottom.
 *
 * Exports SVG fragments; scripts/brand/build-masters.mjs assembles them into the master files.
 */

// ---- grid -------------------------------------------------------------------------------------
export const G = (() => {
  const W = 84; // stem width
  const X0 = 108; // stem left edge
  const X1 = X0 + W;
  const Y0 = 88; // stem top
  const Y1 = 424; // stem bottom
  const APEX_GAP = 8;
  const A = [X1 + APEX_GAP, (Y0 + Y1) / 2];
  const A0 = 20; // inner edge of each beam (degrees from horizontal); the notch is 2 x A0
  const A1 = 52; // outer edge
  const R = (A[1] - Y0) / Math.sin((A1 * Math.PI) / 180);
  return { W, X0, X1, Y0, Y1, A, A0, A1, R, stemR: 22, beamR: 10 };
})();

const f = (n) => +n.toFixed(2);
const rad = (d) => (d * Math.PI) / 180;
/** Point at `deg` degrees above the horizontal (negative = below) and distance r from the apex. */
const at = (deg, r) => [G.A[0] + r * Math.cos(rad(deg)), G.A[1] - r * Math.sin(rad(deg))];
const P = ([x, y]) => `${f(x)} ${f(y)}`;

/** Rounded rectangle path (all four corners radius r). */
function rrect(x, y, w, h, r) {
  return `M${f(x + r)} ${f(y)}H${f(x + w - r)}A${r} ${r} 0 0 1 ${f(x + w)} ${f(y + r)}V${f(y + h - r)}A${r} ${r} 0 0 1 ${f(x + w - r)} ${f(y + h)}H${f(x + r)}A${r} ${r} 0 0 1 ${f(x)} ${f(y + h - r)}V${f(y + r)}A${r} ${r} 0 0 1 ${f(x + r)} ${f(y)}Z`;
}

export function stemPath() {
  return rrect(G.X0, G.Y0, G.W, G.Y1 - G.Y0, G.stemR);
}

/**
 * One beam: a wedge from the apex between angles a and b (degrees), closed by an arc of radius R about the apex.
 * The two outer corners are filleted with radius rho (a circle tangent to the straight edge and the arc); the apex stays
 * sharp (it is where the light leaves the projector).
 */
export function beamPath(sign, { R = G.R, rho = G.beamR, a0 = G.A0, a1 = G.A1 } = {}) {
  const lo = sign * a0;
  const hi = sign * a1;
  // Fillet centre sits at distance R - rho from the apex, rotated inwards by delta from the edge.
  const delta = (Math.asin(rho / (R - rho)) * 180) / Math.PI;
  const along = (R - rho) * Math.cos(rad(delta)); // tangent point on the straight edge
  const inward = sign; // rotate towards the beam's middle
  const t1 = at(lo, along);
  const u1 = at(lo + inward * delta, R);
  const u2 = at(hi - inward * delta, R);
  const t2 = at(hi, along);
  // Upper beam (sign > 0): going from the low edge outwards, then along the arc anticlockwise on screen (y up) = sweep 0.
  const sw = sign > 0 ? 0 : 1;
  return `M${P(G.A)}L${P(t1)}A${f(rho)} ${f(rho)} 0 0 ${sw} ${P(u1)}A${f(R)} ${f(R)} 0 0 ${sw} ${P(u2)}A${f(rho)} ${f(rho)} 0 0 ${sw} ${P(t2)}Z`;
}

export const COLORS = {
  ground: '#0D0C1D', // dark background (app icon, splash, default theme)
  groundGlow: '#1F1C45', // centre of the background's radial light
  ink: '#14122B', // the name on light backgrounds
  stem: ['#A9AEFF', '#5B45F0'], // periwinkle -> indigo, top to bottom
  stemSimple: '#7569FA',
  beam: ['#FFE6A6', '#FFAA4D', '#F4506E'], // warm light: lamp white-gold -> amber -> rose, from the apex outwards
  beamSimple: ['#FFC05C', '#F76A5C'],
};

/** Full-colour mark as an SVG fragment (defs + body). `id` prefixes gradient ids so several marks can share one document. */
export function markFull(id = 'km') {
  const C = COLORS;
  const defs =
    `<linearGradient id="${id}-stem" gradientUnits="userSpaceOnUse" x1="0" y1="${G.Y0}" x2="0" y2="${G.Y1}"><stop offset="0" stop-color="${C.stem[0]}"/><stop offset="1" stop-color="${C.stem[1]}"/></linearGradient>` +
    `<radialGradient id="${id}-beam" gradientUnits="userSpaceOnUse" cx="${f(G.A[0])}" cy="${f(G.A[1])}" r="${f(G.R)}"><stop offset="0" stop-color="${C.beam[0]}"/><stop offset="0.5" stop-color="${C.beam[1]}"/><stop offset="1" stop-color="${C.beam[2]}"/></radialGradient>`;
  const body = `<path d="${stemPath()}" fill="url(#${id}-stem)"/><path d="${beamPath(1)}" fill="url(#${id}-beam)"/><path d="${beamPath(-1)}" fill="url(#${id}-beam)"/>`;
  return { defs, body };
}

/**
 * Simplified mark for 16-32 px: flat stem, two-stop beams, a slightly wider notch and a bigger apex gap so the
 * beams stay apart from the stem and from each other once pixels get coarse.
 */
export function markSimple(id = 'kms') {
  const C = COLORS;
  const defs = `<linearGradient id="${id}-b" gradientUnits="userSpaceOnUse" x1="${f(G.A[0])}" y1="0" x2="${f(G.A[0] + G.R)}" y2="0"><stop offset="0" stop-color="${C.beamSimple[0]}"/><stop offset="1" stop-color="${C.beamSimple[1]}"/></linearGradient>`;
  const opts = { a0: G.A0 + 3, rho: 6 };
  const body = `<path d="${stemPath()}" fill="${C.stemSimple}"/><path d="${beamPath(1, opts)}" fill="url(#${id}-b)"/><path d="${beamPath(-1, opts)}" fill="url(#${id}-b)"/>`;
  return { defs, body };
}

/** Single-colour mark in `color` (the gap between stem and beams keeps the K readable). */
export function markMono(color = '#000') {
  return { defs: '', body: `<path d="${stemPath()}${beamPath(1)}${beamPath(-1)}" fill="${color}"/>` };
}

/** Bounding box of the mark on the 512 grid. The beams' rightmost point is on the arc at the inner edge angle. */
export const BBOX = (() => {
  const right = at(G.A0, G.R)[0];
  return { x: G.X0, y: G.Y0, w: right - G.X0, h: G.Y1 - G.Y0 };
})();

/**
 * Translation that centres the mark optically in the 512 square: the beams taper to the right, so the mark carries
 * more weight on the left (the stem) than its bounding box suggests; it sits ~6 px right of the geometric centre.
 */
export const CENTER = { dx: +(256 - (BBOX.x + BBOX.w / 2) + 6).toFixed(2), dy: +(256 - (BBOX.y + BBOX.h / 2)).toFixed(2) };

/** Wrap a fragment in a <g> that centres it, scaled by `scale` around the 512 square's centre. */
export function centered(frag, scale = 1) {
  const t = scale === 1 ? `translate(${CENTER.dx} ${CENTER.dy})` : `translate(256 256) scale(${scale}) translate(${-256 + CENTER.dx} ${-256 + CENTER.dy})`;
  return { defs: frag.defs, body: `<g transform="${t}">${frag.body}</g>` };
}

/** Outline extremes (stem corners and beam arc ends), for safe-zone calculations. Rounded corners lie inside these. */
export function keyPoints() {
  const { X0, X1, Y0, Y1, A0, A1, R } = G;
  return [[X0, Y0], [X1, Y0], [X1, Y1], [X0, Y1], at(A0, R), at(A1, R), at(-A0, R), at(-A1, R)];
}
