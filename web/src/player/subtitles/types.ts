/**
 * Cue model shared by the SRT / WebVTT / ASS-fallback parsers and the DOM text renderer.
 * Pure data: nothing here touches the DOM, so the parsers run under node:test (web/test/).
 */

/** A run of text with inline styling. `br` runs are line breaks. */
export interface TextRun {
  text: string;
  br?: boolean;
  i?: boolean;
  b?: boolean;
  u?: boolean;
  s?: boolean;
  /** CSS colour (WebVTT class colour, SRT <font color>, ASS \c). */
  color?: string;
  /** CSS background colour (WebVTT bg_* classes). */
  background?: string;
  /** WebVTT classes (`<c.foo.bar>`), for STYLE-block rules. */
  classes?: string[];
  /** WebVTT voice (`<v Name>`). */
  voice?: string;
  /** ASS overrides. */
  font?: string;
  /** Font size in script pixels (ASS \fs), scaled by the renderer. */
  size?: number;
  outlineColor?: string;
  /** Outline width in script pixels (ASS \bord). */
  outline?: number;
  shadow?: number;
  alpha?: number;
  /** ASS karaoke: syllable start / duration relative to the cue start (ms), and fill colour before it is sung. */
  karaoke?: { start: number; dur: number; kind: 'k' | 'kf' | 'ko'; before: string };
}

export type Align = 'start' | 'center' | 'end' | 'left' | 'right';

/** WebVTT cue settings (positions in %), see https://www.w3.org/TR/webvtt1/#webvtt-cue-settings */
export interface VttLayout {
  vertical?: 'rl' | 'lr';
  /** Line number (snapToLines) or percentage. */
  line?: number;
  snapToLines?: boolean;
  lineAlign?: 'start' | 'center' | 'end';
  position?: number;
  positionAlign?: 'line-left' | 'center' | 'line-right';
  size?: number;
  align?: Align;
  region?: string;
}

/** ASS layout resolved for one event (script coordinates). */
export interface AssLayout {
  /** Numpad alignment 1–9. */
  an: number;
  marginL: number;
  marginR: number;
  marginV: number;
  /** \pos or \move start (script px). */
  pos?: { x: number; y: number };
  move?: { x1: number; y1: number; x2: number; y2: number; t1: number; t2: number };
  /** \fad(in,out) ms, or \fade complex (simplified to in/out). */
  fade?: { in: number; out: number };
  /** Base style. */
  style: AssStyleLite;
  layer: number;
  /** Drawing mode / clip etc. present: the fallback can't draw it. */
  unsupported?: boolean;
}

export interface AssStyleLite {
  name: string;
  font: string;
  size: number;
  primary: string;
  secondary: string;
  outlineColor: string;
  back: string;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
  /** 1 = outline + shadow, 3 = opaque box. */
  borderStyle: number;
  outline: number;
  shadow: number;
  an: number;
  marginL: number;
  marginR: number;
  marginV: number;
  scaleX: number;
  scaleY: number;
  spacing: number;
}

export interface TextCue {
  id?: string;
  /** Media time, ms. */
  start: number;
  end: number;
  runs: TextRun[];
  vtt?: VttLayout;
  ass?: AssLayout;
}

export interface ParsedText {
  cues: TextCue[];
  /** WebVTT STYLE blocks: class → CSS colour/background/font-style (subset). */
  classStyles?: Record<string, Partial<Pick<TextRun, 'color' | 'background' | 'i' | 'b' | 'u'>>>;
  /** ASS script resolution (PlayResX/Y). */
  playRes?: { x: number; y: number };
  /** ASS: WrapStyle etc. could go here. */
}

/** Plain text of a cue (accessibility / native fallback). */
export function cueText(c: TextCue): string {
  return c.runs.map((r) => (r.br ? '\n' : r.text)).join('');
}
