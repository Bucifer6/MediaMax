import { useId } from 'react';
import { useApp } from '../state/app';
import { Img } from './ui';
import { LEGACY_PRODUCT_NAME, PRODUCT_NAME } from '../brand/product';
import { MARK_ASPECT, MARK_FULL, MARK_SIMPLE, MARK_VIEWBOX, NAME, NAME_GRADIENT } from '../brand/art';

/**
 * The Kinora mark (a K whose arms are two beams of projector light), inlined so it is crisp at any size.
 * `size` is the height; below 28 px the simplified flat version is used.
 */
export function BrandMark({ size = 32, simple }: { size?: number; simple?: boolean }) {
  const id = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const art = (simple ?? size < 28) ? MARK_SIMPLE : MARK_FULL;
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
 * "Kinora" set in Bricolage Grotesque ExtraBold, as outlines (no web font needed). The letters follow the theme's
 * text colour; the tittle of the "i" is lit in the beam colours, deeper on light themes so it reads on white.
 * `cap` is the cap height in px.
 */
export function BrandName({ cap, mode }: { cap: number; mode: 'dark' | 'light' }) {
  const id = `n${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const top = NAME.top * 1.03;
  const h = top + NAME.cap * 0.05;
  const stops = NAME_GRADIENT[mode];
  const dot = NAME.glyphs.find((g): g is (typeof g & { dot: string }) => 'dot' in g);
  const dx = dot?.x ?? 0;
  return (
    <svg className="brand-name" height={Math.round((cap * h) / NAME.cap)} width={Math.round((cap * NAME.width) / NAME.cap)} viewBox={`0 ${-top} ${NAME.width} ${h}`} aria-hidden>
      <defs>
        <linearGradient id={id} gradientUnits="userSpaceOnUse" x1={dx} y1={-NAME.top} x2={dx + NAME.cap * 0.35} y2={-NAME.cap * 0.8}>
          {stops.map((c, i) => <stop key={c} offset={i / (stops.length - 1)} stopColor={c} />)}
        </linearGradient>
      </defs>
      {NAME.glyphs.map((g, i) => (
        <path key={i} d={g.d} fill="var(--c-text)" />
      ))}
      {dot && <path d={dot.dot} fill={`url(#${id})`} />}
    </svg>
  );
}

/** True when the server still uses the stock product name (so the outlined wordmark is shown). */
export function isStockName(serverName: string | null | undefined): boolean {
  return !serverName || serverName === PRODUCT_NAME || serverName === LEGACY_PRODUCT_NAME;
}

/**
 * The server's logo: an uploaded logo (Branding Studio) wins; otherwise the Kinora mark plus the
 * outlined wordmark, or the mark plus the server name in the theme font when the server has been renamed.
 */
export function BrandLogo({ wide = true, height = 32, className }: { wide?: boolean; height?: number; className?: string }) {
  const { branding, theme } = useApp();
  const url = (wide ? branding.logoWideUrl ?? branding.logoUrl : branding.logoUrl ?? branding.logoWideUrl) ?? null;
  const stock = isStockName(branding.serverName);
  const label = stock ? PRODUCT_NAME : branding.serverName;
  const text = (
    <span className="brand-text-wrap" aria-label={label} role="img">
      <BrandMark size={height} />
      {wide && (stock ? <BrandName cap={Math.round(height * 0.5)} mode={theme.mode} /> : <span className="brand-text">{branding.serverName}</span>)}
    </span>
  );
  return (
    <span className={`brand-logo ${className ?? ''}`} style={{ height }}>
      {url ? <Img src={url} alt={label} style={{ height, width: 'auto' }} fallback={text} /> : text}
    </span>
  );
}
