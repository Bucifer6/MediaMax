import { tintColors, MONTHS, type StoryCard } from './cards';

/** Story export size (Instagram / TikTok / WhatsApp status). */
export const EXPORT_W = 1080;
export const EXPORT_H = 1920;

const imgCache = new Map<string, Promise<HTMLImageElement | null>>();

/** Load an image for canvas use; null when it fails or would taint the canvas (cross-origin without CORS). */
export function loadImage(url: string | null | undefined, width = 600): Promise<HTMLImageElement | null> {
  if (!url) return Promise.resolve(null);
  const src = url.startsWith('/api/') ? `${url}${url.includes('?') ? '&' : '?'}w=${width}` : url;
  let p = imgCache.get(src);
  if (!p) {
    p = new Promise((resolve) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.decoding = 'async';
      img.onload = () => resolve(img);
      img.onerror = () => resolve(null);
      img.src = src;
    });
    imgCache.set(src, p);
  }
  return p;
}

/** Average colour of an image (sampled small), or null if it can't be read. */
export async function sampleColor(url: string | null | undefined): Promise<[number, number, number] | null> {
  const img = await loadImage(url, 120);
  if (!img) return null;
  try {
    const c = document.createElement('canvas');
    c.width = 12;
    c.height = 18;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(img, 0, 0, 12, 18);
    const d = ctx.getImageData(0, 0, 12, 18).data;
    let r = 0, g = 0, b = 0, n = 0;
    for (let i = 0; i < d.length; i += 4) {
      // Skip near-black / near-white pixels (letterboxing, titles) so the tint has colour.
      const lum = d[i] * 0.3 + d[i + 1] * 0.59 + d[i + 2] * 0.11;
      if (lum < 18 || lum > 240) continue;
      r += d[i];
      g += d[i + 1];
      b += d[i + 2];
      n++;
    }
    return n ? [r / n, g / n, b / n] : null;
  } catch {
    return null; // tainted
  }
}

function wrap(ctx: CanvasRenderingContext2D, text: string, maxW: number, maxLines: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = '';
  for (const w of words) {
    const test = line ? `${line} ${w}` : w;
    if (ctx.measureText(test).width <= maxW || !line) line = test;
    else {
      lines.push(line);
      line = w;
    }
  }
  if (line) lines.push(line);
  if (lines.length > maxLines) {
    const kept = lines.slice(0, maxLines);
    let last = kept[maxLines - 1];
    while (last.length > 1 && ctx.measureText(`${last}…`).width > maxW) last = last.slice(0, -1);
    kept[maxLines - 1] = `${last}…`;
    return kept;
  }
  return lines;
}

/** Fit a font size so `text` fits on one line in `maxW`. */
function fit(ctx: CanvasRenderingContext2D, text: string, weight: number, start: number, min: number, maxW: number, family: string): number {
  let size = start;
  for (; size > min; size -= 4) {
    ctx.font = `${weight} ${size}px ${family}`;
    if (ctx.measureText(text).width <= maxW) break;
  }
  return size;
}

function cover(ctx: CanvasRenderingContext2D, img: HTMLImageElement, x: number, y: number, w: number, h: number, r: number) {
  const s = Math.max(w / img.naturalWidth, h / img.naturalHeight);
  const sw = w / s;
  const sh = h / s;
  ctx.save();
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
  ctx.clip();
  ctx.drawImage(img, (img.naturalWidth - sw) / 2, (img.naturalHeight - sh) / 2, sw, sh, x, y, w, h);
  ctx.restore();
}

