/**
 * ASS/SSA → styled text cues, for the fallback renderer (devices without WebAssembly/Workers, or when the user
 * prefers their own subtitle style). Full-fidelity rendering is libass (jassub) — see assRenderer.ts.
 *
 * Supported here: [Script Info] PlayResX/Y, [V4+ Styles]/[V4 Styles] (font, size, colours incl. alpha, bold/italic/
 * underline/strike, border style, outline, shadow, alignment, margins, scale, spacing), Dialogue events with layer and
 * margins, and override tags \i \b \u \s \c \1c \2c \3c \4c \1a \3a \alpha \fn \fs \bord \shad \an \a \pos \move \fad
 * \fade (simplified) \k \K \kf \ko \r \N \n \h. Drawings (\p1) and clips are skipped.
 */
import type { AssLayout, AssStyleLite, ParsedText, TextCue, TextRun } from './types';

/** "&H00BBGGRR" / "&HBBGGRR&" / decimal → { css colour, alpha 0..1 (1 = opaque) }. */
export function assColor(v: string | undefined, fallback = '#ffffff'): { color: string; alpha: number } {
  if (!v) return { color: fallback, alpha: 1 };
  const s = v.trim().replace(/&/g, '');
  let n: number;
  if (/^H[0-9a-f]+$/i.test(s)) n = parseInt(s.slice(1), 16);
  else if (/^-?\d+$/.test(s)) n = Number(s) >>> 0;
  else return { color: fallback, alpha: 1 };
  const a = (n >>> 24) & 0xff;
  const b = (n >>> 16) & 0xff;
  const g = (n >>> 8) & 0xff;
  const r = n & 0xff;
  const hex = (x: number) => x.toString(16).padStart(2, '0');
  return { color: `#${hex(r)}${hex(g)}${hex(b)}`, alpha: 1 - a / 255 };
}

