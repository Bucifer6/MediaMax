import { useId } from 'react';
import { useApp } from '../state/app';
import { Img } from './ui';
import { MARK_ASPECT, MARK_FULL, MARK_SIMPLE, MARK_VIEWBOX, NAME, NAME_GRADIENT } from '../brand/art';

/**
 * The MediaMax mark (folded-ribbon "M" with a play button), inlined so it is crisp at any size.
 * `size` is the height; below 28 px the simplified two-tone version is used.
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
 * "MediaMax" set in Plus Jakarta Sans ExtraBold, as outlines (no web font needed). "Media" follows the
 * theme's text colour; "Max" uses the brand gradient, deeper on light themes so it reads on white.
 * `cap` is the cap height in px.
 */
export function BrandName({ cap, mode }: { cap: number; mode: 'dark' | 'light' }) {
  const id = `n${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const top = NAME.cap * 1.06;
  const h = top + NAME.cap * 0.05;
  const stops = NAME_GRADIENT[mode];
  const maxX = NAME.glyphs[5].x;
  return (
    <svg className="brand-name" height={Math.round((cap * h) / NAME.cap)} width={Math.round((cap * NAME.width) / NAME.cap)} viewBox={`0 ${-top} ${NAME.width} ${h}`} aria-hidden>
      <defs>
        <linearGradient id={id} gradientUnits="userSpaceOnUse" x1={maxX} y1={-NAME.cap} x2={NAME.width} y2={0}>
          {stops.map((c, i) => <stop key={c} offset={i / (stops.length - 1)} stopColor={c} />)}
        </linearGradient>
      </defs>
      {NAME.glyphs.map((g, i) => (
        <path key={i} d={g.d} fill={i < 5 ? 'var(--c-text)' : `url(#${id})`} />
      ))}
    </svg>
  );
}

/**
 * The server's logo: an uploaded logo (Branding Studio) wins; otherwise the MediaMax mark plus the
 * outlined wordmark, or the mark plus the server name in the theme font when the server has been renamed.
 */
export function BrandLogo({ wide = true, height = 32, className }: { wide?: boolean; height?: number; className?: string }) {
  const { branding, theme } = useApp();
  const url = (wide ? branding.logoWideUrl ?? branding.logoUrl : branding.logoUrl ?? branding.logoWideUrl) ?? null;
  const stock = !branding.serverName || branding.serverName === 'MediaMax';
  const text = (
    <span className="brand-text-wrap" aria-label={branding.serverName || 'MediaMax'} role="img">
      <BrandMark size={height} />
      {wide && (stock ? <BrandName cap={Math.round(height * 0.5)} mode={theme.mode} /> : <span className="brand-text">{branding.serverName}</span>)}
    </span>
  );
  return (
    <span className={`brand-logo ${className ?? ''}`} style={{ height }}>
      {url ? <Img src={url} alt={branding.serverName} style={{ height, width: 'auto' }} fallback={text} /> : text}
    </span>
  );
}
