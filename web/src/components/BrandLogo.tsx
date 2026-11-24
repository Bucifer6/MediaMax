import { useId } from 'react';
import { useApp } from '../state/app';
import { Img } from './ui';
import { LEGACY_PRODUCT_NAMES, PRODUCT_NAME } from '../brand/product';
import { BRAND_GRADIENT, MARK_ASPECT, MARK_FULL, MARK_SIMPLE, MARK_VIEWBOX, NAME } from '../brand/art';

/** The generated mark with its gradient stops bound to the skin's --brand-g1..3 (stock colours as fallback). */
const skinned = (art: string) =>
  BRAND_GRADIENT.reduce((a, c, i) => a.replaceAll(`stop-color="${c}"`, `style="stop-color:var(--brand-g${i + 1},${c})"`), art);
const SKINNED_FULL = skinned(MARK_FULL);
const SKINNED_SIMPLE = skinned(MARK_SIMPLE);

/**
 * The Vibe mark (the Lens: a disc in the brand gradient with a V-shaped hole), inlined so it is crisp at any size.
 * `size` is the height; below 28 px the simplified version (a heavier V that stays open at 16 px) is used.
 */
export function BrandMark({ size = 32, simple }: { size?: number; simple?: boolean }) {
  const id = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const art = (simple ?? size < 28) ? SKINNED_SIMPLE : SKINNED_FULL;
  return (
    <svg
      width={Math.round(size * MARK_ASPECT)}
      height={size}
      viewBox={MARK_VIEWBOX}
      className="brand-mark"
      aria-hidden
      dangerouslySetInnerHTML={{ __html: art.replaceAll('{id}', `m${id}`) }}
    />
  );
}

/**
 * "vibe" set in Outfit Bold, as outlines (no web font needed). The letters follow the theme's text colour, so the
 * same art works on dark and light themes. `cap` is the height of the tallest letters (b, i) in px; `mode` is
 * accepted for compatibility and no longer changes the art.
 */
export function BrandName({ cap }: { cap: number; mode?: 'dark' | 'light' }) {
  const top = NAME.top * 1.02;
  const h = top + NAME.top * 0.03; // room for the round letters' overshoot below the baseline
  return (
    <svg className="brand-name" height={Math.round((cap * h) / NAME.top)} width={Math.round((cap * NAME.width) / NAME.top)} viewBox={`0 ${-top} ${NAME.width} ${h}`} aria-hidden>
      <path d={NAME.glyphs.map((g) => g.d).join('')} fill="var(--c-text, var(--text, currentColor))" />
    </svg>
  );
}

/** True when the server still uses the stock product name, or a former one (so the outlined Vibe wordmark is shown). */
export function isStockName(serverName: string | null | undefined): boolean {
  return !serverName || serverName === PRODUCT_NAME || LEGACY_PRODUCT_NAMES.includes(serverName);
}

/**
 * The server's logo: an uploaded logo (Branding Studio) wins; otherwise the Vibe mark plus the
 * outlined wordmark, or the mark plus the server name in the theme font when the server has been renamed.
 */
export function BrandLogo({ wide = true, height = 32, className }: { wide?: boolean; height?: number; className?: string }) {
  const { branding } = useApp();
  const url = (wide ? branding.logoWideUrl ?? branding.logoUrl : branding.logoUrl ?? branding.logoWideUrl) ?? null;
  const stock = isStockName(branding.serverName);
  const label = stock ? PRODUCT_NAME : branding.serverName;
  const text = (
    <span className="brand-text-wrap" aria-label={label} role="img">
      <BrandMark size={height} />
      {wide && (stock ? <BrandName cap={Math.round(height * 0.68)} /> : <span className="brand-text">{branding.serverName}</span>)}
    </span>
  );
  return (
    <span className={`brand-logo ${className ?? ''}`} style={{ height }}>
      {url ? <Img src={url} alt={label} style={{ height, width: 'auto' }} fallback={text} /> : text}
    </span>
  );
}
