/**
 * MediaMax mark geometry: a ribbon folded into an "M" whose right leg ends in a play button.
 *
 * Everything is constructed on a 512 x 512 grid from a handful of numbers so the joins line up exactly:
 *  - both legs and both diagonals are the same width (W, measured perpendicular to the stroke);
 *  - each fold crease runs from the outer corner to the inner corner (the angle bisector), so the
 *    diagonal lies cleanly over the leg with no stray wedges;
 *  - the two diagonals meet on the vertical centre line (x = 256), the left one in front;
 *  - the outline is one silhouette with consistent corner radii; the pieces are clipped to it, so
 *    overlaps never leak past the edge;
 *  - the play button's tip lines up with the right leg's outer edge and its top edge is parallel to
 *    the leg's end cut, with the same gap all along.
 *
 * Exports SVG fragments; scripts/brand/build-masters.mjs assembles them into the master files.
 */

// ---- grid -------------------------------------------------------------------------------------
export const G = (() => {
  const W = 76; // ribbon width
  const L0 = 72; // left leg outer edge
  const L1 = L0 + W;
  const R1 = 512 - L0; // right leg outer edge
  const R0 = R1 - W;
  const Y0 = 104; // top of the outer corners
  const Yb = 408; // bottom of the left leg
  const s = 0.7; // diagonal slope (dy/dx), ~35 degrees
  const T = W * Math.hypot(1, s); // vertical thickness of a diagonal
  const Yv = Y0 + (256 - L0) * s; // inner V (top of the seam)
  const crease = Y0 + W * s + T; // y of the inner corner where a diagonal's lower edge meets a leg
  // Play button. Its top edge has slope k; the right leg ends in a cut through the inner corner with
  // the same slope, and the button nests under that cut and the right diagonal with a uniform gap.
  const gap = 18;
  const k = 0.56;
  const Ir = [R0, crease];
  // offset lines: cut line (through Ir, slope k) and diagonal's lower edge (through Ir, slope -s), both moved down by gap
  const offY = (slope) => gap * Math.hypot(1, slope);
  // y = Ir.y + offY(k) + k(x - R0)  and  y = Ir.y + offY(s) - s(x - R0)
  const x = R0 + (offY(s) - offY(k)) / (k + s);
  const pTl = [x, Ir[1] + offY(k) + k * (x - R0)];
  const pBottom = Yb + 4;
  const ph = pBottom - pTl[1];
  const pw = ph / 2 / k;
  const pTip = [pTl[0] + pw, pTl[1] + ph / 2];
  const pTop = pTl[1];
  const pLeft = pTl[0];
  return { W, L0, L1, R0, R1, Y0, Yb, s, T, Yv, crease, gap, k, ph, pw, pTip, pTop, pBottom, pLeft };
})();

const f = (n) => +n.toFixed(2);

/** Polygon with rounded corners. pts: [[x, y, r?], ...]; r = 0 keeps the corner sharp. */
export function roundedPath(pts) {
  const n = pts.length;
  const out = [];
  for (let i = 0; i < n; i++) {
    const [x, y, r = 0] = pts[i];
    const p = pts[(i + n - 1) % n];
    const q = pts[(i + 1) % n];
    if (!r) {
      out.push({ a: [x, y], b: [x, y] });
      continue;
    }
    const v1 = [p[0] - x, p[1] - y];
    const v2 = [q[0] - x, q[1] - y];
    const l1 = Math.hypot(...v1);
    const l2 = Math.hypot(...v2);
    const u1 = [v1[0] / l1, v1[1] / l1];
    const u2 = [v2[0] / l2, v2[1] / l2];
    const ang = Math.acos(Math.max(-1, Math.min(1, u1[0] * u2[0] + u1[1] * u2[1])));
    let t = r / Math.tan(ang / 2);
    const tMax = Math.min(l1, l2) * 0.5;
    let rr = r;
    if (t > tMax) {
      t = tMax;
      rr = t * Math.tan(ang / 2);
    }
    const a = [x + u1[0] * t, y + u1[1] * t];
    const b = [x + u2[0] * t, y + u2[1] * t];
    const cross = u1[0] * u2[1] - u1[1] * u2[0];
    out.push({ a, b, r: rr, sweep: cross < 0 ? 1 : 0 });
  }
  let d = `M${f(out[0].b[0])} ${f(out[0].b[1])}`;
  for (let i = 1; i <= n; i++) {
    const c = out[i % n];
    d += `L${f(c.a[0])} ${f(c.a[1])}`;
    if (c.r) d += `A${f(c.r)} ${f(c.r)} 0 0 ${c.sweep} ${f(c.b[0])} ${f(c.b[1])}`;
  }
  return d + 'Z';
}

