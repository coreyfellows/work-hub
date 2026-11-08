import { useEffect, useRef, useState, type RefObject } from 'react';

/** The CSS Custom Highlight API paints matches without touching the DOM (so React's rendering is never disturbed). */
export const searchSupported = typeof CSS !== 'undefined' && 'highlights' in CSS && typeof Highlight !== 'undefined';

const SKIP = new Set(['SCRIPT', 'STYLE', 'TEXTAREA', 'INPUT', 'SELECT']);

/** Every case-insensitive occurrence of `query` in the text under `root` (only what is currently rendered). */
export function findRanges(root: HTMLElement, query: string): Range[] {
  const q = query.toLowerCase();
  const out: Range[] = [];
  if (!q) return out;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => {
      const el = n.parentElement;
      if (!el || SKIP.has(el.tagName) || el.closest('[data-no-search]')) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const text = (n.nodeValue ?? '').toLowerCase();
    for (let at = text.indexOf(q); at >= 0; at = text.indexOf(q, at + q.length)) {
      const r = document.createRange();
      r.setStart(n, at);
      r.setEnd(n, at + q.length);
      out.push(r);
      if (out.length >= 2000) return out;
    }
  }
  return out;
}

/**
 * A find-in-page box for the Chat or Log: searches only the text rendered inside `rootRef` (what's loaded; use
 * "Load earlier" to bring older messages in). Enter / Shift+Enter or ▲▼ step through matches, Esc closes.
 * `onJump` runs when it scrolls to a match (so a view that follows the newest message can stop following).
 */
export function ConversationSearch({ rootRef, onClose, onJump }: { rootRef: RefObject<HTMLElement | null>; onClose: () => void; onJump?: () => void }) {
  const [query, setQuery] = useState('');
  const [count, setCount] = useState(0);
  const [index, setIndex] = useState(0);
  const ranges = useRef<Range[]>([]);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => input.current?.focus(), []);

  // (Re)find matches when the query changes or the conversation does (new messages, earlier ones loaded).
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const run = () => {
      ranges.current = findRanges(root, query.trim());
      setCount(ranges.current.length);
      setIndex((i) => (ranges.current.length ? Math.min(i, ranges.current.length - 1) : 0));
    };
    run();
    const mo = new MutationObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(run, 250);
    });
    mo.observe(root, { childList: true, subtree: true, characterData: true });
    return () => {
      mo.disconnect();
      clearTimeout(timer);
    };
  }, [query, rootRef]);

  // Paint all matches, and the current one stronger; scroll to the current one when you step.
  const jump = useRef(false);
  useEffect(() => {
    if (!searchSupported) return;
    CSS.highlights.set('wh-search', new Highlight(...ranges.current));
    const cur = ranges.current[index];
    if (cur) {
      CSS.highlights.set('wh-search-current', new Highlight(cur));
      if (jump.current) {
        onJump?.();
        cur.startContainer.parentElement?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      }
    } else CSS.highlights.delete('wh-search-current');
    jump.current = false;
  }, [index, count, query]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(
    () => () => {
      if (!searchSupported) return;
      CSS.highlights.delete('wh-search');
      CSS.highlights.delete('wh-search-current');
    },
    [],
  );

  const step = (d: 1 | -1) => {
    if (!count) return;
    jump.current = true;
    setIndex((i) => (i + d + count) % count);
  };

  return (
    <div className="convo-search" role="search">
      <input
        ref={input}
        type="search"
        placeholder="Search this view…"
        aria-label="Search this conversation view"
        value={query}
        onChange={(e) => {
          jump.current = true;
          setIndex(0);
          setQuery(e.target.value);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault(); // inside a modal, don't also close the dialog
            e.stopPropagation();
            onClose();
          }
          else if (e.key === 'Enter') {
            e.preventDefault();
            step(e.shiftKey ? -1 : 1);
          }
        }}
      />
      <span className="muted small-text convo-search-count">{query.trim() ? (count ? `${index + 1} / ${count}` : 'No matches') : ''}</span>
      <button className="ghost icon" aria-label="Previous match" disabled={!count} onClick={() => step(-1)}>
        ▲
      </button>
      <button className="ghost icon" aria-label="Next match" disabled={!count} onClick={() => step(1)}>
        ▼
      </button>
      <button className="ghost icon" aria-label="Close search" onClick={onClose}>
        ×
      </button>
    </div>
  );
}
