/**
 * SRT and WebVTT parsers (our own: players never use the platform's text-track parser).
 * Supports WebVTT cue settings (vertical, line, position, size, align), inline tags (<i> <b> <u> <c.class> <v Speaker>
 * <lang> <ruby>), STYLE-block ::cue(.class) colours, and SRT's <font color>, {\anN} and stray ASS override tags.
 */
import type { Align, ParsedText, TextCue, TextRun, VttLayout } from './types';

/* ------------------------------ timestamps ------------------------------ */

/** "01:02:03.456", "02:03.456", "01:02:03,456" (SRT), "1:02:03.4" → ms; NaN when malformed. */
export function parseTimestamp(ts: string): number {
  const m = ts.trim().match(/^(?:(\d+):)?(\d{1,2}):(\d{1,2})(?:[.,](\d{1,3}))?$/);
  if (!m) return NaN;
  const h = m[1] ? Number(m[1]) : 0;
  const frac = m[4] ? Number(m[4].padEnd(3, '0')) : 0;
  return ((h * 60 + Number(m[2])) * 60 + Number(m[3])) * 1000 + frac;
}

/* ------------------------------ inline markup ------------------------------ */

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', lrm: '‎', rlm: '‏' };
export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, e: string) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : all;
    }
    return ENTITIES[e.toLowerCase()] ?? all;
  });
}

/** WebVTT default colour classes. */
export const VTT_COLORS: Record<string, string> = {
  white: '#ffffff', lime: '#00ff00', cyan: '#00ffff', red: '#ff0000', yellow: '#ffff00', magenta: '#ff00ff', blue: '#0000ff', black: '#000000',
};

type Style = Omit<TextRun, 'text' | 'br'>;

function pushText(runs: TextRun[], text: string, st: Style) {
  if (!text) return;
  const parts = text.split('\n');
  parts.forEach((p, i) => {
    if (i > 0) runs.push({ text: '', br: true });
    if (p) runs.push({ text: p, ...st });
  });
}

/**
 * Parse cue text with HTML-like tags into styled runs. `srt` also accepts <font color> and strips {\…} ASS overrides
 * (returning the last \anN seen, which SRT files use for top-positioned lines).
 */
export function parseMarkup(src: string, opts: { srt?: boolean } = {}): { runs: TextRun[]; an?: number } {
  let an: number | undefined;
  let text = src;
  if (opts.srt) {
    text = text.replace(/\{\\([^}]*)\}/g, (_m, body: string) => {
      const a = body.match(/\\?an([1-9])/);
      if (a) an = Number(a[1]);
      return '';
    });
  }
  const runs: TextRun[] = [];
  const stack: { tag: string; st: Style }[] = [];
  let st: Style = {};
  const re = /<\s*(\/?)\s*([a-z0-9]+)((?:\.[^\s>.]+)*)([^>]*)>|<\d[\d:.]*>/gi;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    pushText(runs, decodeEntities(text.slice(last, m.index)), st);
    last = re.lastIndex;
    if (!m[2]) continue; // timestamp tag
    const closing = !!m[1];
    const tag = m[2].toLowerCase();
    if (tag === 'br') {
      runs.push({ text: '', br: true });
      continue;
    }
    if (closing) {
      const i = stack.map((x) => x.tag).lastIndexOf(tag);
      if (i >= 0) {
        st = stack[i].st;
        stack.length = i;
      }
      continue;
    }
    const classes = m[3] ? m[3].split('.').filter(Boolean) : [];
    const annotation = m[4].trim();
    const next: Style = { ...st };
    if (tag === 'i') next.i = true;
    else if (tag === 'b') next.b = true;
    else if (tag === 'u') next.u = true;
    else if (tag === 's') next.s = true;
    else if (tag === 'v') next.voice = annotation || undefined;
    else if (tag === 'font') {
      const c = annotation.match(/color\s*=\s*["']?([^"'\s>]+)/i);
      if (c) next.color = /^[0-9a-f]{6}$/i.test(c[1]) ? `#${c[1]}` : c[1];
    } else if (tag === 'rt') {
      // Ruby text: shown after the base, smaller handling is left to CSS.
    } else if (!['c', 'lang', 'ruby', 'span'].includes(tag)) {
      // Unknown tag: keep the text, ignore the tag.
    }
    if (classes.length) {
      next.classes = [...(st.classes ?? []), ...classes];
      for (const c of classes) {
        if (VTT_COLORS[c]) next.color = VTT_COLORS[c];
        else if (c.startsWith('bg_') && VTT_COLORS[c.slice(3)]) next.background = VTT_COLORS[c.slice(3)];
      }
    }
    stack.push({ tag, st });
    st = next;
  }
  pushText(runs, decodeEntities(text.slice(last)), st);
  // Trim leading/trailing breaks.
  while (runs.length && runs[0].br) runs.shift();
  while (runs.length && runs[runs.length - 1].br) runs.pop();
  return { runs, an };
}

/* ---------------------------------- SRT ---------------------------------- */

const TIMING = /^\s*(\S+)\s*-->\s*(\S+)(.*)$/;

/** Blank-line separated blocks (whitespace-only lines count as blank), each without leading blank lines. */
function splitBlocks(text: string): string[] {
  return text.split(/\n(?:[ \t]*\n)+/).map((b) => b.replace(/^(?:[ \t]*\n)+/, ''));
}

