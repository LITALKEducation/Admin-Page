import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';

interface ConfirmOptions {
  title?: string;
  okLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
}

type ConfirmFn = (message: string, opts?: ConfirmOptions) => Promise<boolean>;

const ConfirmContext = createContext<ConfirmFn | null>(null);

interface PendingConfirm extends Required<ConfirmOptions> {
  message: string;
  resolve: (value: boolean) => void;
  closing: boolean;
}

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<PendingConfirm | null>(null);

  const confirmDialog = useCallback<ConfirmFn>((message, opts = {}) => {
    return new Promise<boolean>((resolve) => {
      setPending({
        message,
        title: opts.title ?? 'ยืนยันการทำรายการ',
        okLabel: opts.okLabel ?? 'ยืนยัน',
        cancelLabel: opts.cancelLabel ?? 'ยกเลิก',
        danger: opts.danger ?? false,
        resolve,
        closing: false,
      });
    });
  }, []);

  const settle = (value: boolean) => {
    if (!pending) return;
    pending.resolve(value);
    setPending({ ...pending, closing: true });
    setTimeout(() => setPending(null), 150);
  };

  return (
    <ConfirmContext.Provider value={confirmDialog}>
      {children}
      {pending && (
        <div
          className={`modal-overlay${pending.closing ? ' is-closing' : ' active'}`}
          onKeyDown={(e) => {
            if (e.key === 'Escape') settle(false);
          }}
        >
          <div className="modal-box">
            <div className={`modal-icon ${pending.danger ? 'error' : 'info'}`}>
              <i className={pending.danger ? 'fas fa-triangle-exclamation' : 'fas fa-circle-question'}></i>
            </div>
            <h3 className="modal-title">{pending.title}</h3>
            <div className="modal-message" style={{ whiteSpace: 'pre-line' }}>
              {pending.message}
            </div>
            <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
              <button className="btn btn-secondary" style={{ flex: 1 }} onClick={() => settle(false)}>
                {pending.cancelLabel}
              </button>
              <button
                className={pending.danger ? 'btn btn-danger' : 'btn btn-primary'}
                style={{ flex: 1 }}
                onClick={() => settle(true)}
                autoFocus
              >
                {pending.okLabel}
              </button>
            </div>
          </div>
        </div>
      )}
    </ConfirmContext.Provider>
  );
}

export function useConfirm(): ConfirmFn {
  const ctx = useContext(ConfirmContext);
  if (!ctx) throw new Error('useConfirm must be used within a ConfirmProvider');
  return ctx;
}
