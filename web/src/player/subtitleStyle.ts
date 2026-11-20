import { useEffect, type CSSProperties } from 'react';
import type { SubtitleStyle } from '@mediamax/shared';

export const DEFAULT_SUBTITLE_STYLE: SubtitleStyle = { size: 'medium', color: 'white', background: 'shadow', font: 'default', position: 'bottom' };

export function subtitleStyleOf(s: Partial<SubtitleStyle> | null | undefined): SubtitleStyle {
  return { ...DEFAULT_SUBTITLE_STYLE, ...(s ?? {}) };
}

export const SUBTITLE_OPTIONS: { [K in keyof SubtitleStyle]-?: { value: SubtitleStyle[K]; label: string }[] } = {
  size: [
    { value: 'small', label: 'Small' },
    { value: 'medium', label: 'Medium' },
    { value: 'large', label: 'Large' },
    { value: 'xlarge', label: 'Extra large' },
  ],
  color: [
    { value: 'white', label: 'White' },
    { value: 'yellow', label: 'Yellow' },
    { value: 'cyan', label: 'Cyan' },
    { value: 'green', label: 'Green' },
  ],
  background: [
    { value: 'none', label: 'None' },
    { value: 'shadow', label: 'Drop shadow' },
    { value: 'box', label: 'Translucent box' },
    { value: 'boxSolid', label: 'Solid box' },
  ],
  font: [
    { value: 'default', label: 'Default' },
    { value: 'serif', label: 'Serif' },
    { value: 'mono', label: 'Monospace' },
    { value: 'rounded', label: 'Rounded' },
  ],
  position: [
    { value: 'bottom', label: 'Bottom' },
    { value: 'raised', label: 'Raised' },
  ],
  verticalOffset: [
    { value: undefined, label: 'Auto' },
    { value: 5, label: '5%' },
    { value: 10, label: '10%' },
    { value: 15, label: '15%' },
    { value: 20, label: '20%' },
  ],
  edge: [
    { value: 'outline', label: 'Outline' },
    { value: 'shadow', label: 'Drop shadow' },
    { value: 'none', label: 'None' },
  ],
  assStyles: [
    { value: 'auto', label: 'Auto' },
    { value: 'file', label: "Always the file's styles" },
    { value: 'user', label: 'My style' },
  ],
};

export const SUBTITLE_FIELD_LABELS: Record<keyof SubtitleStyle, string> = {
  size: 'Size', color: 'Colour', background: 'Background', font: 'Font', position: 'Position',
  verticalOffset: 'Lift from bottom', edge: 'Text edge', assStyles: 'ASS/SSA styling',
};

const SCALE: Record<SubtitleStyle['size'], number> = { small: 0.75, medium: 1, large: 1.3, xlarge: 1.65 };
const COLORS: Record<SubtitleStyle['color'], string> = { white: '#ffffff', yellow: '#ffe94d', cyan: '#5ff2ff', green: '#6dff7a' };
const FONTS: Record<SubtitleStyle['font'], string> = {
  default: 'var(--font, system-ui, sans-serif)',
  serif: 'Georgia, "Times New Roman", Times, serif',
  mono: 'ui-monospace, "SFMono-Regular", Menlo, Consolas, "Liberation Mono", monospace',
  rounded: 'ui-rounded, "SF Pro Rounded", "Nunito", "Varela Round", "Arial Rounded MT Bold", system-ui, sans-serif',
};
const OUTLINE = '0 0 2px #000, 0 0 2px #000, 1px 1px 2px #000, -1px -1px 2px #000, 1px -1px 2px #000, -1px 1px 2px #000';

/**
 * CSS declarations for a subtitle style. `base` is the medium font size (a CSS length);
 * the player uses a viewport-relative size, the settings preview a fixed one.
 */
export function subtitleDeclarations(s: SubtitleStyle, base = 'clamp(16px, 2.6vw, 34px)'): Record<string, string> {
  const bg = s.background === 'box' ? 'rgb(0 0 0 / 0.62)' : s.background === 'boxSolid' ? 'rgb(0 0 0 / 1)' : 'transparent';
  const edge = s.edge ?? 'outline';
  const shadow = s.background === 'shadow'
    ? edge === 'outline' ? OUTLINE : edge === 'shadow' ? '2px 2px 3px rgb(0 0 0 / 0.9)' : 'none'
    : s.background === 'none' ? 'none' : '0 1px 2px rgb(0 0 0 / 0.6)';
  return {
    'font-size': `calc(${base} * ${SCALE[s.size]})`,
    color: COLORS[s.color],
    'background-color': bg,
    'text-shadow': shadow,
    'font-family': FONTS[s.font],
    'line-height': '1.3',
    'font-weight': s.font === 'mono' ? '500' : '600',
  };
}

function toCssText(decl: Record<string, string>) {
  return Object.entries(decl).map(([k, v]) => `${k}: ${v};`).join(' ');
}

/** React inline style (camelCased) for the settings preview. */
export function subtitlePreviewStyle(s: SubtitleStyle, basePx: number): CSSProperties {
  const d = subtitleDeclarations(s, `${basePx}px`);
  return {
    fontSize: d['font-size'], color: d.color, backgroundColor: d['background-color'], textShadow: d['text-shadow'],
    fontFamily: d['font-family'], lineHeight: d['line-height'], fontWeight: Number(d['font-weight']),
  };
}

/** Class that every player <video> carries so the user's subtitle style reaches its `::cue`s. */
export const SUBTITLE_CLASS = 'mm-subs';

/** Inject (and keep updated) a stylesheet styling `video.mm-subs::cue` with the user's subtitle style. */
export function useSubtitleStyleSheet(style: SubtitleStyle) {
  const key = JSON.stringify(style);
  useEffect(() => {
    let el = document.getElementById('mm-subtitle-style') as HTMLStyleElement | null;
    if (!el) {
      el = document.createElement('style');
      el.id = 'mm-subtitle-style';
      document.head.appendChild(el);
    }
    el.textContent = `video.${SUBTITLE_CLASS}::cue { ${toCssText(subtitleDeclarations(style))} }`;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
}

/** Lines from the bottom for the "raised" position (WebVTT negative line numbers count from the bottom). */
const RAISED_LINE = -4;
const origLine = new WeakMap<VTTCue, VTTCue['line']>();

/** Apply the vertical position to every cue of a track (cues that set their own line are left alone). */
export function positionCues(track: TextTrack, position: SubtitleStyle['position']) {
  positionCueList(track.cues, position);
}

/** Same for a list of cues (e.g. a live caption track's `activeCues`). */
export function positionCueList(cues: TextTrackCueList | null, position: SubtitleStyle['position']) {
  if (!cues) return;
  for (const c of Array.from(cues)) {
    if (typeof VTTCue === 'undefined' || !(c instanceof VTTCue)) continue;
    if (!origLine.has(c)) origLine.set(c, c.line);
    const orig = origLine.get(c)!;
    if (orig !== 'auto') continue;
    const want = position === 'raised' ? RAISED_LINE : 'auto';
    if (c.line !== want) {
      c.snapToLines = true;
      c.line = want;
    }
  }
}
