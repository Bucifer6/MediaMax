import type { CSSProperties } from 'react';
import type { SubtitleStyle } from '@mediamax/shared';

export const DEFAULT_SUBTITLE_STYLE: SubtitleStyle = { size: 'medium', color: 'white', background: 'shadow', font: 'default', position: 'bottom', verticalOffset: 0, edge: 'outline', assStyles: 'auto' };

/** The free-form style fields (unset = the preset look). */
export const SUBTITLE_FREE_FIELDS = [
  'fontScale', 'textColor', 'backgroundColor', 'backgroundOpacity', 'outlineColor', 'outlineWidth', 'shadowOpacity', 'shadowBlur', 'cornerRadius', 'bold',
] as const;

/** "Reset to default": the preset defaults, with every free-form field cleared (the server clears a field sent as null). */
export const RESET_SUBTITLE_STYLE = {
  ...DEFAULT_SUBTITLE_STYLE, ...Object.fromEntries(SUBTITLE_FREE_FIELDS.map((k) => [k, null])),
} as unknown as SubtitleStyle;

export function subtitleStyleOf(s: Partial<SubtitleStyle> | null | undefined): SubtitleStyle {
  return { ...DEFAULT_SUBTITLE_STYLE, ...(s ?? {}) };
}

/** The style fields picked from a list (the free-form ones — scale, colours, outline… — have their own controls). */
export type SubtitlePresetField = 'size' | 'color' | 'background' | 'font' | 'position' | 'verticalOffset' | 'edge' | 'assStyles';

export const SUBTITLE_OPTIONS: { [K in SubtitlePresetField]-?: { value: SubtitleStyle[K]; label: string }[] } = {
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
    { value: 0, label: 'Auto' },
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

export const SUBTITLE_FIELD_LABELS: Record<SubtitlePresetField, string> = {
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
    'font-size': `calc(${base} * ${s.fontScale ? s.fontScale / 100 : SCALE[s.size]})`,
    color: s.textColor ?? COLORS[s.color],
    'background-color': s.backgroundColor && bg !== 'transparent' ? hexAlpha(s.backgroundColor, s.backgroundOpacity ?? (s.background === 'box' ? 62 : 100)) : bg,
    'text-shadow': s.outlineColor && shadow === OUTLINE ? OUTLINE.replaceAll('#000', s.outlineColor) : shadow,
    'font-family': FONTS[s.font],
    'line-height': '1.3',
    'font-weight': s.bold === false ? '400' : s.font === 'mono' ? '500' : '600',
    'border-radius': s.cornerRadius && bg !== 'transparent' ? `${s.cornerRadius}px` : '0',
  };
}

function hexAlpha(hex: string, opacity: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgb(${(n >> 16) & 255} ${(n >> 8) & 255} ${n & 255} / ${opacity / 100})`;
}

/** React inline style (camelCased) for the settings preview. */
export function subtitlePreviewStyle(s: SubtitleStyle, basePx: number): CSSProperties {
  const d = subtitleDeclarations(s, `${basePx}px`);
  return {
    fontSize: d['font-size'], color: d.color, backgroundColor: d['background-color'], textShadow: d['text-shadow'],
    fontFamily: d['font-family'], lineHeight: d['line-height'], fontWeight: Number(d['font-weight']), borderRadius: d['border-radius'],
  };
}

/** Class that every player <video> carries so the user's subtitle style reaches its `::cue`s. */
export const SUBTITLE_CLASS = 'mm-subs';

/** Lines from the bottom for the "raised" position (WebVTT negative line numbers count from the bottom). */
const RAISED_LINE = -4;
const origLine = new WeakMap<VTTCue, VTTCue['line']>();

/** Apply the vertical position to a list of cues (cues that set their own line are left alone), e.g. a live caption track's `activeCues`. */
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
