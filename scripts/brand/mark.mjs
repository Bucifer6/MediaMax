/**
 * Vibe mark geometry: "Lens", a disc with a V-shaped hole.
 *
 * The disc is a screen, a lens and a record at once; the V cut through it is the vibe. It is one path filled with the
 * even-odd rule, so the V is a real hole: the background shows through in every version (full colour, simplified,
 * single colour, notification silhouette) and no version needs a second colour to read.
 *
 * Everything is constructed on a 512 x 512 grid from a handful of numbers:
 *  - the disc is centred on (256, 256) with radius R;
 *  - the V is a stroke along the centreline P1 -> P2 -> P3 with width W, round caps at P1 / P3 and a round outer
 *    join at P2 (the inner corner stays sharp: the V's crotch);
 *  - the simplified mark (16-32 px) uses a heavier stroke so the hole stays open once pixels get coarse.
 *
 * Exports SVG fragments; scripts/brand/build-masters.mjs assembles them into the master files.
 */

// ---- grid -------------------------------------------------------------------------------------
export const G = {
  cx: 256,
  cy: 256,
  R: 208, // disc radius
  P1: [152, 176], // V centreline: top left
  P2: [256, 366], // bottom (the point of the V)
  P3: [360, 176], // top right
  W: 60, // V stroke width
  W_SIMPLE: 72, // heavier V for 16-32 px
};

const f = (n) => +n.toFixed(2);
const P = ([x, y]) => `${f(x)} ${f(y)}`;
const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
const add = (a, b, k = 1) => [a[0] + b[0] * k, a[1] + b[1] * k];
const unit = (v) => {
  const l = Math.hypot(v[0], v[1]);
  return [v[0] / l, v[1] / l];
};
const cross = (u, v) => u[0] * v[1] - u[1] * v[0];

/** The disc as a closed path (two half arcs). */
export function discPath({ cx = G.cx, cy = G.cy, R = G.R } = {}) {
  return `M${f(cx - R)} ${f(cy)}A${R} ${R} 0 1 0 ${f(cx + R)} ${f(cy)}A${R} ${R} 0 1 0 ${f(cx - R)} ${f(cy)}Z`;
}

/**
 * The V as a filled outline: the stroke P1 -> P2 -> P3 of width w with round caps and a round outer join.
 * The inner side (towards the V's opening) meets at the intersection of the two offset lines.
 */
export function vPath({ p1 = G.P1, p2 = G.P2, p3 = G.P3, w = G.W } = {}) {
  const h = w / 2;
  const d1 = unit(sub(p2, p1));
  const d2 = unit(sub(p3, p2));
  const n1 = [d1[1], -d1[0]]; // normals towards the V's opening
  const n2 = [d2[1], -d2[0]];
  const a1 = add(p1, n1, h);
  const b1 = add(p2, n2, h);
  const b2 = add(p3, n2, h);
  const t = cross(sub(b1, a1), d2) / cross(d1, d2);
  const inner = add(a1, d1, t);
  const o1 = add(p1, n1, -h);
  const o2a = add(p2, n1, -h);
  const o2b = add(p2, n2, -h);
  const o3 = add(p3, n2, -h);
  return `M${P(a1)}L${P(inner)}L${P(b2)}A${f(h)} ${f(h)} 0 0 1 ${P(o3)}L${P(o2b)}A${f(h)} ${f(h)} 0 0 1 ${P(o2a)}L${P(o1)}A${f(h)} ${f(h)} 0 0 1 ${P(a1)}Z`;
}

/** The whole mark as one path (fill-rule evenodd): disc with the V cut out. */
export const markPath = (o = {}) => `${discPath()}${vPath(o)}`;

export const COLORS = {
  ground: '#0C0C10', // dark background (app icon, splash, default theme)
  groundGlow: '#231A33', // centre of the background's soft evening glow
  groundLight: '#F7F6FA',
  ink: '#15131C', // the name on light backgrounds
  // Brand gradient, 135 deg: sunset -> rose -> violet (the evening, from first light to dusk)
  gradient: ['#FF8A5C', '#E2498A', '#7C5CFF'],
  gradientStops: [0, 0.55, 1],
};

/** 135 deg linear gradient across the disc's bounding box (top left -> bottom right), in user space. */
export function gradientDef(id) {
  const C = COLORS;
  const x0 = G.cx - G.R;
  const x1 = G.cx + G.R;
  return `<linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="${x0}" y1="${x0}" x2="${x1}" y2="${x1}">${C.gradient
    .map((c, i) => `<stop offset="${C.gradientStops[i]}" stop-color="${c}"/>`)
    .join('')}</linearGradient>`;
}

/** Full-colour mark as an SVG fragment (defs + body). `id` prefixes gradient ids so several marks can share one document. */
export function markFull(id = 'vm') {
  return { defs: gradientDef(`${id}-g`), body: `<path d="${markPath()}" fill="url(#${id}-g)" fill-rule="evenodd"/>` };
}

/** Simplified mark for 16-32 px: same disc and gradient, heavier V so the hole stays open. */
export function markSimple(id = 'vms') {
  return { defs: gradientDef(`${id}-g`), body: `<path d="${markPath({ w: G.W_SIMPLE })}" fill="url(#${id}-g)" fill-rule="evenodd"/>` };
}

/** Single-colour mark in `color` (the V is a hole, so it works on any background). */
export function markMono(color = '#000', { simple = false } = {}) {
  return { defs: '', body: `<path d="${markPath(simple ? { w: G.W_SIMPLE } : {})}" fill="${color}" fill-rule="evenodd"/>` };
}

/** Bounding box of the mark on the 512 grid (the disc). */
export const BBOX = { x: G.cx - G.R, y: G.cy - G.R, w: 2 * G.R, h: 2 * G.R };

/** The disc is symmetric and the V sits on its centre, so the optical centre is the geometric one. */
export const CENTER = { dx: 0, dy: 0 };

/** Wrap a fragment in a <g> that centres it, scaled by `scale` around the 512 square's centre. */
export function centered(frag, scale = 1) {
  const t = scale === 1 ? `translate(${CENTER.dx} ${CENTER.dy})` : `translate(256 256) scale(${scale}) translate(${-256 + CENTER.dx} ${-256 + CENTER.dy})`;
  return { defs: frag.defs, body: `<g transform="${t}">${frag.body}</g>` };
}

/** Farthest ink from the centre of the 512 square (the disc's edge), for safe-zone calculations. */
export const RADIUS = G.R;
