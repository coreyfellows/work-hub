import { useCallback, useEffect, useRef, useState } from 'react';
import { AsOf, ConfirmPopover, get, post, useLowData } from '../../plugin-api/web.ts';
import { ShellTerminal, type ShellHandle, type ShellStatus } from './ShellTerminal.tsx';

/**
 * Shells from the terminal daemon (termd.ts), shared by the Terminal tab and workspace pages:
 * `useTerms` loads and manages a list, `TermTabs` is a tab strip, `TermPane` shows one terminal.
 */

export interface Term {
  id: string;
  title: string;
  custom: boolean;
  createdAt: number;
  alive: boolean;
  workspace: string | null;
  cwd: string;
}

/** `base`: '/api/terms' (the general Terminal tab) or '/api/workspaces/<id>/terms'. */
export function useTerms(base: string, onActionError?: (message: string) => void) {
  const [terms, setTerms] = useState<Term[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loadedAt, setLoadedAt] = useState<number | null>(null);
  const lowData = useLowData();

  const load = useCallback(async () => {
    try {
      const list = await get<Term[]>(base);
      setTerms(list);
      setLoadedAt(Date.now());
      setError(null);
      return list;
    } catch (e) {
      setError((e as Error).message);
      return null;
    }
  }, [base]);

  useEffect(() => {
    void load();
    if (lowData) return; // low data: on opening, after changes and on tap only
    const t = setInterval(() => void load(), 5000); // titles and exits
    return () => clearInterval(t);
  }, [load, lowData]);

  const guard = async <T,>(fn: () => Promise<T>): Promise<T | null> => {
    try {
      return await fn();
    } catch (e) {
      // Failed actions go to `onActionError` (a toast) when given; list-load errors stay in `error`.
      if (onActionError) onActionError((e as Error).message);
      else setError((e as Error).message);
      return null;
    }
  };

  return {
    terms,
    error,
    busy,
    load,
    /** Low data only: an "as of … ↻" for the tab row (the list isn't polled then). */
    asOf: lowData ? <AsOf at={loadedAt} onRefresh={() => void load()} /> : null,
    /**
     * Start a shell (in `cwd`, for workspace terminals); returns it. Workspace terminals only: `run` is a script to run
     * in it, its output saved on a run record for `sessionId`.
     */
    create: async (cwd?: string, size?: { cols: number; rows: number }, run?: { command: string; sessionId: string }) => {
      setBusy(true);
      const t = await guard(() =>
        post<Term>(base, { ...(size ?? { cols: 100, rows: 30 }), ...(cwd ? { cwd } : {}), ...(run ? { run: run.command, sessionId: run.sessionId } : {}) }),
      );
      await load();
      setBusy(false);
      return t;
    },
    close: async (t: Term) => {
      await guard(() => post(`/api/terms/${t.id}/close`, {}));
      return load();
    },
    restart: async (t: Term) => {
      await guard(() => post(`/api/terms/${t.id}/restart`, {}));
      await load();
    },
    rename: async (t: Term, title: string) => {
      await guard(() => post(`/api/terms/${t.id}/rename`, { title }));
      await load();
    },
  };
}

/** A tab per terminal (tap the active one to rename it; ✕ closes; a live shell asks first), then `children` (e.g. a + button). */
export function TermTabs({
  terms,
  activeId,
  onPick,
  onClose,
  onRename,
  children,
  className = '',
}: {
  terms: Term[];
  activeId: string | null;
  onPick: (t: Term) => void;
  onClose: (t: Term) => void;
  onRename: (t: Term, title: string) => void;
  children?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={`term-tabs ${className}`} role="tablist">
      {terms.map((t, i) => (
        <TermTab key={t.id} t={t} index={i} on={t.id === activeId} onPick={onPick} onClose={onClose} onRename={onRename} />
      ))}
      {children}
    </div>
  );
}

