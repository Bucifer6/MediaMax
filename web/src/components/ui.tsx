import {
  createContext, forwardRef, useCallback, useContext, useEffect, useId, useLayoutEffect, useRef, useState,
  type ButtonHTMLAttributes, type CSSProperties, type InputHTMLAttributes, type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router-dom';
import type { MediaSource } from '@mediamax/shared';
import { mediaUrl } from '../api/client';
import { hashColor, initials } from '../utils/format';
import { Icon, type IconName } from './Icon';

/* ---------------- Image with lazy fade-in + fallback ---------------- */
export function Img({
  src, width, alt = '', className, fallback, style,
}: { src: string | null | undefined; width?: number; alt?: string; className?: string; fallback?: ReactNode; style?: CSSProperties }) {
  const [state, setState] = useState<'loading' | 'ok' | 'error'>(src ? 'loading' : 'error');
  // Reset only when the source really changes. (A reset in an effect also ran on mount, after a cached image had
  // already fired `load`, and left it invisible at opacity 0 for good: the custom logo after signing in.)
  const [shown, setShown] = useState(src);
  if (shown !== src) {
    setShown(src);
    setState(src ? 'loading' : 'error');
  }
  // An image that is already decoded (memory cache) may have loaded before React saw it.
  const ref = useCallback((el: HTMLImageElement | null) => {
    if (el?.complete && el.naturalWidth > 0) setState('ok');
  }, []);
  if (!src || state === 'error') return <div className={`img-fallback ${className ?? ''}`} style={style}>{fallback}</div>;
  return (
    <img
      ref={ref}
      src={mediaUrl(src, width)}
      alt={alt}
      loading="lazy"
      decoding="async"
      draggable={false}
      className={`img ${state === 'ok' ? 'img-loaded' : ''} ${className ?? ''}`}
      style={style}
      onLoad={() => setState('ok')}
      onError={() => setState('error')}
    />
  );
}

export function Spinner({ size = 28 }: { size?: number }) {
  return <span className="spinner" style={{ width: size, height: size }} aria-label="Loading" />;
}

export function PageLoader() {
  return (
    <div className="page-loader">
      <Spinner size={40} />
    </div>
  );
}

export function Skeleton({ w, h, r, className, style }: { w?: number | string; h?: number | string; r?: number | string; className?: string; style?: CSSProperties }) {
  return <div className={`skeleton ${className ?? ''}`} style={{ width: w, height: h, borderRadius: r, ...style }} />;
}

export function EmptyState({ icon = 'sparkles', title, message, action, compact }: { icon?: IconName; title: string; message?: ReactNode; action?: ReactNode; compact?: boolean }) {
  return (
    <div className={`empty-state ${compact ? 'compact' : ''}`}>
      <div className="empty-icon">
        <Icon name={icon} size={34} />
      </div>
      <h3>{title}</h3>
      {message && <p>{message}</p>}
      {action && <div className="empty-action">{action}</div>}
    </div>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <EmptyState
      icon="alert"
      title="Something went wrong"
      message={message}
      action={onRetry && (
        <button className="btn" onClick={onRetry}>
          <Icon name="refresh" size={16} /> Try again
        </button>
      )}
    />
  );
}

export function ProgressBar({ value, className, size, label }: { value: number; className?: string; size?: 'md' | 'lg'; label?: string }) {
  const v = Math.round(Math.max(0, Math.min(100, value)));
  return (
    <div className={`progress ${size === 'lg' ? 'progress-lg' : ''} ${className ?? ''}`} role={label ? 'progressbar' : undefined} aria-label={label} aria-valuenow={label ? v : undefined} aria-valuemin={label ? 0 : undefined} aria-valuemax={label ? 100 : undefined}>
      <div className="progress-fill" style={{ width: `${Math.max(0, Math.min(100, value))}%` }} />
    </div>
  );
}

export function Avatar({ name, url, size = 36 }: { name: string; url?: string | null; size?: number }) {
  return (
    <span className="avatar" style={{ width: size, height: size, fontSize: size * 0.4, background: url ? undefined : hashColor(name) }}>
      {url ? <Img src={url} width={size} alt={name} fallback={initials(name)} /> : initials(name) || '?'}
    </span>
  );
}

/** Avatar with upload / remove controls. `onUpload` / `onRemove` should persist and may throw. */
export function AvatarEditor({
  name, url, size = 80, onUpload, onRemove, disabled,
}: { name: string; url?: string | null; size?: number; onUpload: (file: File) => Promise<void>; onRemove: () => Promise<void>; disabled?: boolean }) {
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="avatar-editor">
      <button type="button" className="avatar-editor-pic" onClick={() => input.current?.click()} disabled={disabled || busy} title="Change picture">
        <Avatar name={name} url={url} size={size} />
        <span className="avatar-editor-overlay">{busy ? <Spinner size={20} /> : <Icon name="upload" size={20} />}</span>
      </button>
      <div className="avatar-editor-actions">
        <button type="button" className="btn btn-sm" onClick={() => input.current?.click()} disabled={disabled || busy}>
          <Icon name="upload" size={14} /> {url ? 'Change picture' : 'Upload picture'}
        </button>
        {url && (
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => void run(onRemove).catch(() => undefined)} disabled={disabled || busy}>
            <Icon name="trash" size={14} /> Remove
          </button>
        )}
      </div>
      <input
        ref={input}
        type="file"
        accept="image/*"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (f) void run(() => onUpload(f)).catch(() => undefined);
        }}
      />
    </div>
  );
}

