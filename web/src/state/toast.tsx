import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { errorMessage } from '../api/client';
import { Icon } from '../components/Icon';

type Kind = 'info' | 'success' | 'error';
interface Toast {
  id: number;
  kind: Kind;
  message: string;
}
interface ToastApi {
  show: (message: string, kind?: Kind, ms?: number) => void;
  success: (message: string) => void;
  error: (e: unknown) => void;
}

const Ctx = createContext<ToastApi>({ show: () => {}, success: () => {}, error: () => {} });

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const seq = useRef(0);
  const dismiss = useCallback((id: number) => setToasts((t) => t.filter((x) => x.id !== id)), []);
  const show = useCallback(
    (message: string, kind: Kind = 'info', ms?: number) => {
      const id = ++seq.current;
      setToasts((t) => [...t.filter((x) => x.message !== message).slice(-3), { id, kind, message }]);
      window.setTimeout(() => dismiss(id), ms ?? (kind === 'error' ? 6000 : 3500));
    },
    [dismiss],
  );
  // Code outside React (TV mode's "Press Back again to exit") raises toasts with a `mm:toast` window event.
  useEffect(() => {
    const on = (e: Event) => {
      const d = (e as CustomEvent<{ message?: string; kind?: Kind; ms?: number }>).detail;
      if (d?.message) show(d.message, d.kind ?? 'info', d.ms);
    };
    window.addEventListener('mm:toast', on);
    return () => window.removeEventListener('mm:toast', on);
  }, [show]);
  const api = useMemo<ToastApi>(
    () => ({ show, success: (m) => show(m, 'success'), error: (e) => show(errorMessage(e), 'error') }),
    [show],
  );
  return (
    <Ctx.Provider value={api}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast toast-${t.kind}`} onClick={() => dismiss(t.id)}>
            <Icon name={t.kind === 'error' ? 'alert' : t.kind === 'success' ? 'check' : 'info'} size={18} />
            <span>{t.message}</span>
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}

export const useToast = () => useContext(Ctx);