/** One terminal's tab: tap to open, tap the active one to rename, ✕ closes (a live shell asks first). */
export function TermTab({
  t,
  index,
  on,
  onPick,
  onClose,
  onRename,
}: {
  t: Term;
  index: number;
  on: boolean;
  onPick: (t: Term) => void;
  onClose: (t: Term) => void;
  onRename: (t: Term, title: string) => void;
}) {
  const [renaming, setRenaming] = useState(false);
  const label = t.title || `Terminal ${index + 1}`;
  return (
    <div className={`term-tab ${on ? 'on' : ''} ${t.alive ? '' : 'ended'}`} role="tab" aria-selected={on} title={t.cwd}>
      {renaming ? (
        <input
          className="term-rename"
          autoFocus
          defaultValue={t.custom ? t.title : ''}
          placeholder={label}
          onBlur={(e) => {
            setRenaming(false);
            onRename(t, e.currentTarget.value);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur();
            if (e.key === 'Escape') setRenaming(false);
          }}
        />
      ) : (
        <button className="term-tab-label ellipsis" onClick={() => (on ? setRenaming(true) : onPick(t))} title={on ? 'Tap again to rename' : t.cwd}>
          <span className="term-icon">›_</span> {label}
        </button>
      )}
      {t.alive ? (
        <ConfirmPopover className="term-tab-close" ariaLabel="Close terminal" title="Close this terminal" confirmLabel="Close terminal" message="Ends the shell and anything running in it." onConfirm={() => onClose(t)}>
          ✕
        </ConfirmPopover>
      ) : (
        <button className="term-tab-close" aria-label="Close terminal" title="Close this terminal" onClick={() => onClose(t)}>
          ✕
        </button>
      )}
    </div>
  );
}

const KEYS: Array<{ label: string; seq: string; title?: string }> = [
  { label: 'esc', seq: '\x1b' },
  { label: 'tab', seq: '\t' },
  { label: '^C', seq: '\x03', title: 'Interrupt' },
  { label: '^D', seq: '\x04', title: 'End of input' },
  { label: '←', seq: '\x1b[D' },
  { label: '↑', seq: '\x1b[A' },
  { label: '↓', seq: '\x1b[B' },
  { label: '→', seq: '\x1b[C' },
  { label: '|', seq: '|' },
  { label: '~', seq: '~' },
  { label: '/', seq: '/' },
  { label: '-', seq: '-' },
];

/** One terminal: the live shell, an "ended" bar with New shell here / Close, and a key bar for phones. */
export function TermPane({ term, onRestart, onClose }: { term: Term; onRestart: () => void; onClose: () => void }) {
  const [status, setStatus] = useState<ShellStatus>('connecting');
  const [ctrl, setCtrl] = useState(false);
  const shell = useRef<ShellHandle>(null);

  // Sticky ctrl from the key bar: the next typed letter goes as its control character.
  const ctrlRef = useRef(ctrl);
  ctrlRef.current = ctrl;
  const transformInput = useCallback((d: string) => {
    if (!ctrlRef.current || d.length !== 1) return d;
    setCtrl(false);
    const c = d.toUpperCase().charCodeAt(0);
    return c >= 64 && c <= 95 ? String.fromCharCode(c - 64) : d;
  }, []);

  const exited = !term.alive || status === 'exited';

  return (
    <div className="term-pane">
      <div className="term-body">
        <ShellTerminal key={term.id} id={term.id} ref={shell} onStatus={setStatus} transformInput={transformInput} />
        {status !== 'live' && !exited && <span className={`term-status st-${status}`}>{status}</span>}
        {exited && (
          <div className="term-exited">
            <span>The shell has ended; its output is kept above.</span>
            <button className="primary" onClick={onRestart}>
              New shell here
            </button>
            <button className="ghost" onClick={onClose}>
              Close tab
            </button>
          </div>
        )}
      </div>
      <div className="term-keys">
        <button className={ctrl ? 'on' : ''} onClick={() => setCtrl((c) => !c)} title="Ctrl for the next key">
          ctrl
        </button>
        {KEYS.map((k) => (
          <button
            key={k.label}
            title={k.title}
            onClick={() => {
              shell.current?.send(k.seq);
              shell.current?.focus();
            }}
          >
            {k.label}
          </button>
        ))}
      </div>
    </div>
  );
}

/** A size guess for a new shell from the space it'll fill; the terminal corrects it once laid out. */
export function guessSize(el: HTMLElement | null) {
  return el ? { cols: Math.max(20, Math.floor(el.clientWidth / 7.6)), rows: Math.max(5, Math.floor(el.clientHeight / 17)) } : { cols: 100, rows: 30 };
}
