import { useEffect, useRef, useState } from 'react';
import { guessSize, TermPane, TermTabs, useTerms } from './Terminals.tsx';

/**
 * Terminal tab: shells on this machine that belong to no workspace, in tabs. They live in the terminal daemon
 * (termd.ts), so they keep running when you leave the page, reload, or the main server restarts.
 */

const ACTIVE_KEY = 'wh.terminal.active';

export function TerminalPage() {
  const { terms, error, busy, create, close, restart, rename, asOf } = useTerms('/api/terms');
  const [active, setActive] = useState<string | null>(() => localStorage.getItem(ACTIVE_KEY));
  const bodyRef = useRef<HTMLDivElement>(null);
  const opened = useRef(false);

  const open = async () => {
    const t = await create(undefined, guessSize(bodyRef.current));
    if (t) setActive(t.id);
  };

  // First visit: open one terminal if there are none.
  useEffect(() => {
    if (terms && terms.length === 0 && !opened.current) {
      opened.current = true;
      void open();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [terms]);

  useEffect(() => {
    if (active) localStorage.setItem(ACTIVE_KEY, active);
  }, [active]);

  const current = terms?.find((t) => t.id === active) ?? terms?.[terms.length - 1] ?? null;
  const closeTerm = async (t: NonNullable<typeof current>) => {
    const list = await close(t);
    if (t.id === current?.id) setActive(list?.[list.length - 1]?.id ?? null);
  };

  return (
    <div className="term-page">
      <TermTabs terms={terms ?? []} activeId={current?.id ?? null} onPick={(t) => setActive(t.id)} onClose={(t) => void closeTerm(t)} onRename={(t, s) => void rename(t, s)}>
        <button className="term-new" onClick={() => void open()} disabled={busy} title="New terminal">
          +
        </button>
        {!!terms?.length && asOf}
      </TermTabs>
      {error && <div className="error">{error}</div>}
      <div className="term-page-body" ref={bodyRef}>
        {current ? (
          <TermPane key={current.id} term={current} onRestart={() => void restart(current)} onClose={() => void closeTerm(current)} />
        ) : (
          <div className="muted term-empty">{terms ? 'No terminals. Tap + to open one.' : 'Loading…'}</div>
        )}
      </div>
    </div>
  );
}
