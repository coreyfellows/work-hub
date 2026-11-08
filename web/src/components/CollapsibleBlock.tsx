import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';

/**
 * A Details section that starts cut to `maxPx` (with a fade). Its Expand / Collapse button lives in the heading row, so it
 * never moves when the content grows or shrinks and can be clicked again at once. No button when everything already fits.
 */
export function CollapsibleBlock({ title, children, maxPx = 120 }: { title: ReactNode; children: ReactNode; maxPx?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const [long, setLong] = useState(false);
  const [open, setOpen] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setLong(el.scrollHeight > maxPx + 24);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [maxPx]);
  const clamped = long && !open;
  return (
    <section className="block">
      <div className="block-head">
        <h3>{title}</h3>
        {long && (
          <button className="ghost small" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
            {open ? 'Collapse ▴' : 'Expand ▾'}
          </button>
        )}
      </div>
      <div ref={ref} className={clamped ? 'clamp clamped' : 'clamp'} style={clamped ? { maxHeight: maxPx } : undefined}>
        {children}
      </div>
    </section>
  );
}