export function Switch({ checked, onChange, label, disabled, hint }: { checked: boolean; onChange: (v: boolean) => void; label?: ReactNode; disabled?: boolean; hint?: ReactNode }) {
  return (
    <label className={`switch-row ${disabled ? 'disabled' : ''}`}>
      <span className="switch-text">
        {label && <span>{label}</span>}
        {hint && <small>{hint}</small>}
      </span>
      <input type="checkbox" className="switch" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
    </label>
  );
}

export function Field({ label, hint, children, className }: { label: ReactNode; hint?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <label className={`field ${className ?? ''}`}>
      <span className="field-label">{label}</span>
      {children}
      {hint && <small className="field-hint">{hint}</small>}
    </label>
  );
}

/* ---------------- Modal ---------------- */
export function Modal({
  open, onClose, title, children, footer, size = 'md', className, container, variant = 'dialog', ariaLabel,
}: {
  open: boolean; onClose: () => void; title?: ReactNode; children: ReactNode; footer?: ReactNode; size?: 'sm' | 'md' | 'lg' | 'xl'; className?: string;
  /** Accessible name when the dialog has no visible `title` (the title heading labels it otherwise). */
  ariaLabel?: string;
  /** dialog (centred; a bottom sheet on phones) or sheet (docked to the right edge). */
  variant?: 'dialog' | 'sheet';
  /** Portal target (defaults to document.body) — e.g. the fullscreen player element. */
  container?: Element | null;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onCloseRef.current();
      } else if (e.key === 'Tab' && ref.current) {
        // Keep keyboard focus inside the dialog (the page behind is inert for the user); only the top-most one traps.
        const all = document.querySelectorAll('.modal');
        if (all[all.length - 1] !== ref.current) return;
        const els = [...ref.current.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')]
          .filter((el) => el.offsetParent !== null || el === document.activeElement);
        if (!els.length) return;
        const first = els[0];
        const last = els[els.length - 1];
        const inside = ref.current.contains(document.activeElement);
        if (e.shiftKey && (document.activeElement === first || !inside)) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && (document.activeElement === last || !inside)) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener('keydown', key, true);
    window.setTimeout(() => {
      const el = ref.current?.querySelector<HTMLElement>('[autofocus], input, select, textarea, button:not(.modal-close)');
      (el ?? ref.current)?.focus();
    }, 20);
    document.body.classList.add('modal-open');
    return () => {
      window.removeEventListener('keydown', key, true);
      document.body.classList.remove('modal-open');
      prev?.focus?.();
    };
  }, [open]);
  if (!open) return null;
  return createPortal(
    <div className={`modal-backdrop ${variant === 'sheet' ? 'is-sheet' : ''}`} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal modal-${size} ${variant === 'sheet' ? 'modal-sheet' : ''} ${className ?? ''}`} ref={ref} role="dialog" aria-modal="true" aria-labelledby={title !== undefined ? titleId : undefined} aria-label={title === undefined ? ariaLabel : undefined} tabIndex={-1}>
        {title !== undefined && (
          <div className="modal-head">
            <h2 id={titleId}>{title}</h2>
            <button className="btn-icon modal-close" onClick={onClose} aria-label="Close">
              <Icon name="x" />
            </button>
          </div>
        )}
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>,
    container ?? document.body,
  );
}

/* ---------------- Dropdown menu ---------------- */
export interface MenuItem {
  label: ReactNode;
  icon?: IconName;
  onClick?: () => void;
  danger?: boolean;
  checked?: boolean;
  disabled?: boolean;
  divider?: boolean;
}

export function Dropdown({ trigger, items, align = 'right', className }: { trigger: (p: { onClick: () => void; open: boolean }) => ReactNode; items: MenuItem[]; align?: 'left' | 'right'; className?: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const [up, setUp] = useState(false);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', esc);
    };
  }, [open]);
  useLayoutEffect(() => {
    if (!open || !ref.current) return;
    const r = ref.current.getBoundingClientRect();
    setUp(window.innerHeight - r.bottom < 260 && r.top > 260);
    ref.current.querySelector<HTMLElement>('.menu button')?.focus();
  }, [open]);
  return (
    <div className={`dropdown ${className ?? ''}`} ref={ref}>
      {trigger({ onClick: () => setOpen((o) => !o), open })}
      {open && (
        <div className={`menu menu-${align} ${up ? 'menu-up' : ''}`} role="menu">
          {items.map((it, i) =>
            it.divider ? (
              <div key={i} className="menu-divider" />
            ) : (
              <button
                key={i}
                role="menuitem"
                className={`menu-item ${it.danger ? 'danger' : ''}`}
                disabled={it.disabled}
                onClick={() => {
                  setOpen(false);
                  it.onClick?.();
                }}
              >
                {it.icon ? <Icon name={it.icon} size={16} /> : it.checked !== undefined ? <span className="menu-check">{it.checked && <Icon name="check" size={16} />}</span> : null}
                <span>{it.label}</span>
              </button>
            ),
          )}
        </div>
      )}
    </div>
  );
}

/* ---------------- Confirm dialog ---------------- */
interface ConfirmOpts {
  title: string;
  message?: ReactNode;
  confirmLabel?: string;
  danger?: boolean;
}
const ConfirmCtx = createContext<(o: ConfirmOpts) => Promise<boolean>>(async () => false);

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<(ConfirmOpts & { resolve: (v: boolean) => void }) | null>(null);
  const confirm = useCallback((o: ConfirmOpts) => new Promise<boolean>((resolve) => setState({ ...o, resolve })), []);
  const done = (v: boolean) => {
    state?.resolve(v);
    setState(null);
  };
  return (
    <ConfirmCtx.Provider value={confirm}>
      {children}
      <Modal
        open={!!state}
        onClose={() => done(false)}
        title={state?.title ?? ''}
        size="sm"
        footer={
          <>
            <button className="btn btn-ghost" onClick={() => done(false)}>Cancel</button>
            <button className={`btn ${state?.danger ? 'btn-danger' : 'btn-primary'}`} onClick={() => done(true)} autoFocus>
              {state?.confirmLabel ?? 'Confirm'}
            </button>
          </>
        }
      >
        {state?.message && <p className="muted">{state.message}</p>}
      </Modal>
    </ConfirmCtx.Provider>
  );
}

export const useConfirm = () => useContext(ConfirmCtx);

/* ---------------- Tabs ---------------- */
export function Tabs<T extends string>({ value, onChange, tabs, className, variant = 'underline' }: { value: T; onChange: (v: T) => void; tabs: { value: T; label: ReactNode }[]; className?: string; variant?: 'underline' | 'pills' }) {
  return (
    <div className={`tabs ${variant === 'pills' ? 'pills' : ''} ${className ?? ''}`} role="tablist">
      {tabs.map((t) => (
        <button key={t.value} role="tab" aria-selected={t.value === value} className={`tab ${t.value === value ? 'active' : ''}`} onClick={() => onChange(t.value)}>
          {t.label}
        </button>
      ))}
    </div>
  );
}

export type BadgeTone = 'primary' | 'success' | 'warning' | 'danger' | 'accent' | 'muted' | 'outline' | 'quality' | 'new' | 'live';

export function Badge({ children, tone, className, title }: { children: ReactNode; tone?: BadgeTone; className?: string; title?: string }) {
  return <span className={`badge ${tone ? 'badge-' + tone : ''} ${className ?? ''}`} title={title}>{children}</span>;
}

/** Quality tags derived from an item's media: 4K, HDR / DV, Atmos. Empty when nothing notable (or no media info). */
export function qualityTags(media: MediaSource[] | null | undefined): { label: string; title: string }[] {
  const m = media?.[0];
  if (!m) return [];
  const tags: { label: string; title: string }[] = [];
  const h = m.height ?? 0;
  const w = m.width ?? 0;
  if (m.resolutionLabel === '4K' || h >= 2000 || w >= 3800) tags.push({ label: '4K', title: 'Ultra HD 4K' });
  const range = m.videoRange?.hdrFormat;
  if (range === 'dolbyvision') tags.push({ label: 'DV', title: 'Dolby Vision' });
  else if (m.hdr || (range && range !== 'sdr')) tags.push({ label: 'HDR', title: 'High dynamic range' });
  if (m.audioStreams?.some((a) => a.atmos || /atmos/i.test(`${a.title ?? ''} ${a.profile ?? ''}`))) tags.push({ label: 'ATMOS', title: 'Dolby Atmos' });
  return tags;
}

/** 4K / HDR / DV / ATMOS badges for an item's media (renders nothing without media info). */
export function QualityBadges({ media, className }: { media: MediaSource[] | null | undefined; className?: string }) {
  const tags = qualityTags(media);
  if (!tags.length) return null;
  return (
    <span className={`badge-row ${className ?? ''}`}>
      {tags.map((t) => <Badge key={t.label} tone="quality" title={t.title}>{t.label}</Badge>)}
    </span>
  );
}

/** "LIVE" pill with a pulsing dot. */
export function LiveBadge({ small }: { small?: boolean }) {
  return <span className={`live-pill ${small ? 'small' : ''}`}><span className="live-dot" /> LIVE</span>;
}

/* ---------------- Buttons ---------------- */
export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'glass' | 'danger' | 'play';
export type ButtonSize = 'xs' | 'sm' | 'md' | 'lg';

type ButtonOwnProps = {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Leading icon. */
  icon?: IconName;
  /** Trailing icon. */
  iconRight?: IconName;
  block?: boolean;
  /** Shows a spinner and disables the button. */
  loading?: boolean;
  /** Render as a router link instead of a button. */
  to?: string;
};

export function buttonClass({ variant = 'secondary', size = 'md', block }: Pick<ButtonOwnProps, 'variant' | 'size' | 'block'> = {}): string {
  return ['btn', variant !== 'secondary' && `btn-${variant}`, size !== 'md' && `btn-${size}`, block && 'btn-block'].filter(Boolean).join(' ');
}

/**
 * The Vibe button. `<Button variant="primary" icon="play">Play</Button>`; `to` renders a router link with the same look.
 * Plain `className="btn btn-primary"` markup is equivalent and still fine.
 */
export const Button = forwardRef<HTMLButtonElement, ButtonOwnProps & ButtonHTMLAttributes<HTMLButtonElement>>(function Button(
  { variant, size, icon, iconRight, block, loading, to, className, children, disabled, type = 'button', ...rest },
  ref,
) {
  const cls = `${buttonClass({ variant, size, block })} ${className ?? ''}`;
  const iconSize = size === 'lg' ? 20 : size === 'sm' || size === 'xs' ? 14 : 16;
  const inner = (
    <>
      {loading ? <Spinner size={iconSize} /> : icon ? <Icon name={icon} size={iconSize} /> : null}
      {children}
      {iconRight && <Icon name={iconRight} size={iconSize} />}
    </>
  );
  if (to) return <Link to={to} className={cls} aria-disabled={disabled || undefined} data-nav>{inner}</Link>;
  return (
    <button ref={ref} type={type} className={cls} disabled={disabled || loading} aria-busy={loading || undefined} {...rest}>
      {inner}
    </button>
  );
});

/** Round icon-only button. `label` is required (it becomes aria-label and the tooltip). */
export const IconButton = forwardRef<HTMLButtonElement, { icon: IconName; label: string; size?: 'sm' | 'md' | 'lg'; filled?: boolean; active?: boolean; iconSize?: number } & Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'>>(
  function IconButton({ icon, label, size = 'md', filled, active, iconSize, className, type = 'button', title, ...rest }, ref) {
    const cls = ['btn-icon', size !== 'md' && `btn-icon-${size}`, filled && 'filled', active && 'active', className].filter(Boolean).join(' ');
    return (
      <button ref={ref} type={type} className={cls} aria-label={label} title={title ?? label} aria-pressed={active === undefined ? undefined : active} {...rest}>
        <Icon name={icon} size={iconSize ?? (size === 'lg' ? 22 : size === 'sm' ? 16 : 20)} />
      </button>
    );
  },
);

/* ---------------- Inputs ---------------- */
/** Text input with an optional leading icon. Pass any <input> props. */
export const Input = forwardRef<HTMLInputElement, { icon?: IconName; inputSize?: 'sm' | 'md' | 'lg' } & InputHTMLAttributes<HTMLInputElement>>(function Input(
  { icon, inputSize = 'md', className, ...rest },
  ref,
) {
  const input = <input ref={ref} className={`input ${inputSize !== 'md' ? `input-${inputSize}` : ''} ${className ?? ''}`} {...rest} />;
  if (!icon) return input;
  return (
    <span className="input-wrap">
      <Icon name={icon} size={16} />
      {input}
    </span>
  );
});

/** Filter / toggle chip. `active` marks it pressed; `onRemove` adds an × (for applied filters). */
export function Chip({ children, active, onClick, icon, onRemove, size, className, title }: { children: ReactNode; active?: boolean; onClick?: () => void; icon?: IconName; onRemove?: () => void; size?: 'sm' | 'md'; className?: string; title?: string }) {
  return (
    <button type="button" className={`chip ${size === 'sm' ? 'chip-sm' : ''} ${active ? 'active' : ''} ${className ?? ''}`} aria-pressed={active === undefined ? undefined : active} onClick={onRemove && !onClick ? onRemove : onClick} title={title}>
      {icon && <Icon name={icon} size={14} />}
      {children}
      {onRemove && <Icon name="x" size={14} className="chip-x" />}
    </button>
  );
}

/** Segmented control: one of a few options (view mode, density…). An `iconOnly` option shows just its icon; its
 *  label stays as the accessible name (visually hidden) and as the hover tooltip unless `title` says otherwise. */
export function Segmented<T extends string>({ value, onChange, options, label, className }: { value: T; onChange: (v: T) => void; options: { value: T; label: ReactNode; icon?: IconName; title?: string; iconOnly?: boolean }[]; label: string; className?: string }) {
  return (
    <div className={`segmented ${className ?? ''}`} role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          className={`${o.value === value ? 'active' : ''} ${o.iconOnly && o.icon ? 'seg-icon' : ''}`.trim() || undefined}
          onClick={() => onChange(o.value)}
          title={o.title ?? (o.iconOnly && typeof o.label === 'string' ? o.label : undefined)}
        >
          {o.icon && <Icon name={o.icon} size={15} />}
          {o.iconOnly && o.icon ? <span className="sr-only">{o.label}</span> : o.label}
        </button>
      ))}
    </div>
  );
}

/* ---------------- Popover ---------------- */
/** A small anchored panel (filters, quick settings). Closes on outside click and Esc. */
export function Popover({ trigger, children, align = 'right', className, label }: { trigger: (p: { onClick: () => void; open: boolean }) => ReactNode; children: ReactNode | ((close: () => void) => ReactNode); align?: 'left' | 'right'; className?: string; label?: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', esc, true);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', esc, true);
    };
  }, [open]);
  const close = () => setOpen(false);
  return (
    <div className={`dropdown ${className ?? ''}`} ref={ref}>
      {trigger({ onClick: () => setOpen((o) => !o), open })}
      {open && (
        <div className={`popover-panel align-${align}`} role="dialog" aria-label={label}>
          {typeof children === 'function' ? children(close) : children}
        </div>
      )}
    </div>
  );
}

/* ---------------- Page & section headers ---------------- */
/** Page title with optional eyebrow / subtitle / icon and right-aligned actions. Use once at the top of a page. */
export function PageHeader({ title, subtitle, eyebrow, icon, actions, children, className }: { title: ReactNode; subtitle?: ReactNode; eyebrow?: ReactNode; icon?: IconName; actions?: ReactNode; children?: ReactNode; className?: string }) {
  return (
    <header className={`page-header ${className ?? ''}`}>
      <div className="page-header-text">
        {eyebrow && <span className="page-header-eyebrow">{eyebrow}</span>}
        <h1 className="page-header-title">{icon && <Icon name={icon} size={26} />}{title}</h1>
        {subtitle && <p className="page-header-sub">{subtitle}</p>}
        {children}
      </div>
      {actions && <div className="page-header-actions">{actions}</div>}
    </header>
  );
}

/** Section title with an optional "See all" link and actions. `flush` drops the page gutter (inside padded pages). */
export function SectionHeader({ title, subtitle, link, linkLabel = 'See all', actions, flush, as: Tag = 'h2', id }: { title: ReactNode; subtitle?: ReactNode; link?: string; linkLabel?: string; actions?: ReactNode; flush?: boolean; as?: 'h2' | 'h3'; id?: string }) {
  return (
    <div className={`section-header ${flush ? 'flush' : ''}`}>
      <Tag className="section-header-title" id={id}>{title}</Tag>
      {subtitle && <span className="section-header-sub">{subtitle}</span>}
      {(actions || link) && (
        <div className="section-header-actions">
          {actions}
          {link && (
            <Link to={link} className="see-all" data-nav>
              {linkLabel} <Icon name="chevronRight" size={16} />
            </Link>
          )}
        </div>
      )}
    </div>
  );
}

export function StarRating({ value, onChange, size = 22 }: { value: number | null; onChange?: (v: number | null) => void; size?: number }) {
  const [hover, setHover] = useState<number | null>(null);
  const shown = hover ?? value ?? 0;
  return (
    <div className="stars" onMouseLeave={() => setHover(null)}>
      {[1, 2, 3, 4, 5].map((i) => {
        const filled = shown >= i * 2 - 0.5;
        return (
          <button
            key={i}
            type="button"
            className={`star ${filled ? 'filled' : ''}`}
            onMouseEnter={() => onChange && setHover(i * 2)}
            onClick={() => onChange?.(value === i * 2 ? null : i * 2)}
            aria-label={`${i} star${i > 1 ? 's' : ''}`}
            disabled={!onChange}
          >
            <Icon name={filled ? 'starFill' : 'star'} size={size} />
          </button>
        );
      })}
    </div>
  );
}
