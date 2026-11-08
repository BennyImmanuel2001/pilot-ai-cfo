import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { AlertTriangle, CheckCircle2, X } from 'lucide-react';

type ToastKind = 'error' | 'success';
interface Toast { id: number; kind: ToastKind; message: string }

const ToastContext = createContext<(message: string, kind?: ToastKind) => void>(() => {});

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const dismiss = useCallback((id: number) => setToasts(t => t.filter(x => x.id !== id)), []);

  const push = useCallback((message: string, kind: ToastKind = 'error') => {
    const id = Date.now() + Math.random();
    setToasts(t => [...t.slice(-2), { id, kind, message }]);
    window.setTimeout(() => dismiss(id), 5000);
  }, [dismiss]);

  return (
    <ToastContext.Provider value={push}>
      {children}
      <div className="fixed bottom-5 right-5 z-[60] flex flex-col gap-2 w-[min(360px,calc(100vw-32px))]" role="status" aria-live="polite">
        <AnimatePresence initial={false}>
          {toasts.map(t => (
            <motion.div
              key={t.id}
              layout
              initial={{ opacity: 0, y: 16, scale: 0.96 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 8, scale: 0.96 }}
              transition={{ type: 'spring', stiffness: 380, damping: 30 }}
              className="toast"
            >
              {t.kind === 'error'
                ? <AlertTriangle size={15} className="shrink-0 mt-0.5" style={{ color: 'var(--danger)' }} />
                : <CheckCircle2 size={15} className="shrink-0 mt-0.5" style={{ color: 'var(--success)' }} />}
              <p className="flex-1 text-[13px] leading-snug">{t.message}</p>
              <button onClick={() => dismiss(t.id)} aria-label="Dismiss notification" className="icon-btn-sm">
                <X size={13} />
              </button>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </ToastContext.Provider>
  );
}

export const useToast = () => useContext(ToastContext);
