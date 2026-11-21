import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { useApp } from '../state/app';
import { fitToTheme, hex, mix, parseColor, tintFrom, useAmbientState, type Palette, type Rgb, type ThemeTone } from '../theme/ambient';

type Slot = { id: number; style: CSSProperties } | null;

/**
 * The page's light field: soft drifting glows behind the glass surfaces, coloured by the featured artwork
 * (theme/ambient.ts) and cross-faded when it changes. With no artwork it glows in the theme's own primary/accent.
 * Also publishes --art-tint / --art-tint-text (a readable button colour from the artwork) on <html>.
 */
export function AmbientLight() {
  const { theme } = useApp();
  const { palette, key } = useAmbientState();
  const tone = useMemo<ThemeTone>(() => {
    const c = theme.colors;
    const mode = theme.mode === 'light' ? 'light' : 'dark';
    return {
      mode,
      bg: parseColor(c.background) ?? [10, 15, 34],
      text: parseColor(c.text) ?? [242, 245, 255],
      muted: parseColor(c.textMuted) ?? [154, 166, 204],
    };
  }, [theme]);
  const themePalette = useMemo<Palette>(() => {
    const p = parseColor(theme.colors.primary) ?? [31, 182, 245];
    const a = parseColor(theme.colors.accent) ?? [224, 64, 240];
    return [p, a, mix(p, a, 0.5)];
  }, [theme]);

  const [slots, setSlots] = useState<[Slot, Slot]>([null, null]);
  const [active, setActive] = useState(0);
  const first = useRef(true);

  useEffect(() => {
    const fitted = fitToTheme(palette ?? themePalette, tone);
    const strength = palette ? 1 : 0.8;
    const style = {
      '--a1': hex(fitted[0]),
      '--a2': hex(fitted[1]),
      '--a3': hex(fitted[2]),
      '--a-strength': String(strength),
    } as CSSProperties;
    if (first.current) {
      first.current = false;
      setSlots([{ id: key, style }, { id: key, style }]);
      setActive(0);
    } else {
      const next = active === 0 ? 1 : 0;
      setSlots((s) => {
        const copy: [Slot, Slot] = [s[0], s[1]];
        copy[next] = { id: key, style };
        return copy;
      });
      setActive(next);
    }
    // Artwork-tinted button colour for the detail page / hero (falls back to the theme primary in CSS).
    const root = document.documentElement.style;
    const tint = palette && theme.id !== 'contrast' ? tintFrom(palette) : null;
    if (tint) {
      root.setProperty('--art-tint', hex(tint.bg));
      root.setProperty('--art-tint-text', hex(tint.fg as Rgb));
    } else {
      root.removeProperty('--art-tint');
      root.removeProperty('--art-tint-text');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, tone, themePalette]);

  return (
    <div className="ambient" aria-hidden="true">
      {/* Two fixed slots: the incoming colours are written into the hidden one, which then fades in over the other. */}
      {slots.map((s, i) => s && <div key={i} className={`ambient-layer ${i === active ? 'on' : ''}`} style={s.style} />)}
      <div className="ambient-veil" />
    </div>
  );
}
