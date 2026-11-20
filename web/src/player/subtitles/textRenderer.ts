/**
 * DOM renderer for text cues (SRT, WebVTT, ASS fallback). Draws into a "stage" box laid over the video's content
 * rectangle (object-fit: contain), so positions in % and ASS script pixels map onto the picture, not the letterbox.
 * Re-renders only when the set of active cues changes, or every frame while an animated ASS cue (\move, \fad,
 * karaoke) is showing.
 */
import type { SubtitleStyle } from '@mediamax/shared';
import { assOpacity, assPosition } from './ass';
import type { ParsedText, TextCue, TextRun } from './types';

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The displayed picture inside a <video> with object-fit: contain. */
export function videoContentRect(v: HTMLVideoElement): Rect {
  const W = v.clientWidth;
  const H = v.clientHeight;
  const vw = v.videoWidth || 16;
  const vh = v.videoHeight || 9;
  const scale = Math.min(W / vw, H / vh);
  const width = vw * scale;
  const height = vh * scale;
  return { x: v.offsetLeft + (W - width) / 2, y: v.offsetTop + (H - height) / 2, width, height };
}

const SIZE: Record<SubtitleStyle['size'], number> = { small: 0.75, medium: 1, large: 1.3, xlarge: 1.65 };
const COLOR: Record<SubtitleStyle['color'], string> = { white: '#ffffff', yellow: '#ffe94d', cyan: '#5ff2ff', green: '#6dff7a' };
const FONT: Record<SubtitleStyle['font'], string> = {
  default: 'var(--font, system-ui, sans-serif)',
  serif: 'Georgia, "Times New Roman", Times, serif',
  mono: 'ui-monospace, "SFMono-Regular", Menlo, Consolas, "Liberation Mono", monospace',
  rounded: 'ui-rounded, "SF Pro Rounded", "Nunito", "Varela Round", "Arial Rounded MT Bold", system-ui, sans-serif',
};

export interface TextRenderOptions {
  style: SubtitleStyle;
  /** 10-foot UI: larger text, more margin from the edges (overscan). */
  tv: boolean;
  /** ASS: render the file's own styling (fallback renderer) or plain text in the user's style. */
  assMode: 'file' | 'user';
}

/** Text outline built from shadows (works everywhere, unlike paint-order on HTML text). */
function outlineShadow(px: number, color: string, shadow = 0, shadowColor = 'rgba(0,0,0,0.6)'): string {
  if (px <= 0 && shadow <= 0) return 'none';
  const parts: string[] = [];
  if (px > 0) {
    const steps = px > 2 ? 16 : 8;
    for (let i = 0; i < steps; i++) {
      const a = (i / steps) * Math.PI * 2;
      parts.push(`${(Math.cos(a) * px).toFixed(2)}px ${(Math.sin(a) * px).toFixed(2)}px 0 ${color}`);
    }
  }
  if (shadow > 0) parts.push(`${shadow.toFixed(2)}px ${shadow.toFixed(2)}px ${Math.max(1, shadow / 2).toFixed(2)}px ${shadowColor}`);
  return parts.join(', ');
}

export class TextRenderer {
  readonly stage: HTMLDivElement;
  private bottom: HTMLDivElement;
  private top: HTMLDivElement;
  private key = '';
  private parsed: ParsedText = { cues: [] };
  private opts: TextRenderOptions;
  private rect: Rect = { x: 0, y: 0, width: 0, height: 0 };

  constructor(container: HTMLElement, opts: TextRenderOptions) {
    this.opts = opts;
    this.stage = document.createElement('div');
    this.stage.className = 'mm-sub-stage';
    this.bottom = document.createElement('div');
    this.bottom.className = 'mm-sub-region mm-sub-bottom';
    this.top = document.createElement('div');
    this.top.className = 'mm-sub-region mm-sub-top';
    this.stage.append(this.top, this.bottom);
    container.appendChild(this.stage);
  }

  setTrack(parsed: ParsedText) {
    this.parsed = parsed;
    this.key = '';
  }

  setOptions(opts: TextRenderOptions) {
    this.opts = opts;
    this.key = '';
  }

  /** Base font size (px) for user-styled text: ~5% of the picture height, bigger in TV mode. */
  private baseSize() {
    return Math.max(12, this.rect.height * 0.05 * (this.opts.tv ? 1.12 : 1) * SIZE[this.opts.style.size]);
  }

  private bottomOffsetPct() {
    const s = this.opts.style;
    if (s.verticalOffset != null) return Math.max(0, Math.min(25, s.verticalOffset));
    return s.position === 'raised' ? 14 : this.opts.tv ? 6 : 4.5;
  }

