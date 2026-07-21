import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from 'react';

type ToastType = 'success' | 'error' | 'info';

interface ToastItem {
  id: number;
  title: string;
  message?: string;
  type: ToastType;
  closing: boolean;
}

type ShowToastFn = (title: string, message?: string, type?: ToastType, durationMs?: number) => void;

const ToastContext = createContext<ShowToastFn | null>(null);

const TOAST_ICON: Record<ToastType, string> = {
  success: 'fas fa-check-circle',
  error: 'fas fa-times-circle',
  info: 'fas fa-info-circle',
};

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const nextId = useRef(0);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((id: number) => {
    setToasts((current) => current.map((t) => (t.id === id ? { ...t, closing: true } : t)));
    setTimeout(() => setToasts((current) => current.filter((t) => t.id !== id)), 250);
  }, []);

  const arm = useCallback(
    (id: number, duration: number) => {
      const timer = setTimeout(() => dismiss(id), duration);
      timers.current.set(id, timer);
    },
    [dismiss],
  );

  const showToast = useCallback<ShowToastFn>(
    (title, message, type = 'success', durationMs) => {
      const id = nextId.current++;
      const duration = durationMs ?? Math.min(9000, Math.max(4000, String(message || '').length * 60));
      setToasts((current) => [...current, { id, title, message, type, closing: false }]);
      arm(id, duration);
    },
    [arm],
  );

  return (
    <ToastContext.Provider value={showToast}>
      {children}
      <div className="toast-viewport" aria-live="polite">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={`toast ${t.type} show${t.closing ? ' hide' : ''}`}
            onMouseEnter={() => {
              const timer = timers.current.get(t.id);
              if (timer) clearTimeout(timer);
            }}
            onMouseLeave={() => arm(t.id, 4000)}
          >
            <span className="toast-icon">
              <i className={TOAST_ICON[t.type]}></i>
            </span>
            <div className="toast-body">
              <div className="toast-title">{t.title}</div>
              {t.message && <div className="toast-message">{t.message}</div>}
            </div>
            <button className="toast-close" aria-label="ปิด" onClick={() => dismiss(t.id)}>
              <i className="fas fa-xmark"></i>
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ShowToastFn {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used within a ToastProvider');
  return ctx;
}
