import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useAnchored } from './useAnchored.ts';

export type MenuItem =
  | {
      label: string;
      onSelect?: () => void;
      danger?: boolean;
      disabled?: boolean;
      hidden?: boolean;
      /** Selecting it opens these in place of the menu (with a ‹ Back row) instead of calling `onSelect`. */
      submenu?: MenuItem[];
      /** false: not offered as a command in the palette when its menu is (e.g. the plugin registers a better one itself). */
      palette?: false;
    }
  | 'separator';

/** A button that opens a small floating menu. Arrow keys move, Enter selects, Esc or an outside click closes. */
export function Menu({
  trigger,
  ariaLabel,
  items,
  align = 'left',
  className = 'ghost',
}: {
  trigger: ReactNode;
  ariaLabel: string;
  items: MenuItem[];
  align?: 'left' | 'right';
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [sub, setSub] = useState<{ label: string; items: MenuItem[] } | null>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const style = useAnchored(open, btn, box, align === 'right');
  const close = () => {
    setOpen(false);
    setSub(null);
  };

  useEffect(() => {
    if (!open) return;
    box.current?.querySelector<HTMLElement>('button:not(:disabled)')?.focus();
    const onDown = (e: PointerEvent) => {
      const n = e.target as Node;
      if (!box.current?.contains(n) && !btn.current?.contains(n)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        close();
        btn.current?.focus();
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        const all = [...(box.current?.querySelectorAll<HTMLElement>('button:not(:disabled)') ?? [])];
        if (!all.length) return;
        e.preventDefault();
        const i = all.indexOf(document.activeElement as HTMLElement);
        all[(i + (e.key === 'ArrowDown' ? 1 : -1) + all.length) % all.length]?.focus();
      }
    };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, sub]);

  const visible = (sub ? sub.items : items).filter((i) => i === 'separator' || !i.hidden);
  return (
    <>
      <button ref={btn} className={className} aria-label={ariaLabel} aria-expanded={open} aria-haspopup="menu" onClick={() => (open ? close() : setOpen(true))}>
        {trigger}
      </button>
      {open &&
        createPortal(
          <div ref={box} className="dd-menu" role="menu" style={style}>
            {sub && (
              <>
                <button role="menuitem" className="dd-item dd-back" onClick={() => setSub(null)}>
                  ‹ {sub.label}
                </button>
                <div className="dd-sep" role="separator" />
              </>
            )}
            {visible.map((it, i) =>
              it === 'separator' ? (
                <div key={i} className="dd-sep" role="separator" />
              ) : (
                <button
                  key={i}
                  role="menuitem"
                  className={`dd-item ${it.danger ? 'danger' : ''}`}
                  disabled={it.disabled}
                  aria-haspopup={it.submenu ? 'menu' : undefined}
                  onClick={() => {
                    if (it.submenu) return setSub({ label: it.label, items: it.submenu });
                    close();
                    it.onSelect?.();
                  }}
                >
                  {it.label}
                  {it.submenu && <span className="dd-chev" aria-hidden> ›</span>}
                </button>
              ),
            )}
          </div>,
          document.body,
        )}
    </>
  );
}