  /** Draw the cues active at subtitle time `t` (ms). */
  render(cues: TextCue[], t: number, rect: Rect) {
    const animated = cues.some((c) => c.ass && this.opts.assMode === 'file' && (c.ass.move || c.ass.fade || c.runs.some((r) => r.karaoke)));
    const k = `${cues.map((c) => `${c.start}:${c.end}:${c.runs.length}`).join('|')}#${rect.width}x${rect.height}@${rect.x},${rect.y}`;
    if (k === this.key && !animated) return;
    this.key = k;
    this.rect = rect;
    Object.assign(this.stage.style, { left: `${rect.x}px`, top: `${rect.y}px`, width: `${rect.width}px`, height: `${rect.height}px` });
    this.bottom.textContent = '';
    this.top.textContent = '';
    for (const el of Array.from(this.stage.querySelectorAll('.mm-sub-abs'))) el.remove();
    this.bottom.style.bottom = `${this.bottomOffsetPct()}%`;
    this.top.style.top = this.opts.tv ? '6%' : '4%';
    for (const c of cues) {
      if (c.ass && this.opts.assMode === 'file') this.renderAss(c, t);
      else this.renderText(c);
    }
  }

  clear() {
    if (!this.key) return;
    this.key = '';
    this.bottom.textContent = '';
    this.top.textContent = '';
    for (const el of Array.from(this.stage.querySelectorAll('.mm-sub-abs'))) el.remove();
  }

  destroy() {
    this.stage.remove();
  }

  /* ----------------------------- user style ----------------------------- */

  private userCueStyle(el: HTMLElement, line: HTMLElement[]) {
    const s = this.opts.style;
    const size = this.baseSize();
    el.style.fontSize = `${size}px`;
    el.style.fontFamily = FONT[s.font];
    el.style.fontWeight = s.font === 'mono' ? '500' : '600';
    el.style.color = COLOR[s.color];
    const edge = s.edge ?? 'outline';
    const box = s.background === 'box' ? 'rgb(0 0 0 / 0.62)' : s.background === 'boxSolid' ? 'rgb(0 0 0 / 1)' : '';
    const shadow = s.background === 'none'
      ? 'none'
      : box
        ? '0 1px 2px rgb(0 0 0 / 0.6)'
        : edge === 'shadow' ? `${(size * 0.05).toFixed(1)}px ${(size * 0.05).toFixed(1)}px ${(size * 0.08).toFixed(1)}px rgb(0 0 0 / 0.9)` : edge === 'none' ? 'none' : outlineShadow(Math.max(1.2, size * 0.045), '#000', size * 0.03);
    for (const span of line) {
      if (box) {
        span.style.backgroundColor = box;
        span.style.padding = '0.08em 0.32em';
        (span.style as unknown as Record<string, string>).boxDecorationBreak = 'clone';
        (span.style as unknown as Record<string, string>).webkitBoxDecorationBreak = 'clone';
      }
      span.style.textShadow = shadow;
    }
  }

  private runSpan(r: TextRun): HTMLElement {
    if (r.br) return document.createElement('br');
    const span = document.createElement('span');
    span.textContent = r.text;
    const cls = r.classes?.map((c) => this.parsed.classStyles?.[c]).filter(Boolean) ?? [];
    const st = Object.assign({}, ...cls, r) as TextRun;
    if (st.i) span.style.fontStyle = 'italic';
    if (st.b) span.style.fontWeight = '800';
    const deco = [st.u && 'underline', st.s && 'line-through'].filter(Boolean).join(' ');
    if (deco) span.style.textDecoration = deco;
    if (st.color) span.style.color = st.color;
    if (st.background) span.style.backgroundColor = st.background;
    return span;
  }

  /** SRT / WebVTT cue (and ASS in "my style" mode). */
  private renderText(c: TextCue) {
    const box = document.createElement('div');
    box.className = 'mm-sub-cue';
    const inner = document.createElement('div');
    inner.className = 'mm-sub-text';
    const spans: HTMLElement[] = [];
    // Plain text for ASS in user mode.
    const runs = c.ass && this.opts.assMode === 'user' ? c.runs.map((r) => (r.br ? r : { text: r.text, i: r.i, b: r.b })) : c.runs;
    for (const r of runs) {
      const el = this.runSpan(r);
      if (!r.br) spans.push(el);
      inner.appendChild(el);
    }
    box.appendChild(inner);
    this.userCueStyle(inner, spans);
    // Colours set by the cue itself (span style) win over the user's colour (inherited from `inner`).
    const v = c.vtt;
    const assTop = c.ass && c.ass.an >= 7;
    if (!v || (v.line == null && v.position == null && v.size == null && !v.vertical)) {
      if (v?.align) inner.style.textAlign = v.align === 'start' || v.align === 'left' ? 'left' : v.align === 'end' || v.align === 'right' ? 'right' : 'center';
      (assTop ? this.top : this.bottom).appendChild(box);
      return;
    }
    // Positioned WebVTT cue.
    box.classList.add('mm-sub-abs');
    const st = box.style;
    st.position = 'absolute';
    const align = v.align ?? 'center';
    inner.style.textAlign = align === 'start' || align === 'left' ? 'left' : align === 'end' || align === 'right' ? 'right' : 'center';
    if (v.vertical) (inner.style as unknown as Record<string, string>).writingMode = v.vertical === 'rl' ? 'vertical-rl' : 'vertical-lr';
    const pos = v.position ?? (align === 'start' || align === 'left' ? 0 : align === 'end' || align === 'right' ? 100 : 50);
    const pa = v.positionAlign ?? (align === 'start' || align === 'left' ? 'line-left' : align === 'end' || align === 'right' ? 'line-right' : 'center');
    const size = v.size ?? 100;
    let left = pa === 'line-left' ? pos : pa === 'line-right' ? pos - size : pos - size / 2;
    left = Math.max(0, Math.min(100 - size, left));
    st.left = `${left}%`;
    st.width = `${size}%`;
    if (v.line == null) {
      st.bottom = `${this.bottomOffsetPct()}%`;
    } else if (v.snapToLines !== false) {
      const lh = this.baseSize() * 1.3;
      if (v.line >= 0) st.top = `${v.line * lh + this.rect.height * 0.02}px`;
      else st.bottom = `${(-v.line - 1) * lh + this.rect.height * 0.02}px`;
    } else {
      st.top = `${v.line}%`;
      if (v.lineAlign === 'center') st.transform = 'translateY(-50%)';
      else if (v.lineAlign === 'end') st.transform = 'translateY(-100%)';
    }
    this.stage.appendChild(box);
  }

