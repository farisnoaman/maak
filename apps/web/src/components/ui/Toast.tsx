'use client';

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';

export type ToastTone = 'info' | 'success' | 'warning' | 'danger';

export interface ToastMessage {
  readonly id: string;
  readonly title: string;
  readonly description?: string;
  readonly tone: ToastTone;
}

interface ToastApi {
  readonly toasts: readonly ToastMessage[];
  readonly push: (toast: Omit<ToastMessage, 'id'>) => void;
  readonly dismiss: (id: string) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

/**
 * Announced through `aria-live="polite"`, so a screen-reader user hears the outcome of an action.
 * Errors use `role="alert"` for immediacy. Toasts never contain money amounts without a currency.
 */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<readonly ToastMessage[]>([]);

  const dismiss = useCallback((id: string) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const push = useCallback(
    (toast: Omit<ToastMessage, 'id'>) => {
      const id = `toast_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      setToasts((current) => [...current, { ...toast, id }]);
      setTimeout(() => dismiss(id), 6000);
    },
    [dismiss],
  );

  const value = useMemo<ToastApi>(() => ({ toasts, push, dismiss }), [toasts, push, dismiss]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="ui-toasts" aria-live="polite" aria-atomic="false">
        {toasts.map((toast) => (
          <div
            key={toast.id}
            className={`ui-toast ui-toast--${toast.tone}`}
            role={toast.tone === 'danger' ? 'alert' : 'status'}
          >
            <div className="ui-toast__body">
              <p className="ui-toast__title">{toast.title}</p>
              {toast.description ? <p className="ui-toast__desc">{toast.description}</p> : null}
            </div>
            <button
              type="button"
              className="ui-toast__close"
              onClick={() => dismiss(toast.id)}
              aria-label="×"
            >
              ×
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const context = useContext(ToastContext);
  if (!context) throw new Error('useToast must be used inside <ToastProvider>');
  return context;
}
