import { useApp } from '../state/app';
import { Img } from './ui';

export function BrandMark({ size = 32 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" className="brand-mark" aria-hidden>
      <defs>
        <linearGradient id="mmg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="var(--c-primary)" />
          <stop offset="1" stopColor="var(--c-accent)" />
        </linearGradient>
      </defs>
      <rect width="32" height="32" rx="9" fill="url(#mmg)" />
      <path d="M8 22V10l5 6 3-3.5L19 16l5-6v12" fill="none" stroke="var(--c-primary-text)" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function BrandLogo({ wide = true, height = 32, className }: { wide?: boolean; height?: number; className?: string }) {
  const { branding } = useApp();
  const url = (wide ? branding.logoWideUrl ?? branding.logoUrl : branding.logoUrl ?? branding.logoWideUrl) ?? null;
  const text = (
    <span className="brand-text-wrap">
      <BrandMark size={height} />
      {wide && <span className="brand-text">{branding.serverName}</span>}
    </span>
  );
  return (
    <span className={`brand-logo ${className ?? ''}`} style={{ height }}>
      {url ? <Img src={url} alt={branding.serverName} style={{ height, width: 'auto' }} fallback={text} /> : text}
    </span>
  );
}
