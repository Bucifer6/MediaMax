/** Kinora / Screenlight: a K cut from a strip of film. Flat colour and an open joint stay legible at launcher sizes. */
export const COLORS = {
  ground: '#101416', groundGlow: '#1D3432', ink: '#162321',
  stem: ['#63DEC5', '#63DEC5'], stemSimple: '#63DEC5',
  beam: ['#A4F0DE', '#63DEC5', '#32AD97'], beamSimple: ['#63DEC5', '#63DEC5'],
};
const STEM = 'M126 88H166Q184 88 184 106V406Q184 424 166 424H126Q108 424 108 406V106Q108 88 126 88Z';
const UPPER = 'M208 238L330 96Q336 88 348 88H418L282 248Q276 256 264 256H208Z';
const LOWER = 'M208 274V256H264Q276 256 282 264L418 424H348Q336 424 330 416Z';
const PATH = STEM + UPPER + LOWER;
/** Matching full/small silhouettes avoid losing detail at 16 px. */
export function markFull(_id, color = COLORS.stemSimple) { return { defs: '', body: `<path d="${PATH}" fill="${color}"/>` }; }
export function markSimple() { return markFull(); }
export function markMono(color = '#000') { return { defs: '', body: `<path d="${PATH}" fill="${color}"/>` }; }
export const BBOX = { x: 108, y: 88, w: 310, h: 336 };
export const CENTER = { dx: -1, dy: 0 };
export function centered(frag, scale = 1) {
  const t = `translate(256 256) scale(${scale}) translate(${-256 + CENTER.dx} ${-256 + CENTER.dy})`;
  return { defs: frag.defs, body: `<g transform="${t}">${frag.body}</g>` };
}
export function keyPoints() { return [[108, 88], [184, 88], [184, 424], [108, 424], [418, 88], [418, 424]]; }
