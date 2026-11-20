import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';
import { errorMessage } from '../api/client';
import { Icon } from '../components/Icon';

type Kind = 'info' | 'success' | 'error';
interface Toast {
  id: number;
  kind: Kind;
  message: string;
}
interface ToastApi {
  show: (message: string, kind?: Kind) => void;
  success: (message: string) => void;
  error: (e: unknown) => void;
}

const Ctx = createContext<ToastApi>({ show: () => {}, success: () => {}, error: () => {} });

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const seq = useRef(0);
  const dismiss = useCallback((id: number) => setToasts((t) => t.filter((x) => x.id !== id)), []);
  const show = useCallback(
    (message: string, kind: Kind = 'info') => {
      const id = ++seq.current;
      setToasts((t) => [...t.filter((x) => x.message !== message).slice(-3), { id, kind, message }]);
      window.setTimeout(() => dismiss(id), kind === 'error' ? 6000 : 3500);
    },
    [dismiss],
  );
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