const rgba = (c: { color: string; alpha: number }) => {
  if (c.alpha >= 1) return c.color;
  const r = parseInt(c.color.slice(1, 3), 16);
  const g = parseInt(c.color.slice(3, 5), 16);
  const b = parseInt(c.color.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${+c.alpha.toFixed(3)})`;
};

/** "0:01:02.34" → ms */
export function assTime(t: string): number {
  const m = t.trim().match(/^(\d+):(\d{1,2}):(\d{1,2})(?:[.:](\d{1,3}))?$/);
  if (!m) return NaN;
  const frac = m[4] ? Number(m[4].padEnd(2, '0').slice(0, 3)) * (m[4].length >= 3 ? 1 : 10) : 0;
  return ((Number(m[1]) * 60 + Number(m[2])) * 60 + Number(m[3])) * 1000 + frac;
}

/** Legacy SSA alignment (1-3 bottom, +4 top, +8 middle) → numpad. */
const ssaToAn = (a: number) => {
  const col = a & 3 || 2;
  if (a & 4) return 6 + col;
  if (a & 8) return 3 + col;
  return col;
};

const DEFAULT_STYLE: AssStyleLite = {
  name: 'Default', font: 'Arial', size: 20, primary: '#ffffff', secondary: '#ff0000', outlineColor: '#000000', back: 'rgba(0,0,0,0.5)',
  bold: false, italic: false, underline: false, strike: false, borderStyle: 1, outline: 2, shadow: 2, an: 2, marginL: 10, marginR: 10, marginV: 10,
  scaleX: 100, scaleY: 100, spacing: 0,
};

function parseStyle(fmt: string[], vals: string[], ssa: boolean): AssStyleLite {
  const get = (k: string) => {
    const i = fmt.indexOf(k.toLowerCase());
    return i >= 0 ? vals[i]?.trim() : undefined;
  };
  const num = (k: string, d: number) => {
    const v = Number(get(k));
    return Number.isFinite(v) ? v : d;
  };
  const flag = (k: string) => {
    const v = get(k);
    return v != null && v !== '0' && v !== '';
  };
  const prim = assColor(get('PrimaryColour'));
  const back = assColor(get('BackColour'), '#000000');
  const align = num('Alignment', 2);
  return {
    name: get('Name') ?? 'Default',
    font: get('Fontname') ?? 'Arial',
    size: num('Fontsize', 20),
    primary: rgba(prim),
    secondary: rgba(assColor(get('SecondaryColour'), '#ff0000')),
    outlineColor: rgba(assColor(get(ssa ? 'TertiaryColour' : 'OutlineColour'), '#000000')),
    back: rgba(back),
    bold: flag('Bold'),
    italic: flag('Italic'),
    underline: flag('Underline'),
    strike: flag('StrikeOut'),
    borderStyle: num('BorderStyle', 1),
    outline: num('Outline', 2),
    shadow: num('Shadow', 2),
    an: ssa ? ssaToAn(align) : align,
    marginL: num('MarginL', 10),
    marginR: num('MarginR', 10),
    marginV: num('MarginV', 10),
    scaleX: num('ScaleX', 100),
    scaleY: num('ScaleY', 100),
    spacing: num('Spacing', 0),
  };
}

/** Split a CSV line into at most `n` fields (the last field — Text — may contain commas). */
function splitFields(line: string, n: number): string[] {
  const out: string[] = [];
  let rest = line;
  for (let i = 0; i < n - 1; i++) {
    const c = rest.indexOf(',');
    if (c < 0) break;
    out.push(rest.slice(0, c));
    rest = rest.slice(c + 1);
  }
  out.push(rest);
  return out;
}

const tagArgs = (s: string) => {
  const m = s.match(/^\(([^)]*)\)?/);
  return m ? m[1].split(',').map((x) => x.trim()) : [];
};

interface RunState {
  i: boolean; b: boolean; u: boolean; s: boolean; color: string; secondary: string; outlineColor: string; font: string; size: number; outline: number; shadow: number; alpha: number;
}

function baseState(st: AssStyleLite): RunState {
  return { i: st.italic, b: st.bold, u: st.underline, s: st.strike, color: st.primary, secondary: st.secondary, outlineColor: st.outlineColor, font: st.font, size: st.size, outline: st.outline, shadow: st.shadow, alpha: 1 };
}

/** Parse one event's text into runs + layout overrides. */
export function parseAssText(text: string, style: AssStyleLite, styles: Map<string, AssStyleLite>): { runs: TextRun[]; layout: Partial<AssLayout> } {
  const runs: TextRun[] = [];
  const layout: Partial<AssLayout> = {};
  let st = baseState(style);
  let drawing = false;
  let kAt = 0; // karaoke clock (ms from event start)
  let pendingK: TextRun['karaoke'] | undefined;
  const re = /\{([^}]*)\}/g;
  let last = 0;
  const emit = (raw: string) => {
    if (!raw || drawing) return;
    const t = raw.replace(/\\h/g, ' ');
    const parts = t.split(/\\[Nn]/);
    parts.forEach((p, idx) => {
      if (idx > 0) runs.push({ text: '', br: true });
      if (!p) return;
      const run: TextRun = {
        text: p, i: st.i || undefined, b: st.b || undefined, u: st.u || undefined, s: st.s || undefined, color: st.color, font: st.font, size: st.size,
        outlineColor: st.outlineColor, outline: st.outline, shadow: st.shadow, ...(st.alpha < 1 ? { alpha: st.alpha } : {}),
      };
      if (pendingK) {
        run.karaoke = { ...pendingK, before: st.secondary };
        pendingK = undefined;
      }
      runs.push(run);
    });
  };
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    emit(text.slice(last, m.index));
    last = re.lastIndex;
    // Each override: backslash + name + args.
    const body = m[1];
    const tagRe = /\\(\d?[a-z]+)(\([^)]*\)?|[^\\]*)/gi;
    let t: RegExpExecArray | null;
    while ((t = tagRe.exec(body))) {
      const name = t[1].toLowerCase();
      const arg = t[2] ?? '';
      const a = arg.trim();
      switch (name) {
        case 'i': st.i = a === '1'; break;
        case 'b': st.b = a !== '0' && a !== ''; if (a === '') st.b = style.bold; break;
        case 'u': st.u = a === '1'; break;
        case 's': st.s = a === '1'; break;
        case 'c': case '1c': st.color = a ? rgba({ color: assColor(a).color, alpha: st.alpha }) : style.primary; break;
        case '2c': st.secondary = a ? assColor(a).color : style.secondary; break;
        case '3c': st.outlineColor = a ? assColor(a).color : style.outlineColor; break;
        case 'alpha': case '1a': {
          const v = parseInt(a.replace(/[&H]/gi, ''), 16);
          if (Number.isFinite(v)) st.alpha = 1 - v / 255;
          break;
        }
        case 'fn': st.font = a || style.font; break;
        case 'fs': { const v = Number(a); if (Number.isFinite(v) && v > 0) st.size = v; break; }
        case 'bord': { const v = Number(a); if (Number.isFinite(v)) st.outline = v; break; }
        case 'shad': { const v = Number(a); if (Number.isFinite(v)) st.shadow = v; break; }
        case 'an': { const v = Number(a); if (v >= 1 && v <= 9 && layout.an == null) layout.an = v; break; }
        case 'a': { const v = Number(a); if (v > 0 && layout.an == null) layout.an = ssaToAn(v); break; }
        case 'pos': {
          const [x, y] = tagArgs(arg).map(Number);
          if (Number.isFinite(x) && Number.isFinite(y) && !layout.pos) layout.pos = { x, y };
          break;
        }
        case 'move': {
          const v = tagArgs(arg).map(Number);
          if (v.length >= 4 && v.slice(0, 4).every(Number.isFinite) && !layout.move) {
            layout.move = { x1: v[0], y1: v[1], x2: v[2], y2: v[3], t1: v[4] || 0, t2: v[5] || 0 };
          }
          break;
        }
        case 'fad': {
          const [fi, fo] = tagArgs(arg).map(Number);
          if (Number.isFinite(fi) && Number.isFinite(fo)) layout.fade = { in: fi, out: fo };
          break;
        }
        case 'fade': {
          // \fade(a1,a2,a3,t1,t2,t3,t4): approximate as fade-in t1→t2, fade-out t3→t4.
          const v = tagArgs(arg).map(Number);
          if (v.length >= 7) layout.fade = { in: Math.max(0, v[4] - v[3]), out: Math.max(0, v[6] - v[5]) };
          break;
        }
        case 'k': case 'kf': case 'ko': {
          const cs = Number(a);
          if (Number.isFinite(cs)) {
            pendingK = { start: kAt, dur: cs * 10, kind: t[1] === 'K' ? 'kf' : (name as 'k' | 'kf' | 'ko'), before: st.secondary };
            kAt += cs * 10;
          }
          break;
        }
        case 'r': {
          const target = a ? styles.get(a) : undefined;
          st = baseState(target ?? style);
          break;
        }
        case 'p': drawing = Number(a) > 0; if (drawing) layout.unsupported = true; break;
        case 'clip': case 'iclip': layout.unsupported = true; break;
        default:
          break;
      }
    }
  }
  emit(text.slice(last));
  while (runs.length && runs[runs.length - 1].br) runs.pop();
  return { runs, layout };
}

export interface ParsedAss extends ParsedText {
  playRes: { x: number; y: number };
  styles: Map<string, AssStyleLite>;
  /** Font names the script uses (styles + \fn). */
  fonts: string[];
}

export function parseAss(src: string): ParsedAss {
  const lines = src.replace(/^﻿/, '').replace(/\r\n?/g, '\n').split('\n');
  let section = '';
  let styleFmt: string[] = [];
  let eventFmt: string[] = [];
  let ssa = false;
  const info: Record<string, string> = {};
  const styles = new Map<string, AssStyleLite>();
  const cues: TextCue[] = [];
  const fonts = new Set<string>();
  const pending: { start: number; end: number; layer: number; style: string; ml: number; mr: number; mv: number; text: string }[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith(';')) continue;
    const sec = line.match(/^\[(.+)\]$/);
    if (sec) {
      section = sec[1].toLowerCase();
      if (section === 'v4 styles') ssa = true;
      continue;
    }
    const c = line.indexOf(':');
    if (c < 0) continue;
    const key = line.slice(0, c).trim();
    const val = line.slice(c + 1).trim();
    if (section === 'script info') info[key.toLowerCase()] = val;
    else if (section.startsWith('v4')) {
      if (key === 'Format') styleFmt = val.split(',').map((x) => x.trim().toLowerCase());
      else if (key === 'Style') {
        const st = parseStyle(styleFmt, splitFields(val, styleFmt.length), ssa);
        styles.set(st.name, st);
        fonts.add(st.font);
      }
    } else if (section === 'events') {
      if (key === 'Format') eventFmt = val.split(',').map((x) => x.trim().toLowerCase());
      else if (key === 'Dialogue') {
        const f = splitFields(val, eventFmt.length || 10);
        const get = (k: string, d = '') => f[(eventFmt.length ? eventFmt : ['layer', 'start', 'end', 'style', 'name', 'marginl', 'marginr', 'marginv', 'effect', 'text']).indexOf(k)] ?? d;
        const layerRaw = get('layer', get('marked', '0'));
        pending.push({
          start: assTime(get('start')), end: assTime(get('end')), layer: Number(layerRaw.replace(/^Marked=/i, '')) || 0, style: get('style').replace(/^\*/, ''),
          ml: Number(get('marginl')) || 0, mr: Number(get('marginr')) || 0, mv: Number(get('marginv')) || 0, text: get('text'),
        });
      }
    }
  }
  const playRes = {
    x: Number(info.playresx) || (Number(info.playresy) ? Math.round((Number(info.playresy) * 4) / 3) : 384),
    y: Number(info.playresy) || (Number(info.playresx) ? Math.round((Number(info.playresx) * 3) / 4) : 288),
  };
  for (const e of pending) {
    if (!Number.isFinite(e.start) || !Number.isFinite(e.end) || e.end <= e.start) continue;
    const style = styles.get(e.style) ?? styles.get('Default') ?? DEFAULT_STYLE;
    const { runs, layout } = parseAssText(e.text, style, styles);
    for (const r of runs) if (r.font) fonts.add(r.font);
    if (!runs.some((r) => !r.br && r.text.trim())) continue;
    const ass: AssLayout = {
      an: layout.an ?? style.an,
      marginL: e.ml || style.marginL,
      marginR: e.mr || style.marginR,
      marginV: e.mv || style.marginV,
      style,
      layer: e.layer,
      ...(layout.pos ? { pos: layout.pos } : {}),
      ...(layout.move ? { move: layout.move } : {}),
      ...(layout.fade ? { fade: layout.fade } : {}),
      ...(layout.unsupported ? { unsupported: true } : {}),
    };
    cues.push({ start: e.start, end: e.end, runs, ass });
  }
  return { cues, playRes, styles, fonts: [...fonts] };
}

/** Position of an ASS event at time t (ms since its start) in script px, honouring \move. */
export function assPosition(l: AssLayout, t: number, dur: number): { x: number; y: number } | null {
  if (l.move) {
    const { x1, y1, x2, y2 } = l.move;
    let t1 = l.move.t1;
    let t2 = l.move.t2;
    if (!t1 && !t2) {
      t1 = 0;
      t2 = dur;
    }
    const k = t <= t1 ? 0 : t >= t2 ? 1 : (t - t1) / Math.max(1, t2 - t1);
    return { x: x1 + (x2 - x1) * k, y: y1 + (y2 - y1) * k };
  }
  return l.pos ?? null;
}

/** Opacity of an event at time t (ms since start) for \fad. */
export function assOpacity(l: AssLayout, t: number, dur: number): number {
  if (!l.fade) return 1;
  if (l.fade.in > 0 && t < l.fade.in) return Math.max(0, t / l.fade.in);
  if (l.fade.out > 0 && t > dur - l.fade.out) return Math.max(0, (dur - t) / l.fade.out);
  return 1;
}

/** Whether a cue changes appearance over time (needs per-frame updates). */
export const assAnimated = (c: TextCue) => !!c.ass && (!!c.ass.move || !!c.ass.fade || c.runs.some((r) => r.karaoke));
