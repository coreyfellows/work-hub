import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useAnchored } from './useAnchored.ts';

/**
 * A trigger button that opens a popover (floating, so nothing reflows) asking to confirm a destructive
 * action. Esc, a click outside or another click on the trigger dismisses it; there is no timeout.
 */
export function ConfirmPopover({
  children,
  message,
  confirmLabel,
  onConfirm,
  className = '',
  disabled,
  title,
  ariaLabel,
}: {
  children: ReactNode;
  message: ReactNode;
  confirmLabel: string;
  onConfirm: () => void | Promise<void>;
  className?: string;
  disabled?: boolean;
  title?: string;
  ariaLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const style = useAnchored(open, trigger, box);

  useEffect(() => {
    if (!open) return;
    cancel.current?.focus();
    const onDown = (e: PointerEvent) => {
      const n = e.target as Node;
      if (!box.current?.contains(n) && !trigger.current?.contains(n)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        trigger.current?.focus();
      }
    };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // The trigger can vanish or get disabled while open (row ended, action started): drop the popover.
  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  return (
    <>
      <button ref={trigger} className={className} disabled={disabled} title={title} aria-label={ariaLabel} aria-expanded={open} aria-haspopup="dialog" onClick={() => setOpen((o) => !o)}>
        {children}
      </button>
      {open &&
        createPortal(
          <div ref={box} className="popover" role="dialog" style={style}>
            <div className="popover-msg">{message}</div>
            <div className="popover-actions">
              <button ref={cancel} className="ghost" onClick={() => setOpen(false)}>
                Cancel
              </button>
              <button
                className="danger"
                onClick={() => {
                  setOpen(false);
                  void onConfirm();
                }}
              >
                {confirmLabel}
              </button>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
