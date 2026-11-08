import { useEffect, useRef, useState } from 'react';
import { Link } from '../../plugin-api/web.ts';
import { useFunHosts, type FunHost } from './menagerie.ts';
import { HostInContext } from './parts.tsx';
import { HostAvatar, REACT_MS, type AvatarMood, type AvatarReaction } from './HostAvatar.tsx';

/**
 * /settings/faces: every host's portrait in every mood and reaction, for checking the animations. Pure CSS
 * animation, nothing fetched or polled. Speed changes playbackRate on every animation inside the page.
 */
const MOODS: [AvatarMood, string][] = [
  ['idle', 'idle · Settings'],
  ['thinking', 'thinking · working bubble'],
  ['curious', 'curious · questions'],
  ['pleased', 'pleased · asides'],
];
const REACTIONS: [AvatarReaction, AvatarMood, string][] = [
  ['nod', 'thinking', 'nod · picked up your message'],
  ['alarm', 'curious', 'alarm · needs you'],
  ['delight', 'pleased', 'delight · reply landed'],
];
const SIZES = [26, 30, 44, 72, 120];
const SPEEDS: [number, string][] = [
  [0, '⏸'],
  [0.25, '¼×'],
  [0.5, '½×'],
  [1, '1×'],
];
const LOOP_MS = 3500;

function useReducedMotion(): boolean {
  const [on, setOn] = useState(() => matchMedia('(prefers-reduced-motion: reduce)').matches);
  useEffect(() => {
    const m = matchMedia('(prefers-reduced-motion: reduce)');
    const f = () => setOn(m.matches);
    m.addEventListener('change', f);
    return () => m.removeEventListener('change', f);
  }, []);
  return on;
}

function Face({ host, size, mood, react, reactFor, caption }: {
  host: FunHost;
  size: number;
  mood: AvatarMood;
  react?: AvatarReaction;
  reactFor?: number;
  caption: string;
}) {
  return (
    <figure className="faces-cell" style={{ '--fun-color': host.color } as React.CSSProperties}>
      <HostAvatar host={host} size={size} mood={mood} react={react} reactFor={reactFor} />
      <figcaption>{caption}</figcaption>
    </figure>
  );
}

export function FacesPage() {
  const hosts = useFunHosts();
  const reduced = useReducedMotion();
  const [size, setSize] = useState(72);
  const [speed, setSpeed] = useState(1);
  const [replay, setReplay] = useState(0);
  const [loop, setLoop] = useState(false);
  const [ctxHost, setCtxHost] = useState('');
  const root = useRef<HTMLDivElement>(null);

  // CSS animations start at 1× (including ones a replay or a class change starts), so keep re-applying the rate.
  useEffect(() => {
    const apply = () => root.current?.getAnimations({ subtree: true }).forEach((a) => (a.playbackRate = speed));
    apply();
    if (speed === 1) return;
    const t = setInterval(apply, 200);
    return () => clearInterval(t);
  }, [speed, replay, size]);

  useEffect(() => {
    if (!loop || speed === 0) return;
    const t = setInterval(() => setReplay((n) => n + 1), LOOP_MS / speed);
    return () => clearInterval(t);
  }, [loop, speed]);

  const inContext = hosts.find((h) => h.id === ctxHost) ?? hosts[0];

  // Keep the reaction class on for as long as the reaction takes at this speed (forever while paused).
  const reactFor = speed === 0 ? Infinity : REACT_MS / speed;

  return (
    <div className="page faces-page" ref={root}>
      <Link to="/settings" className="back">
        ← Settings
      </Link>
      <h2>Host faces</h2>
      {reduced && (
        <p className="muted">
          This device asks for reduced motion, so the faces stay still everywhere, here too. Turn off “Reduce motion”
          in the system settings to see them move.
        </p>
      )}
      <div className="faces-controls">
        <div className="seg small-seg">
          {SIZES.map((s) => (
            <button key={s} className={size === s ? 'on' : ''} onClick={() => setSize(s)}>
              {s}px
            </button>
          ))}
        </div>
        <div className="seg small-seg" title="Playback speed">
          {SPEEDS.map(([v, label]) => (
            <button key={v} className={speed === v ? 'on' : ''} onClick={() => setSpeed(v)}>
              {label}
            </button>
          ))}
        </div>
        <button className="small" onClick={() => setReplay((n) => n + 1)}>
          ↻ Replay reactions
        </button>
        <label className="readable-toggle">
          <input type="checkbox" checked={loop} onChange={(e) => setLoop(e.target.checked)} />
          Loop reactions
        </label>
      </div>
      <p className="muted">
        The app uses 26px in the working bubble, 30px on questions, 36px here in Settings and 44px on asides; small
        faces move further. Every face also blinks and has one move of its own.
      </p>

      {inContext && (
        <section className="block">
          <h3>In context (the real log pieces, sample content)</h3>
          <div className="seg small-seg faces-hosts">
            {hosts.map((h) => (
              <button key={h.id} className={inContext.id === h.id ? 'on' : ''} onClick={() => setCtxHost(h.id)}>
                {h.name}
              </button>
            ))}
          </div>
          <HostInContext key={`${inContext.id}-${replay}`} host={inContext} />
        </section>
      )}

      <section className="block">
        <h3>Moods (loop for as long as the face is on screen)</h3>
        {hosts.map((h) => (
          <div key={h.id} className="faces-row">
            <div className="faces-name">{h.name}</div>
            <div className="faces-cells">
              {MOODS.map(([m, caption]) => (
                <Face key={m} host={h} size={size} mood={m} caption={caption} />
              ))}
            </div>
          </div>
        ))}
      </section>

      <section className="block">
        <h3>Reactions (once when the face appears, then its mood)</h3>
        {hosts.map((h) => (
          <div key={h.id} className="faces-row">
            <div className="faces-name">{h.name}</div>
            <div className="faces-cells">
              {REACTIONS.map(([r, m, caption]) => (
                <Face key={`${r}-${replay}`} host={h} size={size} mood={m} react={r} reactFor={reactFor} caption={caption} />
              ))}
            </div>
          </div>
        ))}
      </section>
    </div>
  );
}
