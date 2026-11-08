import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { fuzzyRank as rank, get, type ComposerAddonProps } from '../../../plugin-api/web.ts';
import type { SlashCommand } from './shared/types.ts';

/**
 * The prompt box's `/` picker: the session's skills, commands and plugin commands, filtered as you type. Loaded on the
 * first `/` (one small request, remembered per session), so nothing is fetched until it's wanted.
 */

const loaded = new Map<string, SlashCommand[]>();

/** Picker state for a draft. `onPick(text)` gets the text to put in the box. */
function useSlashMenu(sessionId: string, text: string, onPick: (text: string) => void) {
  const query = /^\/(\S*)$/.exec(text)?.[1] ?? null;
  const [all, setAll] = useState<SlashCommand[]>(() => loaded.get(sessionId) ?? []);
  const [index, setIndex] = useState(0);
  const [dismissed, setDismissed] = useState<string | null>(null);

  useEffect(() => {
    if (query === null || loaded.has(sessionId)) return;
    let alive = true;
    get<{ commands: SlashCommand[] }>(`/api/sessions/${sessionId}/commands`)
      .then((r) => {
        loaded.set(sessionId, r.commands);
        if (alive) setAll(r.commands);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [sessionId, query === null]);

  useEffect(() => setIndex(0), [query]);

  const items = query === null ? [] : rank(all, query, (c) => c.name, 40);
  const waiting = query !== null && all.length === 0 && dismissed !== text; // first fetch (about 3s)
  const open = query !== null && dismissed !== text && items.length > 0;
  const exact = query !== null && items.some((c) => c.name === query);

  const pick = (c: SlashCommand) => onPick(`/${c.name} `);
  /** Returns true when the key was used by the picker (the caller then skips its own handling). */
  const onKeyDown = (e: KeyboardEvent): boolean => {
    if (!open) return false;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      setIndex((i) => (i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length);
    } else if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey && !exact)) {
      pick(items[index] ?? items[0]!);
    } else if (e.key === 'Escape') {
      setDismissed(text);
    } else return false;
    e.preventDefault();
    return true;
  };
  return { open, waiting, items, index, setIndex, pick, onKeyDown };
}

function SlashLoading() {
  return <div className="slash-menu"><div className="slash-item"><span className="slash-desc">Loading commands…</span></div></div>;
}

function SlashMenu({ items, index, setIndex, pick }: { items: SlashCommand[]; index: number; setIndex: (i: number) => void; pick: (c: SlashCommand) => void }) {
  const box = useRef<HTMLDivElement>(null);
  const sel = useRef<HTMLDivElement>(null);
  // Keep the highlighted row in view by scrolling the menu itself. (scrollIntoView also scrolls every ancestor, which
  // left the clipped page layout shifted, and blank once the menu closed.)
  useEffect(() => {
    const b = box.current;
    const r = sel.current;
    if (!b || !r) return;
    if (r.offsetTop < b.scrollTop) b.scrollTop = r.offsetTop;
    else if (r.offsetTop + r.offsetHeight > b.scrollTop + b.clientHeight) b.scrollTop = r.offsetTop + r.offsetHeight - b.clientHeight;
  }, [index]);
  return (
    <div className="slash-menu" role="listbox" aria-label="Commands" ref={box}>
      {items.map((c, i) => (
        <div
          key={c.name}
          ref={i === index ? sel : undefined}
          role="option"
          aria-selected={i === index}
          className={`slash-item${i === index ? ' sel' : ''}`}
          // mousedown, not click: the box keeps focus.
          onMouseDown={(e) => {
            e.preventDefault();
            pick(c);
          }}
          onMouseMove={() => i !== index && setIndex(i)}
        >
          <span className="slash-name">/{c.name}</span>
          <span className="slash-desc">{c.description}</span>
          <span className="slash-src">{c.source === 'plugin' ? c.plugin : c.source}</span>
        </div>
      ))}
    </div>
  );
}

/**
 * The `composer-addon`: draws the picker over the prompt box and, while it's open, registers a key handler so the
 * box hands it ↑↓ / Tab / Enter / Esc before its own handling.
 */
export function SlashPicker({ sessionId, draft, setDraft, inputRef, registerKeyHandler }: ComposerAddonProps) {
  const slash = useSlashMenu(sessionId, draft, (t) => {
    setDraft(t);
    inputRef.current?.focus();
  });
  const onKeyDown = slash.onKeyDown;
  // Re-registered every render: the handler reads this render's open/index/draft.
  useEffect(() => {
    registerKeyHandler(onKeyDown);
  });
  useEffect(() => () => registerKeyHandler(null), []);
  return (
    <>
      {slash.waiting && <SlashLoading />}
      {slash.open && <SlashMenu items={slash.items} index={slash.index} setIndex={slash.setIndex} pick={slash.pick} />}
    </>
  );
}
