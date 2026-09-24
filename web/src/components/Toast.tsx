import { CircleAlert, CircleCheck, Info, X } from 'lucide-react';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { cn } from '../lib/cn';

export type ToastTone = 'success' | 'error' | 'info';

export interface ToastInput {
  title: string;
  description?: string;
  tone?: ToastTone;
  /** Milliseconds before auto-dismiss. Errors stay longer by default. */
  durationMs?: number;
}

interface ToastItem extends Required<Pick<ToastInput, 'title' | 'tone'>> {
  id: number;
  description?: string;
}

interface ToastApi {
  push: (toast: ToastInput) => void;
  dismiss: (id: number) => void;
}

const ToastContext = createContext<ToastApi | null>(null);
const MAX_TOASTS = 4;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const timers = useRef(new Map<number, number>());
  const nextId = useRef(1);

  const dismiss = useCallback((id: number) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
    const timer = timers.current.get(id);
    if (timer !== undefined) window.clearTimeout(timer);
    timers.current.delete(id);
  }, []);

  const push = useCallback(
    (input: ToastInput) => {
      const id = nextId.current++;
      const tone = input.tone ?? 'info';
      setToasts((current) =>
        [...current, { id, title: input.title, description: input.description, tone }].slice(-MAX_TOASTS),
      );
      const duration = input.durationMs ?? (tone === 'error' ? 8000 : 5000);
      timers.current.set(
        id,
        window.setTimeout(() => dismiss(id), duration),
      );
    },
    [dismiss],
  );

  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const timer of pending.values()) window.clearTimeout(timer);
      pending.clear();
    };
  }, []);

  const api = useMemo(() => ({ push, dismiss }), [push, dismiss]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div
        aria-live="polite"
        aria-relevant="additions"
        className="pointer-events-none fixed inset-x-0 bottom-0 z-50 flex flex-col items-center gap-2 p-4 sm:items-end"
      >
        {toasts.map((toast) => (
          <ToastView key={toast.id} toast={toast} onDismiss={() => dismiss(toast.id)} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

function ToastView({ toast, onDismiss }: { toast: ToastItem; onDismiss: () => void }) {
  const Icon = toast.tone === 'success' ? CircleCheck : toast.tone === 'error' ? CircleAlert : Info;
  return (
    <div
      role={toast.tone === 'error' ? 'alert' : 'status'}
      className="pointer-events-auto flex w-full max-w-sm animate-toast-in items-start gap-3 rounded-xl border border-line bg-surface px-4 py-3 shadow-lg"
    >
      <Icon
        className={cn(
          'mt-0.5 size-4 shrink-0',
          toast.tone === 'success' && 'text-ok',
          toast.tone === 'error' && 'text-danger',
          toast.tone === 'info' && 'text-info',
        )}
        aria-hidden="true"
      />
      <div className="min-w-0 flex-1 text-sm">
        <p className="font-medium text-fg">{toast.title}</p>
        {toast.description && <p className="mt-0.5 break-words text-muted">{toast.description}</p>}
      </div>
      <button
        type="button"
        onClick={onDismiss}
        className="-m-1 rounded-md p-1 text-muted hover:bg-surface-2 hover:text-fg"
        aria-label="Dismiss notification"
      >
        <X className="size-4" aria-hidden="true" />
      </button>
    </div>
  );
}

export function useToast(): ToastApi {
  const context = useContext(ToastContext);
  if (!context) throw new Error('useToast must be used inside <ToastProvider>.');
  return context;
}
