import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from 'react';

interface ConfirmOptions {
  title?: string;
  okLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
}

interface PromptOptions {
  title?: string;
  defaultValue?: string;
  placeholder?: string;
  okLabel?: string;
  cancelLabel?: string;
}

type ConfirmFn = (message: string, opts?: ConfirmOptions) => Promise<boolean>;
type PromptFn = (message: string, opts?: PromptOptions) => Promise<string | null>;

const ConfirmContext = createContext<ConfirmFn | null>(null);
const PromptContext = createContext<PromptFn | null>(null);

interface Pending {
  kind: 'confirm' | 'prompt';
  message: string;
  title: string;
  okLabel: string;
  cancelLabel: string;
  danger: boolean;
  defaultValue?: string;
  placeholder?: string;
  resolve: (value: boolean | string | null) => void;
  closing: boolean;
}

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<Pending | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const confirmDialog = useCallback<ConfirmFn>((message, opts = {}) => {
    return new Promise<boolean>((resolve) => {
      setPending({
        kind: 'confirm',
        message,
        title: opts.title ?? 'ยืนยันการทำรายการ',
        okLabel: opts.okLabel ?? 'ยืนยัน',
        cancelLabel: opts.cancelLabel ?? 'ยกเลิก',
        danger: opts.danger ?? false,
        resolve: resolve as (value: boolean | string | null) => void,
        closing: false,
      });
    });
  }, []);

  const promptDialog = useCallback<PromptFn>((message, opts = {}) => {
    return new Promise<string | null>((resolve) => {
      setPending({
        kind: 'prompt',
        message,
        title: opts.title ?? 'กรอกข้อมูล',
        okLabel: opts.okLabel ?? 'ตกลง',
        cancelLabel: opts.cancelLabel ?? 'ยกเลิก',
        danger: false,
        defaultValue: opts.defaultValue ?? '',
        placeholder: opts.placeholder ?? '',
        resolve: resolve as (value: boolean | string | null) => void,
        closing: false,
      });
    });
  }, []);

  const settle = (value: boolean | string | null) => {
    if (!pending) return;
    pending.resolve(value);
    setPending({ ...pending, closing: true });
    setTimeout(() => setPending(null), 150);
  };

  return (
    <ConfirmContext.Provider value={confirmDialog}>
      <PromptContext.Provider value={promptDialog}>
        {children}
        {pending && (
          <div
            className={`modal-overlay${pending.closing ? ' is-closing' : ' active'}`}
            onKeyDown={(e) => {
              if (e.key === 'Escape') settle(pending.kind === 'prompt' ? null : false);
              if (e.key === 'Enter' && pending.kind === 'prompt') settle(inputRef.current?.value ?? '');
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
              {pending.kind === 'prompt' && (
                <div className="form-group" style={{ textAlign: 'left', margin: '4px 0 0' }}>
                  <input
                    ref={inputRef}
                    type="text"
                    defaultValue={pending.defaultValue}
                    placeholder={pending.placeholder}
                    autoFocus
                  />
                </div>
              )}
              <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                <button
                  className="btn btn-secondary"
                  style={{ flex: 1 }}
                  onClick={() => settle(pending.kind === 'prompt' ? null : false)}
                >
                  {pending.cancelLabel}
                </button>
                <button
                  className={pending.danger ? 'btn btn-danger' : 'btn btn-primary'}
                  style={{ flex: 1 }}
                  onClick={() => settle(pending.kind === 'prompt' ? inputRef.current?.value ?? '' : true)}
                  autoFocus={pending.kind === 'confirm'}
                >
                  {pending.okLabel}
                </button>
              </div>
            </div>
          </div>
        )}
      </PromptContext.Provider>
    </ConfirmContext.Provider>
  );
}

export function useConfirm(): ConfirmFn {
  const ctx = useContext(ConfirmContext);
  if (!ctx) throw new Error('useConfirm must be used within a ConfirmProvider');
  return ctx;
}

export function usePrompt(): PromptFn {
  const ctx = useContext(PromptContext);
  if (!ctx) throw new Error('usePrompt must be used within a ConfirmProvider');
  return ctx;
}
