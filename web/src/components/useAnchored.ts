import { useLayoutEffect, useState, type CSSProperties, type RefObject } from 'react';

const GAP = 6;
const EDGE = 8;

/**
 * Fixed-position style for a floating box under `anchor` (flipped above when there's no room, aligned to
 * the anchor's right edge when `alignRight`), kept 8px inside the viewport. Re-measured on resize and scroll.
 */
export function useAnchored(
  open: boolean,
  anchor: RefObject<HTMLElement | null>,
  box: RefObject<HTMLElement | null>,
  alignRight = false,
): CSSProperties {
  const [style, setStyle] = useState<CSSProperties>({ position: 'fixed', top: 0, left: 0, visibility: 'hidden' });
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const a = anchor.current?.getBoundingClientRect();
      const b = box.current?.getBoundingClientRect();
      if (!a || !b) return;
      const vw = document.documentElement.clientWidth;
      const vh = window.innerHeight;
      let top = a.bottom + GAP;
      if (top + b.height > vh - EDGE && a.top - GAP - b.height >= EDGE) top = a.top - GAP - b.height;
      top = Math.max(EDGE, Math.min(top, vh - EDGE - b.height));
      let left = alignRight ? a.right - b.width : a.left;
      left = Math.max(EDGE, Math.min(left, vw - EDGE - b.width));
      setStyle({ position: 'fixed', top, left, visibility: 'visible' });
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open, anchor, box, alignRight]);
  return style;
}
