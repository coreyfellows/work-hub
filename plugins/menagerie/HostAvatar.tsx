import { useEffect, useState } from 'react';
import { portraitElements } from './render.ts';
import type { FunHost } from './types.ts';

// A host's portrait (64×64, clipped to a circle by CSS), drawn from the cast file's node tree (render.ts). A host
// without one falls back to their emoji. Faces animate by mood (see AvatarMood) through the rig marks: eyes glance
// and blink, brows move, three mouths swap, and props loop with the host's own keyframes (castCss in keyframes.ts).

/**
 * What the face is doing. idle: glances around, smiles, looks surprised now and then. thinking (working bubble):
 * looks up, then scans as if reading, "aha" smile. curious (questions): cocked brow, "o", eyes on you.
 * pleased (asides): grin, brow wiggle, smug sideways glance.
 */
export type AvatarMood = 'idle' | 'thinking' | 'curious' | 'pleased';

/** A stable per-host offset so a row of idle faces doesn't move in lockstep. */
const phase = (id: string) => -([...id].reduce((n, c) => n * 31 + c.charCodeAt(0), 7) % 9000) / 1000;

/**
 * A one-off reaction played when the face first appears, before its mood loop takes over. nod: Claude picked up
 * your message (working bubble). alarm: it needs you (a question). delight: a reply landed (an aside card).
 */
export type AvatarReaction = 'nod' | 'alarm' | 'delight';
export const REACT_MS = 1500; // ≥ the longest av-r-* animation in styles.css

export function HostAvatar({
  host,
  size = 40,
  mood = 'idle',
  react,
  reactFor = REACT_MS,
}: {
  host: FunHost;
  size?: number;
  mood?: AvatarMood;
  react?: AvatarReaction;
  /** How long the reaction class stays on (the faces test page stretches it for slow motion; Infinity = until unmount). */
  reactFor?: number;
}) {
  const drawn = host.portrait?.nodes?.length ? portraitElements(host) : null;
  const [reacting, setReacting] = useState(!!react);
  useEffect(() => {
    if (!reacting || reactFor === Infinity) return;
    const t = setTimeout(() => setReacting(false), reactFor);
    return () => clearTimeout(t);
  }, [reacting, reactFor]);
  if (!drawn)
    return (
      <span className="fun-avatar emoji" style={{ width: size, height: size, fontSize: size * 0.55 }} aria-hidden>
        {host.emoji}
      </span>
    );
  return (
    <svg
      className={`fun-avatar mood-${mood}${size <= 30 ? ' av-small' : ''}${reacting && react ? ` react-${react}` : ''}`}
      style={
        {
          '--av-phase': `${mood === 'idle' ? phase(host.id) : 0}s`,
          // How far eyes and brows move: a 26px face needs about twice the travel to read at all.
          '--av-amp': Math.min(size <= 26 ? 2 : size <= 30 ? 1.7 : size <= 40 ? 1.25 : 1, host.portrait?.ampCap ?? 9),
        } as React.CSSProperties
      }
      width={size}
      height={size}
      viewBox="0 0 64 64"
      role="img"
      aria-label={host.name}
    >
      {drawn}
    </svg>
  );
}

/** Above a question: the host's portrait, name and one of their question lines (pick it with askLine). */
export function AskHeader({ host, line }: { host: FunHost; line?: string }) {
  return (
    <div className="fun-ask-head">
      <HostAvatar host={host} size={30} mood="curious" react="alarm" />
      <div className="fun-words">
        <div className="fun-name">
          {host.badge && <span className="fun-badge">{host.badge}</span>}
          {host.name}
        </div>
        {line && <div className="fun-ask-line">{line}</div>}
      </div>
    </div>
  );
}
