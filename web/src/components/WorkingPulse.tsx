import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';

export interface Working {
  /** Claude's spinner word, read off its screen ('' when not found). */
  quip: string;
  /** How fast the terminal is changing, 0 (still) to 1 (pouring out). */
  level: number;
}

/** How a host provider (the menagerie plugin) dresses the working bubble up; without one it's plain. */
export interface PulseDecor {
  /** Added to the `.pulse` element's classes. */
  className?: string;
  style?: CSSProperties;
  /** Drawn before the dots (a portrait). */
  lead?: ReactNode;
  /** The dots' colours, in turn. */
  dotColors?: string[];
  /** Spinner words for when Claude's own can't be read off its screen. */
  words?: string[];
  /** A ticker line under the row (repeated to fill it). */
  trim?: string;
}

const QUIPS = ['Working on it', 'Tinkering', 'Noodling', 'Cooking', 'Wrangling', 'Percolating', 'Rummaging'];

/**
 * Just "it's working": a quip with bouncing dots and a shimmer whose speed follows how fast the terminal is
 * changing. Driven by requestAnimationFrame so a pace change speeds up or slows down smoothly, without the
 * jump a changed CSS animation-duration causes.
 */
export function WorkingPulse({ working, decor }: { working: Working; decor?: PulseDecor }) {
  const level = useRef(working.level);
  level.current = working.level;
  const dots = useRef<Array<HTMLElement | null>>([]);
  const text = useRef<HTMLSpanElement | null>(null);
  const trim = useRef<HTMLSpanElement | null>(null);

  const fallback = decor?.words?.length ? decor.words : QUIPS;
  const [pick, setPick] = useState(() => Math.floor(Math.random() * fallback.length));
  useEffect(() => {
    if (working.quip) return;
    const t = setInterval(() => setPick((p) => p + 1), 7000);
    return () => clearInterval(t);
  }, [working.quip]);
  const quip = working.quip || fallback[pick % fallback.length];

  useEffect(() => {
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    let phase = 0;
    let shown = level.current;
    let last = performance.now();
    let raf = 0;
    const frame = (now: number) => {
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      shown += (level.current - shown) * Math.min(1, dt * 2); // ease towards the latest pace
      phase += dt * (0.25 + shown * 2.75); // cycles per second: a slow breath when idle, a buzz when busy
      dots.current.forEach((d, i) => {
        if (!d) return;
        const up = Math.max(0, Math.sin(2 * Math.PI * (phase - i * 0.16)));
        d.style.transform = `translateY(${(-4 * up).toFixed(2)}px)`;
        d.style.opacity = (0.35 + 0.65 * up).toFixed(2);
      });
      if (text.current) text.current.style.backgroundPosition = `${(-phase * 100) % 200}% 0`;
      if (trim.current) trim.current.style.transform = `translateX(${(-(phase * 6) % 50).toFixed(2)}%)`;
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, []);

  const halfTrim = decor?.trim ? decor.trim.repeat(Math.ceil(60 / decor.trim.length)) : '';
  const colors = decor?.dotColors;
  return (
    <span className={`pulse${decor?.className ? ` ${decor.className}` : ''}`} style={decor?.style}>
      <span className="pulse-row">
        {decor?.lead}
        <span className="pulse-dots" aria-hidden>
          {[0, 1, 2].map((i) => (
            <i key={i} ref={(el) => void (dots.current[i] = el)} style={colors ? { background: colors[i % colors.length] } : undefined} />
          ))}
        </span>
        <span className="pulse-text" ref={text}>
          {quip}…
        </span>
      </span>
      {halfTrim && (
        <span className="pulse-trim" aria-hidden>
          <span ref={trim}>{halfTrim + halfTrim}</span>
        </span>
      )}
    </span>
  );
}
