import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

export type ToastInput = {
  text: string;
  kind?: 'info' | 'error';
  action?: { label: string; run: () => void | Promise<void> };
};

type ToastItem = ToastInput & { id: number; kind: 'info' | 'error' };

const MAX = 4;
const Ctx = createContext<{ show: (t: ToastInput) => void }>({ show: () => {} });

export function useToast() {
  return useContext(Ctx);
}

/** Transient feedback (errors, "done", Undo) in one place, bottom-right (bottom-centre on phones). */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const nextId = useRef(1);
  const dismiss = useCallback((id: number) => setItems((l) => l.filter((t) => t.id !== id)), []);
  const show = useCallback((t: ToastInput) => {
    const item: ToastItem = { ...t, kind: t.kind ?? 'info', id: nextId.current++ };
    setItems((l) => [...l, item].slice(-MAX));
  }, []);
  const value = useMemo(() => ({ show }), [show]);
  // A manual popover lives in the top layer, so toasts stay visible above an open <dialog> modal.
  const box = useRef<HTMLDivElement>(null);
  const shown = useRef(0);
  useEffect(() => {
    const el = box.current;
    const grew = items.length > shown.current;
    shown.current = items.length;
    if (!el || !el.showPopover) return;
    try {
      if (!items.length) el.hidePopover();
      else if (grew) {
        // Re-showing moves it above any modal opened since.
        el.hidePopover();
        el.showPopover();
      }
    } catch {
      /* already in the wanted state */
    }
  }, [items]);
  return (
    <Ctx.Provider value={value}>
      {children}
      {createPortal(
        <div ref={box} popover="manual" className="toasts" role="status" aria-live="polite">
          {items.map((t) => (
            <ToastView key={t.id} t={t} onDone={() => dismiss(t.id)} />
          ))}
        </div>,
        document.body,
      )}
    </Ctx.Provider>
  );
}

function ToastView({ t, onDone }: { t: ToastItem; onDone: () => void }) {
  const [hover, setHover] = useState(false);
  useEffect(() => {
    if (hover) return;
    const timer = setTimeout(onDone, t.kind === 'error' ? 10000 : 6000);
    return () => clearTimeout(timer);
  }, [hover, t.kind]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className={`toast ${t.kind}`} onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}>
      <span className="toast-text">{t.text}</span>
      {t.action && (
        <button
          className="ghost"
          onClick={() => {
            onDone();
            void t.action!.run();
          }}
        >
          {t.action.label}
        </button>
      )}
      <button className="ghost icon" aria-label="Dismiss" onClick={onDone}>
        ×
      </button>
    </div>
  );
}
