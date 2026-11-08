import { IS_MAC, isMod } from '../lib/keys.ts';
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { rank, rankPreferring } from '../lib/fuzzy.ts';
import { navigate } from '../router.tsx';
import { StatusBadge } from './StatusBadge.tsx';
import { useToast } from './Toast.tsx';
import { isTypingTarget, OPEN_PALETTE_EVENT, paletteMode } from '../lib/palette.ts';
import type { PaletteCommand, PaletteCommandContext, PaletteEntry } from '../../../plugin-api/web.ts';

/** `kind` is open (plugins add their own via the `palette-items` slot); the row shows `kindLabel`, else a core label, else `kind`. */
/** Fired just before a palette jump navigates: the app remounts `main` with an entrance animation (App.tsx). */
export const PAGE_ENTER_EVENT = 'wh:page-enter';
function navigateWithTransition(to: string): void {
  if (to !== location.pathname + location.search) window.dispatchEvent(new Event(PAGE_ENTER_EVENT));
  navigate(to);
}

export type PaletteItem = PaletteEntry;

export { OPEN_PALETTE_EVENT };
const KIND_LABEL: Record<string, string> = { page: 'Page', workspace: 'Workspace', session: 'Session' };

type Row = { kind: 'jump'; item: PaletteItem } | { kind: 'command'; command: PaletteCommand };

/**
 * ⌘K on a Mac (also Ctrl+K outside a terminal/input there), Ctrl+K elsewhere (not inside a terminal), opens a jump-to list over pages, workspaces, sessions and PRs. A query starting
 * with `>` lists commands instead (on-screen ones, the `palette-commands` slot's and the core's); `>` pressed outside an
 * input, or ⇧⌘K anywhere, opens the palette that way.
 */
