import { isMod } from '../lib/keys.ts';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ConversationSearch, searchSupported } from './ConversationSearch.tsx';

/**
 * A native modal dialog (top layer, backdrop, Esc, focus kept inside), portalled to <body> so the chat layout never
 * moves. Closes on Esc, the × button or a click on the backdrop.
 */
export function Modal({ head, onClose, children, className = '' }: { head: ReactNode; onClose: () => void; children: ReactNode; className?: string }) {
  const ref = useRef<HTMLDialogElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const [searching, setSearching] = useState(false);
  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
  }, []);
  // ⌘F in a modal (code, a diff, command output…) searches that modal's text, not the page behind it or the browser.
  useEffect(() => {
    if (!searchSupported) return;
    const onKey = (e: KeyboardEvent) => {
      if (!isMod(e) || e.key.toLowerCase() !== 'f') return; // ⌘F on a Mac, Ctrl+F elsewhere
      const top = [...document.querySelectorAll('dialog.modal[open]')].pop();
      if (top !== ref.current) return; // only the front-most modal answers
      e.preventDefault();
      e.stopPropagation(); // the session's own ⌘F (behind this modal) must not also fire
      setSearching(true);
      const box = ref.current?.querySelector<HTMLInputElement>('.convo-search input');
      box?.focus();
      box?.select();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);
  return createPortal(
    <dialog
      ref={ref}
      className={`modal ${className}`}
      onClose={onClose}
      onClick={(e) => {
        if (e.target === ref.current) ref.current.close(); // the backdrop (the dialog box itself has no padding)
      }}
    >
      <div className="modal-inner">
        <div className="modal-head">
          <div className="modal-title">{head}</div>
          <button type="button" className="modal-x" aria-label="Close" onClick={() => ref.current?.close()}>
            ×
          </button>
        </div>
        {searching && searchSupported && <ConversationSearch rootRef={bodyRef} onClose={() => setSearching(false)} />}
        <div className="modal-body" ref={bodyRef}>
          {children}
        </div>
      </div>
    </dialog>,
    document.body,
  );
}

/** A clickable card row (a div, so it can hold buttons of its own) that opens something. */
export function Row({ className, title, onOpen, children }: { className: string; title: string; onOpen: () => void; children: ReactNode }) {
  return (
    <div
      role="button"
      tabIndex={0}
      className={`edit-card edit-row ${className}`}
      title={title}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpen();
        }
      }}
    >
      {children}
    </div>
  );
}
