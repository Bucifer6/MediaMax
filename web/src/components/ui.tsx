import {
  createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState,
  type CSSProperties, type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { mediaUrl } from '../api/client';
import { hashColor, initials } from '../utils/format';
import { Icon, type IconName } from './Icon';

/* ---------------- Image with lazy fade-in + fallback ---------------- */
export function Img({
  src, width, alt = '', className, fallback, style,
}: { src: string | null | undefined; width?: number; alt?: string; className?: string; fallback?: ReactNode; style?: CSSProperties }) {
  const [state, setState] = useState<'loading' | 'ok' | 'error'>(src ? 'loading' : 'error');
  useEffect(() => setState(src ? 'loading' : 'error'), [src]);
  if (!src || state === 'error') return <div className={`img-fallback ${className ?? ''}`} style={style}>{fallback}</div>;
  return (
    <img
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

export function EmptyState({ icon = 'sparkles', title, message, action }: { icon?: IconName; title: string; message?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty-state">
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

export function ProgressBar({ value, className }: { value: number; className?: string }) {
  return (
    <div className={`progress ${className ?? ''}`}>
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
  open, onClose, title, children, footer, size = 'md', className,
}: { open: boolean; onClose: () => void; title?: ReactNode; children: ReactNode; footer?: ReactNode; size?: 'sm' | 'md' | 'lg' | 'xl'; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onCloseRef.current();
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
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal modal-${size} ${className ?? ''}`} ref={ref} role="dialog" aria-modal="true" tabIndex={-1}>
        {title !== undefined && (
          <div className="modal-head">
            <h2>{title}</h2>
            <button className="btn-icon modal-close" onClick={onClose} aria-label="Close">
              <Icon name="x" />
            </button>
          </div>
        )}
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>,
    document.body,
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
export function Tabs<T extends string>({ value, onChange, tabs, className }: { value: T; onChange: (v: T) => void; tabs: { value: T; label: ReactNode }[]; className?: string }) {
  return (
    <div className={`tabs ${className ?? ''}`} role="tablist">
      {tabs.map((t) => (
        <button key={t.value} role="tab" aria-selected={t.value === value} className={`tab ${t.value === value ? 'active' : ''}`} onClick={() => onChange(t.value)}>
          {t.label}
        </button>
      ))}
    </div>
  );
}

export function Badge({ children, tone, className }: { children: ReactNode; tone?: 'primary' | 'success' | 'warning' | 'danger' | 'accent' | 'muted'; className?: string }) {
  return <span className={`badge ${tone ? 'badge-' + tone : ''} ${className ?? ''}`}>{children}</span>;
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