/** Draw one story card as a 1080×1920 image. Client-side only (no server rendering). */
export async function renderCard(card: StoryCard, brand: string, index: number, total: number, rgb?: [number, number, number] | null): Promise<HTMLCanvasElement> {
  const c = document.createElement('canvas');
  c.width = EXPORT_W;
  c.height = EXPORT_H;
  const ctx = c.getContext('2d')!;
  const family = getComputedStyle(document.documentElement).getPropertyValue('--font').trim() || 'system-ui, sans-serif';
  const tint = tintColors(rgb === undefined ? await sampleColor(card.image) : rgb, card.hue);
  const W = EXPORT_W;
  const PAD = 88;
  const inner = W - PAD * 2;

  // Background: artwork-tinted gradient + a blurred artwork wash.
  const g = ctx.createLinearGradient(0, 0, W * 0.4, EXPORT_H);
  g.addColorStop(0, tint.from);
  g.addColorStop(1, tint.to);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, EXPORT_H);
  const art = await loadImage(card.image, 800);
  if (art) {
    ctx.save();
    ctx.globalAlpha = 0.28;
    ctx.filter = 'blur(40px)';
    cover(ctx, art, -80, -80, W + 160, EXPORT_H * 0.7, 0);
    ctx.restore();
    const fade = ctx.createLinearGradient(0, EXPORT_H * 0.25, 0, EXPORT_H * 0.75);
    fade.addColorStop(0, 'rgba(0,0,0,0)');
    fade.addColorStop(1, tint.to);
    ctx.fillStyle = fade;
    ctx.fillRect(0, 0, W, EXPORT_H);
  }

  // Story progress bars at the top, like the in-app view.
  const barW = (inner - (total - 1) * 10) / total;
  for (let i = 0; i < total; i++) {
    ctx.fillStyle = i <= index ? 'rgba(255,255,255,0.95)' : 'rgba(255,255,255,0.3)';
    ctx.beginPath();
    ctx.roundRect(PAD + i * (barW + 10), 70, barW, 8, 4);
    ctx.fill();
  }

  let y = 190;
  ctx.fillStyle = tint.accent;
  ctx.font = `800 40px ${family}`;
  ctx.textBaseline = 'top';
  ctx.fillText(card.eyebrow.toUpperCase(), PAD, y, inner);
  y += 90;

  if (art && (card.kind === 'titles' || card.kind === 'binge' || card.kind === 'intro' || card.kind === 'music' || card.kind === 'people')) {
    const h = card.kind === 'people' ? 460 : 620;
    const w = card.kind === 'people' ? 460 : Math.round(h * (2 / 3));
    if (card.kind === 'people') {
      ctx.save();
      ctx.beginPath();
      ctx.arc(PAD + w / 2, y + h / 2, w / 2, 0, Math.PI * 2);
      ctx.clip();
      cover(ctx, art, PAD, y, w, h, 0);
      ctx.restore();
    } else {
      ctx.save();
      ctx.shadowColor = 'rgba(0,0,0,0.5)';
      ctx.shadowBlur = 60;
      ctx.shadowOffsetY = 24;
      ctx.fillStyle = '#000';
      ctx.beginPath();
      ctx.roundRect(PAD, y, w, h, 28);
      ctx.fill();
      ctx.restore();
      cover(ctx, art, PAD, y, w, h, 28);
    }
    y += h + 70;
  }

  ctx.fillStyle = '#fff';
  if (card.big) {
    const size = fit(ctx, card.big, 900, card.kind === 'genres' || card.kind === 'intro' ? 200 : 300, 90, inner, family);
    ctx.font = `900 ${size}px ${family}`;
    ctx.fillText(card.big, PAD - 6, y, inner);
    y += size * 0.95;
    if (card.bigUnit) {
      ctx.font = `800 64px ${family}`;
      ctx.fillStyle = tint.accent;
      ctx.fillText(card.bigUnit, PAD, y, inner);
      ctx.fillStyle = '#fff';
      y += 90;
    }
  }
  const hSize = card.big ? 72 : 108;
  ctx.font = `900 ${hSize}px ${family}`;
  for (const line of wrap(ctx, card.headline, inner, card.big ? 3 : 4)) {
    ctx.fillText(line, PAD, y, inner);
    y += hSize * 1.08;
  }
  if (card.sub) {
    y += 16;
    ctx.font = `500 44px ${family}`;
    ctx.fillStyle = 'rgba(255,255,255,0.82)';
    for (const line of wrap(ctx, card.sub, inner, 4)) {
      ctx.fillText(line, PAD, y, inner);
      y += 58;
    }
  }
  if (card.traits?.length) {
    y += 30;
    ctx.font = `700 40px ${family}`;
    let x = PAD;
    for (const t of card.traits) {
      const w = ctx.measureText(t).width + 56;
      if (x + w > W - PAD) {
        x = PAD;
        y += 92;
      }
      ctx.fillStyle = 'rgba(255,255,255,0.16)';
      ctx.beginPath();
      ctx.roundRect(x, y, w, 72, 36);
      ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.fillText(t, x + 28, y + 16);
      x += w + 16;
    }
    y += 100;
  }

  // Ranked list (titles, genres, people, tracks), under the headline when there's room.
  if (card.list?.length && card.kind !== 'intro') {
    y += 40;
    const rowH = 120;
    const rows = card.list.slice(0, Math.max(0, Math.min(5, Math.floor((EXPORT_H - 200 - y) / rowH))));
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      ctx.fillStyle = tint.accent;
      ctx.font = `900 56px ${family}`;
      ctx.fillText(String(i + 1), PAD, y + 26);
      let tx = PAD + 80;
      const im = await loadImage(r.image, 200);
      if (im) {
        if (r.round) {
          ctx.save();
          ctx.beginPath();
          ctx.arc(tx + 48, y + 50, 48, 0, Math.PI * 2);
          ctx.clip();
          cover(ctx, im, tx, y + 2, 96, 96, 0);
          ctx.restore();
          tx += 120;
        } else {
          cover(ctx, im, tx, y - 6, 72, 108, 10);
          tx += 96;
        }
      }
      ctx.fillStyle = '#fff';
      ctx.font = `800 46px ${family}`;
      ctx.fillText(wrap(ctx, r.title, W - PAD - tx, 1)[0] ?? '', tx, y + 10);
      ctx.fillStyle = 'rgba(255,255,255,0.7)';
      ctx.font = `500 34px ${family}`;
      ctx.fillText(wrap(ctx, r.meta, W - PAD - tx, 1)[0] ?? '', tx, y + 66);
      y += rowH;
    }
  }

  // Heatmap: 12 rows of day cells.
  if (card.heat) {
    y = Math.max(y + 40, 900);
    const cell = Math.floor((inner - 90) / 31);
    const max = Math.max(1, ...card.heat.flat());
    card.heat.forEach((days, m) => {
      ctx.fillStyle = 'rgba(255,255,255,0.7)';
      ctx.font = `700 30px ${family}`;
      ctx.fillText(MONTHS[m], PAD, y + m * (cell + 8) + cell / 2 - 15);
      days.forEach((v, d) => {
        const a = v > 0 ? 0.25 + 0.75 * Math.sqrt(v / max) : 0.08;
        ctx.fillStyle = v > 0 ? tint.accent : '#fff';
        ctx.globalAlpha = a;
        ctx.beginPath();
        ctx.roundRect(PAD + 90 + d * cell, y + m * (cell + 8), cell - 6, cell, 6);
        ctx.fill();
        ctx.globalAlpha = 1;
      });
    });
  }

  // Footer: product name from the server's branding.
  ctx.fillStyle = 'rgba(255,255,255,0.75)';
  ctx.font = `800 38px ${family}`;
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(brand, PAD, EXPORT_H - 90, inner);
  return c;
}

export const canvasToPng = (c: HTMLCanvasElement): Promise<Blob> =>
  new Promise((resolve, reject) => c.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not create the image'))), 'image/png'));

/** Share images with the system share sheet (Web Share API level 2) or download them. */
export async function shareOrDownload(files: File[], title: string): Promise<'shared' | 'downloaded' | 'cancelled'> {
  const nav = navigator as Navigator & { canShare?: (d: ShareData) => boolean };
  if (nav.share && nav.canShare?.({ files })) {
    try {
      await nav.share({ files, title });
      return 'shared';
    } catch (e) {
      if ((e as Error).name === 'AbortError') return 'cancelled';
      // Fall through to downloading (e.g. too many files for this platform).
    }
  }
  for (const f of files) {
    const url = URL.createObjectURL(f);
    const a = document.createElement('a');
    a.href = url;
    a.download = f.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 4000);
    // Browsers throttle bursts of downloads.
    await new Promise((r) => setTimeout(r, 250));
  }
  return 'downloaded';
}
