import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { keyLabel } from '../lib/keys.ts';
import { isTypingTarget } from '../lib/palette.ts';
import { useSlot } from '../slots.ts';
import { CORE_SHORTCUTS } from '../shortcuts.ts';
import { useAnchored } from './useAnchored.ts';

const GROUP_ORDER = ['Anywhere', 'Palette', 'Workspace', 'Session', 'Prompt box', 'Pull requests', 'Menus'];

/** The header's ⌨ button: a cheat sheet of the keyboard shortcuts (the core's and the `shortcut` slot's), shown the platform's way. `?` opens it too. */
export function ShortcutSheet() {
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const style = useAnchored(open, btn, box, true);
  const fromPlugins = useSlot('shortcut');

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === '?' && !e.metaKey && !e.ctrlKey && !e.altKey && !isTypingTarget(e.target as Element | null) && !document.querySelector('.palette, dialog[open]')) {
        e.preventDefault();
        setOpen((o) => !o);
      } else if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const n = e.target as Node;
      if (!box.current?.contains(n) && !btn.current?.contains(n)) setOpen(false);
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [open]);

  const all = [...CORE_SHORTCUTS, ...fromPlugins];
  const groups = [...new Set(all.map((s) => s.group))].sort((a, b) => {
    const ia = GROUP_ORDER.indexOf(a);
    const ib = GROUP_ORDER.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });
  return (
    <>
      <button ref={btn} className="ghost shortcut-btn" aria-expanded={open} aria-label="Keyboard shortcuts" title="Keyboard shortcuts (?)" onClick={() => setOpen((o) => !o)}>
        ⌨
      </button>
      {open &&
        createPortal(
          <div ref={box} className="shortcut-panel" role="dialog" aria-label="Keyboard shortcuts" style={style}>
            <div className="shortcut-head">Keyboard shortcuts</div>
            {groups.map((g) => (
              <section key={g} className="shortcut-group">
                <h4>{g}</h4>
                {all
                  .filter((s) => s.group === g)
                  .map((s, i) => (
                    <div key={i} className="shortcut-row">
                      <span className="shortcut-keys">
                        {s.keys.map((k, j) => (
                          <kbd key={j}>{keyLabel(k)}</kbd>
                        ))}
                      </span>
                      <span className="shortcut-label">
                        {s.label}
                        {s.where && <span className="muted small-text"> · {s.where}</span>}
                      </span>
                    </div>
                  ))}
              </section>
            ))}
          </div>,
          document.body,
        )}
    </>
  );
}