const poly = (pts) => 'M' + pts.map(([x, y]) => `${f(x)} ${f(y)}`).join('L') + 'Z';
const add = (a, b, k = 1) => [a[0] + b[0] * k, a[1] + b[1] * k];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
const unit = (v) => {
  const l = Math.hypot(...v);
  return [v[0] / l, v[1] / l];
};

// ---- key points -------------------------------------------------------------------------------
const { W, L0, L1, R0, R1, Y0, Yb, s, T, Yv, crease, gap } = G;
const O = [L0, Y0]; // left outer corner
const I = [L1, crease]; // left inner corner
const Or = [R1, Y0];
const Ir = [R0, crease];
const seamTop = [256, Yv];
const seamBot = [256, Yv + T];

// Play triangle (sharp vertices; rounded when drawn).
const P = { tl: [G.pLeft, G.pTop], tip: G.pTip, bl: [G.pLeft, G.pBottom] };
// Right leg ends with a cut through the inner corner, parallel to the play button's top edge.
const legCutOut = [R1, crease + G.k * W];

export const RADII = { outer: 34, end: 14, inner: 8, seam: 16, play: 18 };

/** The M's outline (without the play button). */
export function silhouette(r = RADII) {
  return roundedPath([
    [L0, Yb, r.end],
    [O[0], O[1], r.outer],
    [seamTop[0], seamTop[1], r.inner],
    [Or[0], Or[1], r.outer],
    [legCutOut[0], legCutOut[1], r.end],
    [Ir[0], Ir[1], r.end],
    [seamBot[0], seamBot[1], r.seam],
    [I[0], I[1], r.inner],
    [L1, Yb, r.end],
  ]);
}

export function playPath(r = RADII.play) {
  return roundedPath([
    [P.tl[0], P.tl[1], r],
    [P.tip[0], P.tip[1], r],
    [P.bl[0], P.bl[1], r],
  ]);
}

// Pieces, drawn back to front and clipped to the silhouette. Edges that are not creases or the
// seam are pushed well outside the outline so only the silhouette defines the outer edge.
export function pieces() {
  const creaseL = sub(I, O);
  const creaseR = sub(Ir, Or);
  return {
    leftLeg: poly([[L0 - 40, 0], [L1 + 40, 0], [L1 + 40, Yb + 40], [L0 - 40, Yb + 40]]),
    rightLeg: poly([[R0 - 40, 0], [R1 + 40, 0], [R1 + 40, Yb + 40], [R0 - 40, Yb + 40]]),
    // right diagonal: from the right crease to beyond the seam (hidden under the left diagonal)
    rightDiag: poly([add(Or, creaseR, -0.6), [200, -60], [200, Yb + 60], add(Ir, creaseR, 0.6)]),
    // left diagonal: from the left crease to the seam, in front
    leftDiag: poly([add(O, creaseL, -0.6), [256, -60], [256, Yb + 60], add(I, creaseL, 0.6)]),
    // soft shadows cast by the front layer at each fold
    leftLegShade: poly([add(O, creaseL, -0.6), add(I, creaseL, 0.6), add(add(I, creaseL, 0.6), [-120, 120]), add(add(O, creaseL, -0.6), [-120, 120])]),
    rightLegShade: poly([add(Or, creaseR, -0.6), add(Ir, creaseR, 0.6), add(add(Ir, creaseR, 0.6), [120, 120]), add(add(Or, creaseR, -0.6), [120, 120])]),
    seamShade: poly([[256, 0], [R0 - 1, 0], [R0 - 1, 512], [256, 512]]),
    creaseL: { a: O, b: I },
    creaseR: { a: Or, b: Ir },
  };
}