export function parseSrt(src: string): ParsedText {
  const cues: TextCue[] = [];
  const text = src.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  for (const block of splitBlocks(text)) {
    const lines = block.split('\n');
    const ti = lines.findIndex((l) => l.includes('-->'));
    if (ti < 0 || ti > 1) continue;
    const t = lines[ti].match(TIMING);
    if (!t) continue;
    const start = parseTimestamp(t[1]);
    const end = parseTimestamp(t[2]);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
    const body = lines.slice(ti + 1).join('\n').replace(/\s+$/, '');
    if (!body.trim()) continue;
    const { runs, an } = parseMarkup(body, { srt: true });
    if (!runs.length) continue;
    const cue: TextCue = { id: ti === 1 ? lines[0].trim() : undefined, start, end, runs };
    if (an) cue.vtt = anToVtt(an);
    cues.push(cue);
  }
  return { cues };
}

/** SRT {\anN} → equivalent WebVTT layout. */
function anToVtt(an: number): VttLayout {
  const row = an >= 7 ? 'top' : an >= 4 ? 'middle' : 'bottom';
  const col = an % 3 === 1 ? 'left' : an % 3 === 0 ? 'right' : 'center';
  const l: VttLayout = {};
  if (row === 'top') {
    l.line = 0;
    l.snapToLines = true;
  } else if (row === 'middle') {
    l.line = 50;
    l.snapToLines = false;
    l.lineAlign = 'center';
  }
  if (col !== 'center') l.align = col;
  return l;
}

/* --------------------------------- WebVTT --------------------------------- */

function parseSettings(s: string): VttLayout {
  const l: VttLayout = {};
  for (const tok of s.trim().split(/\s+/)) {
    const i = tok.indexOf(':');
    if (i <= 0) continue;
    const k = tok.slice(0, i);
    const v = tok.slice(i + 1);
    if (k === 'vertical' && (v === 'rl' || v === 'lr')) l.vertical = v;
    else if (k === 'line') {
      const [val, al] = v.split(',');
      if (/%$/.test(val)) {
        const n = parseFloat(val);
        if (Number.isFinite(n)) {
          l.line = n;
          l.snapToLines = false;
        }
      } else if (/^-?\d+(\.\d+)?$/.test(val)) {
        l.line = parseFloat(val);
        l.snapToLines = true;
      }
      if (al === 'start' || al === 'center' || al === 'end') l.lineAlign = al;
    } else if (k === 'position') {
      const [val, al] = v.split(',');
      const n = parseFloat(val);
      if (Number.isFinite(n)) l.position = n;
      if (al === 'line-left' || al === 'center' || al === 'line-right') l.positionAlign = al;
    } else if (k === 'size') {
      const n = parseFloat(v);
      if (Number.isFinite(n)) l.size = n;
    } else if (k === 'align' && ['start', 'center', 'end', 'left', 'right', 'middle'].includes(v)) {
      l.align = (v === 'middle' ? 'center' : v) as Align;
    } else if (k === 'region') l.region = v;
  }
  return l;
}

/** ::cue(.class) { color; background-color; font-style; font-weight; text-decoration } from STYLE blocks. */
function parseStyleBlock(css: string, out: NonNullable<ParsedText['classStyles']>) {
  const re = /::cue\(\s*\.([\w-]+)\s*\)\s*\{([^}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(css))) {
    const decl: Record<string, string> = {};
    for (const d of m[2].split(';')) {
      const i = d.indexOf(':');
      if (i > 0) decl[d.slice(0, i).trim().toLowerCase()] = d.slice(i + 1).trim();
    }
    const st: NonNullable<ParsedText['classStyles']>[string] = { ...(out[m[1]] ?? {}) };
    if (decl.color) st.color = decl.color;
    if (decl['background-color'] || decl.background) st.background = decl['background-color'] ?? decl.background;
    if (decl['font-style'] === 'italic') st.i = true;
    if (decl['font-weight'] && /bold|[6-9]00/.test(decl['font-weight'])) st.b = true;
    if (decl['text-decoration']?.includes('underline')) st.u = true;
    out[m[1]] = st;
  }
}

export function parseVtt(src: string): ParsedText {
  const text = src.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const blocks = splitBlocks(text);
  const cues: TextCue[] = [];
  const classStyles: NonNullable<ParsedText['classStyles']> = {};
  blocks.forEach((block, bi) => {
    if (bi === 0 && /^WEBVTT/.test(block)) {
      // Header may be followed directly by a cue in sloppy files.
      const rest = block.split('\n').slice(1).join('\n');
      if (!rest.includes('-->')) return;
      block = rest;
    }
    if (/^NOTE(\s|$)/.test(block) || /^REGION(\s|$)/.test(block)) return;
    if (/^STYLE(\s|$)/.test(block)) {
      parseStyleBlock(block.slice(5), classStyles);
      return;
    }
    const lines = block.split('\n');
    const ti = lines.findIndex((l) => l.includes('-->'));
    if (ti < 0 || ti > 1) return;
    const t = lines[ti].match(TIMING);
    if (!t) return;
    const start = parseTimestamp(t[1]);
    const end = parseTimestamp(t[2]);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return;
    const body = lines.slice(ti + 1).join('\n');
    const { runs } = parseMarkup(body);
    if (!runs.length) return;
    const layout = parseSettings(t[3] ?? '');
    cues.push({ id: ti === 1 ? lines[0].trim() : undefined, start, end, runs, ...(Object.keys(layout).length ? { vtt: layout } : {}) });
  });
  return { cues, ...(Object.keys(classStyles).length ? { classStyles } : {}) };
}

/** Sniff the format of a text subtitle file. */
export function sniffTextFormat(src: string): 'vtt' | 'ass' | 'srt' {
  const head = src.replace(/^﻿/, '').slice(0, 2000);
  if (/^WEBVTT/.test(head)) return 'vtt';
  if (/^\s*\[Script Info\]/i.test(head) || /\n\[Events\]/i.test(head)) return 'ass';
  return 'srt';
}
