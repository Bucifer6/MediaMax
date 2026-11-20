/**
 * Canvas renderer for decoded PGS events. Bitmaps are decoded on first display (pgs.ts decodeEvent) and the last few
 * kept as canvases; the display canvas covers the video's content rectangle and scales the PGS coordinate space
 * (usually 1920×1080) onto it.
 */
import { decodeEvent, type PgsEvent } from './pgs';
import type { Rect } from './textRenderer';

const CACHE = 4;

export class PgsRenderer {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D | null;
  private shown: PgsEvent | null = null;
  private shownKey = '';
  private cache = new Map<PgsEvent, { canvas: HTMLCanvasElement; x: number; y: number }[]>();

  constructor(container: HTMLElement) {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'mm-sub-pgs';
    container.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d');
  }

  private bitmaps(e: PgsEvent) {
    let b = this.cache.get(e);
    if (!b) {
      b = decodeEvent(e).filter((d) => d.width > 0 && d.height > 0).map((d) => {
        const c = document.createElement('canvas');
        c.width = d.width;
        c.height = d.height;
        c.getContext('2d')?.putImageData(new ImageData(d.rgba as Uint8ClampedArray<ArrayBuffer>, d.width, d.height), 0, 0);
        return { canvas: c, x: d.x, y: d.y };
      });
      this.cache.set(e, b);
      if (this.cache.size > CACHE) this.cache.delete(this.cache.keys().next().value!);
    }
    return b;
  }

  render(e: PgsEvent | null, rect: Rect) {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const key = `${rect.x},${rect.y},${rect.width},${rect.height},${dpr}`;
    if (e === this.shown && key === this.shownKey) return;
    this.shown = e;
    this.shownKey = key;
    const c = this.canvas;
    Object.assign(c.style, { left: `${rect.x}px`, top: `${rect.y}px`, width: `${rect.width}px`, height: `${rect.height}px` });
    const w = Math.max(1, Math.round(rect.width * dpr));
    const h = Math.max(1, Math.round(rect.height * dpr));
    if (c.width !== w || c.height !== h) {
      c.width = w;
      c.height = h;
    }
    const ctx = this.ctx;
    if (!ctx) return;
    ctx.clearRect(0, 0, w, h);
    if (!e) return;
    const sx = w / (e.videoWidth || 1920);
    const sy = h / (e.videoHeight || 1080);
    ctx.imageSmoothingEnabled = true;
    for (const b of this.bitmaps(e)) ctx.drawImage(b.canvas, b.x * sx, b.y * sy, b.canvas.width * sx, b.canvas.height * sy);
  }

  clear() {
    if (this.shown) this.render(null, { x: 0, y: 0, width: this.canvas.clientWidth, height: this.canvas.clientHeight });
  }

  destroy() {
    this.cache.clear();
    this.canvas.remove();
  }
}
