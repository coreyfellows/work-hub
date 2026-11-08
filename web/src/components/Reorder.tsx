import { useRef, useState, useSyncExternalStore, type DragEvent } from 'react';
import { moveBefore } from '../lib/order.ts';

const PHONE = '(max-width: 700px)';
const subscribePhone = (f: () => void) => {
  const m = matchMedia(PHONE);
  m.addEventListener('change', f);
  return () => m.removeEventListener('change', f);
};
/** Phone-width screens move things with ▲▼ buttons; wider ones by dragging (no buttons). */
export function useIsPhone(): boolean {
  return useSyncExternalStore(subscribePhone, () => matchMedia(PHONE).matches);
}

/**
 * Drag-and-drop for a list of ids: `bind(id)` gives an element the props to be dragged and dropped on. Dropping on the
 * upper half of a target puts the dragged item before it, the lower half after it (so the last item can be passed).
 * `order` is the current order; `onChange` gets the new one.
 */
export function useDragReorder(order: string[], onChange: (next: string[]) => void, axis: 'x' | 'y' = 'y') {
  const phone = useIsPhone();
  const dragging = useRef<string | null>(null);
  const [over, setOver] = useState<{ id: string; after: boolean } | null>(null);
  const half = (e: DragEvent<HTMLElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return axis === 'y' ? e.clientY > r.top + r.height / 2 : e.clientX > r.left + r.width / 2;
  };
  return {
    over,
    bind: (id: string) => ({
      draggable: !phone,
      onDragStart: (e: DragEvent<HTMLElement>) => {
        dragging.current = id;
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', id);
      },
      onDragOver: (e: DragEvent<HTMLElement>) => {
        if (!dragging.current || dragging.current === id) return;
        e.preventDefault();
        setOver({ id, after: half(e) });
      },
      onDragLeave: () => setOver((o) => (o?.id === id ? null : o)),
      onDrop: (e: DragEvent<HTMLElement>) => {
        e.preventDefault();
        const from = dragging.current;
        const after = half(e);
        dragging.current = null;
        setOver(null);
        if (!from || from === id) return;
        const i = order.indexOf(id);
        const before = after ? (order[i + 1] ?? null) : id;
        onChange(moveBefore(order, from, before === from ? (order[i + 2] ?? null) : before));
      },
      onDragEnd: () => {
        dragging.current = null;
        setOver(null);
      },
    }),
  };
}

/** Small ▲▼ (or ◀▶) buttons: how you move something on a phone (nothing on wider screens, where you drag). */
export function MoveArrows({ onBack, onForward, first, last, label, horizontal = false }: { onBack: () => void; onForward: () => void; first: boolean; last: boolean; label: string; horizontal?: boolean }) {
  if (!useIsPhone()) return null; // desktop drags instead
  return (
    <span className="move-arrows">
      <button className="ghost icon" aria-label={`Move ${label} ${horizontal ? 'left' : 'up'}`} disabled={first} onClick={onBack}>
        {horizontal ? '◀' : '▲'}
      </button>
      <button className="ghost icon" aria-label={`Move ${label} ${horizontal ? 'right' : 'down'}`} disabled={last} onClick={onForward}>
        {horizontal ? '▶' : '▼'}
      </button>
    </span>
  );
}