  /* ------------------------------ ASS fallback ------------------------------ */

  private renderAss(c: TextCue, t: number) {
    const a = c.ass!;
    const pr = this.parsed.playRes ?? { x: 384, y: 288 };
    const sy = this.rect.height / pr.y;
    const sx = this.rect.width / pr.x;
    const st = a.style;
    const box = document.createElement('div');
    box.className = 'mm-sub-abs mm-sub-ass';
    const local = t - c.start;
    const dur = c.end - c.start;
    const opacity = assOpacity(a, local, dur);
    const s = box.style;
    s.position = 'absolute';
    s.opacity = String(opacity);
    s.zIndex = String(10 + a.layer);
    s.whiteSpace = 'pre-wrap';
    s.lineHeight = '1.15';
    const col = a.an % 3 === 1 ? 'left' : a.an % 3 === 0 ? 'right' : 'center';
    const row = a.an >= 7 ? 'top' : a.an >= 4 ? 'middle' : 'bottom';
    s.textAlign = col;
    const p = assPosition(a, local, dur);
    if (p) {
      s.left = `${p.x * sx}px`;
      s.top = `${p.y * sy}px`;
      const tx = col === 'left' ? '0' : col === 'right' ? '-100%' : '-50%';
      const ty = row === 'top' ? '0' : row === 'bottom' ? '-100%' : '-50%';
      s.transform = `translate(${tx}, ${ty})`;
      // Positioned lines don't wrap (as in libass, which only wraps at the margins).
      s.whiteSpace = 'pre';
    } else {
      s.left = `${a.marginL * sx}px`;
      s.right = `${a.marginR * sx}px`;
      if (row === 'top') s.top = `${a.marginV * sy}px`;
      else if (row === 'bottom') s.bottom = `${a.marginV * sy}px`;
      else {
        s.top = '50%';
        s.transform = 'translateY(-50%)';
      }
    }
    for (const r of c.runs) {
      if (r.br) {
        box.appendChild(document.createElement('br'));
        continue;
      }
      const span = document.createElement('span');
      span.textContent = r.text;
      const fs = (r.size ?? st.size) * sy;
      span.style.fontSize = `${fs.toFixed(2)}px`;
      span.style.fontFamily = `"${(r.font ?? st.font).replace(/"/g, '')}", "Liberation Sans", Arial, sans-serif`;
      span.style.fontWeight = r.b ? '700' : '400';
      if (r.i) span.style.fontStyle = 'italic';
      const deco = [r.u && 'underline', r.s && 'line-through'].filter(Boolean).join(' ');
      if (deco) span.style.textDecoration = deco;
      let color = r.color ?? st.primary;
      if (r.karaoke && local < r.karaoke.start + (r.karaoke.kind === 'k' ? 0 : r.karaoke.dur / 2)) color = r.karaoke.before;
      span.style.color = color;
      if (r.alpha != null && r.alpha < 1) span.style.opacity = String(r.alpha);
      if (st.spacing) span.style.letterSpacing = `${st.spacing * sx}px`;
      const outline = (r.outline ?? st.outline) * sy;
      const shadow = (r.shadow ?? st.shadow) * sy;
      if (st.borderStyle === 3) {
        span.style.backgroundColor = r.outlineColor ?? st.outlineColor;
        span.style.padding = `0 ${Math.max(outline, 1)}px`;
        span.style.textShadow = shadow > 0 ? `${shadow}px ${shadow}px 0 ${st.back}` : 'none';
      } else span.style.textShadow = outlineShadow(outline, r.outlineColor ?? st.outlineColor, shadow, st.back);
      box.appendChild(span);
    }
    this.stage.appendChild(box);
  }
}