/** Unit normal of a crease, pointing towards `toward`. */
function normalToward(a, b, toward) {
  const d = unit(sub(b, a));
  let n = [-d[1], d[0]];
  const v = sub(toward, a);
  if (n[0] * v[0] + n[1] * v[1] < 0) n = [-n[0], -n[1]];
  return n;
}

export const COLORS = {
  ground: '#0A0F22',
  ink: '#0B1026',
  leg: ['#00F5E9', '#04BDF2', '#2362FA'],
  fold: ['#07D8EF', '#4777F9'],
  right: ['#F03CF2', '#6723D5'],
  rightLeg: ['#C93BEF', '#5A1FC4'],
  play: ['#F045FF', '#6427FA'],
};

/**
 * Full-colour mark as an SVG fragment (defs + group). `id` prefixes gradient ids so several marks can
 * share one document.
 */
export function markFull(id = 'mm') {
  const p = pieces();
  const nL = normalToward(O, I, [L0, Yb]);
  const nR = normalToward(Or, Ir, [R1, Yb]);
  const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  const cL = mid(O, I);
  const cR = mid(Or, Ir);
  const C = COLORS;
  const lin = (gid, x1, y1, x2, y2, stops) =>
    `<linearGradient id="${id}-${gid}" gradientUnits="userSpaceOnUse" x1="${f(x1)}" y1="${f(y1)}" x2="${f(x2)}" y2="${f(y2)}">${stops
      .map(([o, c, a]) => `<stop offset="${o}" stop-color="${c}"${a != null ? ` stop-opacity="${a}"` : ''}/>`)
      .join('')}</linearGradient>`;
  const defs = [
    lin('leg', L0, Y0, L1 + 60, Yb, [[0, C.leg[0]], [0.55, C.leg[1]], [1, C.leg[2]]]),
    lin('fold', L0, Y0, 256, Yv + T, [[0, C.fold[0]], [1, C.fold[1]]]),
    lin('right', 256, Yv + T, R1, Y0, [[0, C.right[1]], [1, C.right[0]]]),
    lin('rleg', R1, Y0, R0, Yb, [[0, C.rightLeg[0]], [1, C.rightLeg[1]]]),
    lin('play', G.pLeft, G.pTop, G.pTip[0], G.pBottom, [[0, C.play[0]], [1, C.play[1]]]),
    lin('shL', cL[0], cL[1], cL[0] + nL[0] * 46, cL[1] + nL[1] * 46, [[0, '#061033', 0.5], [1, '#061033', 0]]),
    lin('shR', cR[0], cR[1], cR[0] + nR[0] * 46, cR[1] + nR[1] * 46, [[0, '#1A0640', 0.55], [1, '#1A0640', 0]]),
    lin('shS', 256, 0, 306, 0, [[0, '#1A0640', 0.5], [1, '#1A0640', 0]]),
    `<clipPath id="${id}-clip"><path d="${silhouette()}"/></clipPath>`,
  ].join('');
  const body = `<g clip-path="url(#${id}-clip)">
<path d="${p.rightLeg}" fill="url(#${id}-rleg)"/>
<path d="${p.rightLegShade}" fill="url(#${id}-shR)"/>
<path d="${p.rightDiag}" fill="url(#${id}-right)"/>
<path d="${p.seamShade}" fill="url(#${id}-shS)"/>
<path d="${p.leftLeg}" fill="url(#${id}-leg)"/>
<path d="${p.leftLegShade}" fill="url(#${id}-shL)"/>
<path d="${p.leftDiag}" fill="url(#${id}-fold)"/>
</g>
<path d="${playPath()}" fill="url(#${id}-play)"/>`;
  return { defs, body };
}