export function CommandPalette({ items, commands }: { items: PaletteItem[]; commands: () => { ctx: PaletteCommandContext; list: PaletteCommand[] } }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [sel, setSel] = useState(0);
  // Per workspace row: which session ←/→ has selected, and the first of the three chips shown.
  const [pick, setPick] = useState<Record<string, { at: number; start: number }>>({});
  const input = useRef<HTMLInputElement>(null);
  const { show: toast } = useToast();
  // The prefill for the next open (">" from the `>` key or `openPalette('>')`), read when it opens.
  const prefill = useRef('');

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === '>' && !e.metaKey && !e.ctrlKey && !e.altKey && !isTypingTarget(e.target as Element | null) && !document.querySelector('.palette')) {
        e.preventDefault();
        prefill.current = '>';
        setOpen(true);
        return;
      }
      // ⇧⌘K (Ctrl+Shift+K; on a Mac either): straight to the commands, from anywhere (a text box too), or switch an open palette to them.
      if (e.key.toLowerCase() === 'k' && e.shiftKey && (e.metaKey || e.ctrlKey) && !e.altKey) {
        e.preventDefault();
        prefill.current = '>';
        setQuery('>');
        setOpen(true);
        return;
      }
      if (e.key.toLowerCase() !== 'k' || e.altKey || e.shiftKey) return;
      const inPalette = (e.target as HTMLElement | null)?.closest?.('.palette');
      if (isMod(e)) {
        // ⌘K on a Mac works everywhere. Ctrl+K (Windows, Linux) is also a shell binding: a terminal keeps it.
        if (!IS_MAC && !inPalette && (e.target as HTMLElement | null)?.closest?.('.xterm')) return;
        e.preventDefault();
        setOpen((o) => !o);
      } else if (IS_MAC && e.ctrlKey && !e.metaKey) {
        // Ctrl+K on a Mac is a real shell/editor binding: only take it from plain page focus (or the palette itself).
        if (inPalette || !isTypingTarget(e.target as Element | null)) {
          e.preventDefault();
          setOpen((o) => !o);
        }
      }
    };
    const onOpen = (e: Event) => {
      prefill.current = String((e as CustomEvent<{ query?: string } | undefined>).detail?.query ?? '');
      setOpen(true);
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener(OPEN_PALETTE_EVENT, onOpen);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener(OPEN_PALETTE_EVENT, onOpen);
    };
  }, []);

  useEffect(() => {
    if (open) {
      setQuery(prefill.current);
      prefill.current = '';
      setSel(0);
      setPick({});
      setTimeout(() => input.current?.focus(), 0);
    }
  }, [open]);

  const mode = paletteMode(query);
  // Built only while open (and on each render then: the context follows the page, the slot's lists the sources).
  // A plain search also surfaces the best few matching commands first ("session" finds New session); `>` lists them all.
  const cmds = open && (mode.commands || mode.filter.trim()) ? commands() : null;
  const results = useMemo<Row[]>(
    () => {
      const jumps = (): Row[] =>
        rank(items, mode.filter, (i) => `${i.label} ${i.hint ?? ''} ${i.sessions?.map((x) => x.label).join(' ') ?? ''}`).map((item) => ({ kind: 'jump' as const, item }));
      if (!cmds) return jumps();
      if (mode.commands) return rankPreferring(cmds.list, mode.filter, (c) => c.label, (c) => `${c.hint ?? ''} ${c.group ?? ''}`, 50).map((command) => ({ kind: 'command' as const, command }));
      const top = rankPreferring(cmds.list, mode.filter, (c) => c.label, () => '', 3).map((command) => ({ kind: 'command' as const, command }));
      return [...top, ...jumps()];
    },
    // `cmds` is rebuilt every render; what it lists only changes with these.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [items, query, open, cmds?.list.map((c) => c.id).join('\n')],
  );
  useEffect(() => setSel(0), [query]);
  if (!open) return null;

  const go = (r: Row | undefined) => {
    if (!r) return;
    setOpen(false);
    if (r.kind === 'command') {
      const fail = (e: unknown) => toast({ kind: 'error', text: `${r.command.label}: ${e instanceof Error ? e.message : String(e)}` });
      try {
        const p = r.command.run(cmds!.ctx);
        if (p && typeof (p as Promise<unknown>).catch === 'function') (p as Promise<unknown>).catch(fail);
      } catch (e) {
        fail(e);
      }
      return;
    }
    const i = r.item;
    navigateWithTransition(i.sessions?.[pick[i.id]?.at ?? 0]?.to ?? i.to);
    // Opening a workspace or session from here lands in its current input (the Chat footer picks this up, when it mounts or now).
    (window as unknown as { whFocusInputUntil?: number }).whFocusInputUntil = Date.now() + 4000;
    setTimeout(() => window.dispatchEvent(new Event('wh:focus-input')), 50);
  };

  return createPortal(
    <div className="palette-backdrop" onMouseDown={(e) => e.target === e.currentTarget && setOpen(false)}>
      <div className={`palette${mode.commands ? ' commands' : ''}`} role="dialog" aria-label={mode.commands ? 'Commands' : 'Jump to'}>
        <input
          ref={input}
          className="palette-input"
          placeholder={mode.commands ? 'Run a command…' : 'Jump to a workspace, session, PR or page… (> for commands)'}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') setOpen(false);
            else if (e.key === 'ArrowDown') {
              e.preventDefault();
              setSel((s) => Math.min(s + 1, results.length - 1));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setSel((s) => Math.max(s - 1, 0));
            } else if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
              // ← → pick among the selected workspace's sessions (the window of three slides to keep it in view).
              const cur = results[sel];
              const n = cur?.kind === 'jump' ? (cur.item.sessions?.length ?? 0) : 0;
              if (cur?.kind !== 'jump' || n < 2) return;
              e.preventDefault();
              const id = cur.item.id;
              const at = Math.max(0, Math.min(n - 1, (pick[id]?.at ?? 0) + (e.key === 'ArrowRight' ? 1 : -1)));
              let start = pick[id]?.start ?? 0;
              if (at < start) start = at;
              else if (at > start + 2) start = at - 2;
              setPick((p) => ({ ...p, [id]: { at, start } }));
            } else if (e.key === 'Enter') {
              // Not the keypress that follows: the page we open may focus a textarea in time to take it as a newline.
              e.preventDefault();
              go(results[sel]);
            }
          }}
        />
        <div className="palette-list" role="listbox">
          {results.length === 0 && <div className="palette-empty muted">{mode.commands ? 'No matching commands' : 'No matches'}</div>}
          {results.map((row, i) => (
            <button
              key={row.kind === 'command' ? `cmd:${row.command.id}` : row.item.id}
              role="option"
              aria-selected={i === sel}
              ref={(el) => {
                if (el && i === sel) el.scrollIntoView({ block: 'nearest' });
              }}
              className={`palette-row ${i === sel ? 'on' : ''}`}
              onMouseEnter={() => setSel(i)}
              onClick={() => go(row)}
            >
              {row.kind === 'command' ? (
                <>
                  <span className="palette-kind">{row.command.group ?? 'Command'}</span>
                  <span className="ellipsis">{row.command.label}</span>
                  {row.command.hint && <span className="muted small-text ellipsis">{row.command.hint}</span>}
                </>
              ) : (
                <>
                  <span className="palette-kind">{row.item.kindLabel ?? KIND_LABEL[row.item.kind] ?? row.item.kind}</span>
                  <span className="ellipsis">{row.item.label}</span>
                  {row.item.hint && <span className="muted small-text ellipsis">{row.item.hint}</span>}
                  {row.item.sessions && row.item.sessions.length > 0 ? (
                    <PaletteSessions item={row.item} at={pick[row.item.id]?.at ?? 0} start={pick[row.item.id]?.start ?? 0} active={i === sel} />
                  ) : (
                    row.item.status && <StatusBadge status={row.item.status.status} unread={row.item.status.unread} />
                  )}
                </>
              )}
            </button>
          ))}
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** A workspace row's sessions: three status badges at a time (the session name is the hover title), ‹ › when more are off either side; the selected one is outlined while the row is. */
function PaletteSessions({ item, at, start, active }: { item: PaletteItem; at: number; start: number; active: boolean }) {
  const all = item.sessions ?? [];
  const shown = all.slice(start, start + 3);
  return (
    <span className="palette-sessions">
      {start > 0 && <span className="palette-more muted" aria-hidden>‹</span>}
      {shown.map((s, k) => (
        <span key={s.id} className={`palette-chip${active && start + k === at && all.length > 1 ? ' on' : ''}`} title={s.label}>
          <StatusBadge status={s.status} unread={s.unread} />
        </span>
      ))}
      {start + 3 < all.length && <span className="palette-more muted" aria-hidden>›</span>}
    </span>
  );
}