/**
 * Simplified mark for 16-48 px: same silhouette, flat two-tone (cyan-blue left, magenta right),
 * no shading, and a slightly larger play button.
 */
export function markSimple(id = 'mms') {
  const p = pieces();
  const C = COLORS;
  const defs = `<linearGradient id="${id}-l" gradientUnits="userSpaceOnUse" x1="${L0}" y1="${Y0}" x2="256" y2="${Yb}"><stop offset="0" stop-color="${C.leg[0]}"/><stop offset="1" stop-color="${C.leg[2]}"/></linearGradient><linearGradient id="${id}-r" gradientUnits="userSpaceOnUse" x1="${R1}" y1="${Y0}" x2="256" y2="${Yb}"><stop offset="0" stop-color="${C.right[0]}"/><stop offset="1" stop-color="${C.right[1]}"/></linearGradient><clipPath id="${id}-clip"><path d="${silhouette()}"/></clipPath>`;
  const body = `<g clip-path="url(#${id}-clip)"><rect x="256" width="256" height="512" fill="url(#${id}-r)"/><path d="${p.leftLeg}" fill="url(#${id}-l)"/><path d="${p.leftDiag}" fill="url(#${id}-l)"/></g><path d="${playPath(14)}" fill="url(#${id}-r)"/>`;
  return { defs, body };
}

/** Single-colour silhouette (outline of the M + play button) in `color`; creases shown as thin gaps. */
export function markMono(color = '#000', { creases = true } = {}) {
  const d = silhouette() + playPath();
  if (!creases) return { defs: '', body: `<path d="${d}" fill="${color}"/>` };
  // Cut a thin line along the left fold and the seam so the ribbon still reads in one colour.
  const cut = (a, b, w) => {
    const n = unit([-(b[1] - a[1]), b[0] - a[0]]);
    return poly([add(a, n, w / 2), add(b, n, w / 2), add(b, n, -w / 2), add(a, n, -w / 2)]);
  };
  const m = `<mask id="mmmono"><rect width="512" height="512" fill="#fff"/><path d="${cut(O, I, 10)}" fill="#000"/><path d="${cut(Or, Ir, 10)}" fill="#000"/><path d="${cut([256, Yv - 5], [256, Yv + T + 5], 10)}" fill="#000"/></mask>`;
  return { defs: m, body: `<path d="${d}" fill="${color}" mask="url(#mmmono)"/>` };
}

/** Bounding box of the mark (silhouette + play button) on the 512 grid. */
export const BBOX = { x: L0, y: Y0, w: G.pTip[0] - L0, h: G.pBottom - Y0 };

/**
 * Translation that centres the mark optically in the 512 square: the play button's pointed tip
 * carries less visual weight than its bounding box suggests, so the mark sits ~6 px right of the
 * geometric centre; vertically the heavy top bar is balanced by sitting 2 px high.
 */
export const CENTER = { dx: +(256 - (BBOX.x + BBOX.w / 2) + 6).toFixed(2), dy: +(256 - (BBOX.y + BBOX.h / 2) - 2).toFixed(2) };

/** Wrap a fragment in a <g> that centres it, scaled by `scale` around the 512 square's centre. */
export function centered(frag, scale = 1) {
  const t = scale === 1 ? `translate(${CENTER.dx} ${CENTER.dy})` : `translate(256 256) scale(${scale}) translate(${-256 + CENTER.dx} ${-256 + CENTER.dy})`;
  return { defs: frag.defs, body: `<g transform="${t}">${frag.body}</g>` };
}

/** Outline vertices (silhouette + play button), for safe-zone calculations. Rounded corners lie inside these. */
export function keyPoints() {
  return [[L0, Yb], O, seamTop, Or, legCutOut, Ir, seamBot, I, [L1, Yb], P.tl, P.tip, P.bl];
}
