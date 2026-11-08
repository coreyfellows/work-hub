// A character's animations as data: the exit when its quip box leaves and up to two prop moves on its portrait.
// The model writes keyframes as JSON; nothing it writes reaches a stylesheet as text. Every value is parsed into
// numbers from an allowlist and the CSS is written from those (castCss), so a hostile frame can only be dropped.

export type Easing = 'linear' | 'ease' | 'ease-in' | 'ease-out' | 'ease-in-out' | 'steps(1)';
export const EASINGS: readonly Easing[] = ['linear', 'ease', 'ease-in', 'ease-out', 'ease-in-out', 'steps(1)'];

export type Origin =
  | 'center' | 'top' | 'bottom' | 'left' | 'right'
  | 'bottom left' | 'bottom right' | 'top left' | 'top right' | '50% 30%' | '50% 100%';
export const ORIGINS: readonly Origin[] = [
  'center', 'top', 'bottom', 'left', 'right', 'bottom left', 'bottom right', 'top left', 'top right', '50% 30%', '50% 100%',
];

export interface Frame {
  /** Percent through the animation, 0–100, strictly increasing. */
  at: number;
  transform?: string;
  opacity?: number;
  filter?: string;
  transformOrigin?: Origin;
}

export interface Keyframes {
  durationMs: number;
  easing?: Easing;
  frames: Frame[];
}

export interface Motion {
  /** Plays when the quip box leaves; ends invisible. */
  exit: Keyframes;
  /** Loops on the portrait's prop layers: index 0 animates slot 1, index 1 slot 2. */
  props?: Keyframes[];
}

export const EXIT_MS = { min: 800, max: 2500 } as const;
export const PROP_MS = { min: 800, max: 8000 } as const;
export const ID_RE = /^[a-z0-9-]{1,24}$/;

type Unit = '' | 'px' | 'deg' | '%';
interface FnRule {
  args: [number, number];
  units: Unit[];
  min: number;
  max: number;
}

const TRANSFORMS: Record<string, FnRule> = {
  translate: { args: [1, 2], units: ['px', '%'], min: -200, max: 200 },
  translateX: { args: [1, 1], units: ['px', '%'], min: -200, max: 200 },
  translateY: { args: [1, 1], units: ['px', '%'], min: -200, max: 200 },
  rotate: { args: [1, 1], units: ['deg'], min: -720, max: 720 },
  scale: { args: [1, 2], units: [''], min: 0, max: 4 },
  scaleX: { args: [1, 1], units: [''], min: 0, max: 4 },
  scaleY: { args: [1, 1], units: [''], min: 0, max: 4 },
  skew: { args: [1, 2], units: ['deg'], min: -60, max: 60 },
  skewX: { args: [1, 1], units: ['deg'], min: -60, max: 60 },
  skewY: { args: [1, 1], units: ['deg'], min: -60, max: 60 },
};

const FILTERS: Record<string, FnRule> = {
  blur: { args: [1, 1], units: ['px'], min: 0, max: 20 },
  brightness: { args: [1, 1], units: [''], min: 0, max: 8 },
  saturate: { args: [1, 1], units: [''], min: 0, max: 8 },
  sepia: { args: [1, 1], units: [''], min: 0, max: 8 },
  grayscale: { args: [1, 1], units: [''], min: 0, max: 1 },
  'hue-rotate': { args: [1, 1], units: ['deg'], min: -360, max: 360 },
};

const NUM = /^(-?(?:\d+\.?\d*|\.\d+))(px|deg|%)?$/;
const CALL = /^\s*([a-zA-Z-]+)\(([^()]*)\)/;

/** Rounds to 4 decimals and prints without exponent noise. */
const fmt = (n: number) => String(Math.round(n * 10_000) / 10_000);

function parseCalls(s: string, rules: Record<string, FnRule>): string | null {
  if (typeof s !== 'string' || s.length > 300) return null;
  if (s.trim() === 'none') return 'none';
  const out: string[] = [];
  let rest = s;
  while (rest.trim()) {
    const m = CALL.exec(rest);
    if (!m) return null;
    const rule = Object.hasOwn(rules, m[1]) ? rules[m[1]] : undefined;
    if (!rule) return null;
    const raw = m[2].split(/[\s,]+/).filter(Boolean);
    if (raw.length < rule.args[0] || raw.length > rule.args[1]) return null;
    const args: string[] = [];
    for (const a of raw) {
      const n = NUM.exec(a);
      if (!n) return null;
      const value = Number(n[1]);
      const unit = (n[2] ?? '') as Unit;
      // A bare 0 is fine for any unit; otherwise the unit must be one the function takes.
      if (!rule.units.includes(unit) && !(unit === '' && value === 0)) return null;
      if (!Number.isFinite(value) || value < rule.min || value > rule.max) return null;
      args.push(fmt(value) + unit);
    }
    out.push(`${m[1]}(${args.join(', ')})`);
    rest = rest.slice(m[0].length);
  }
  return out.length ? out.join(' ') : null;
}

/** A CSS transform built only from the allowlisted functions (normalised), or null. */
export const parseTransform = (s: string): string | null => parseCalls(s, TRANSFORMS);

/** A CSS filter built only from the allowlisted functions (normalised), or null. */
export const parseFilter = (s: string): string | null => parseCalls(s, FILTERS);

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Why `k` isn't a valid exit or prop animation, or null when it is. */
export function checkKeyframes(k: unknown, kind: 'exit' | 'prop'): string | null {
  if (!isObj(k)) return `${kind}: not an object`;
  const range = kind === 'exit' ? EXIT_MS : PROP_MS;
  if (typeof k.durationMs !== 'number' || !Number.isFinite(k.durationMs) || k.durationMs < range.min || k.durationMs > range.max)
    return `${kind}: durationMs must be ${range.min}–${range.max}`;
  if (k.easing !== undefined && !EASINGS.includes(k.easing as Easing)) return `${kind}: easing must be one of ${EASINGS.join(', ')}`;
  if (!Array.isArray(k.frames) || k.frames.length < 2 || k.frames.length > 20) return `${kind}: frames must be 2–20 frames`;
  let last = -1;
  for (const [i, f] of k.frames.entries()) {
    if (!isObj(f)) return `${kind}: frame ${i} is not an object`;
    if (typeof f.at !== 'number' || f.at < 0 || f.at > 100 || f.at <= last) return `${kind}: frame ${i} "at" must be 0–100 and increasing`;
    last = f.at;
    if (f.transform !== undefined && (typeof f.transform !== 'string' || parseTransform(f.transform) === null))
      return `${kind}: frame ${i} transform not allowed`;
    if (f.filter !== undefined && (typeof f.filter !== 'string' || parseFilter(f.filter) === null)) return `${kind}: frame ${i} filter not allowed`;
    if (f.opacity !== undefined && (typeof f.opacity !== 'number' || f.opacity < 0 || f.opacity > 1)) return `${kind}: frame ${i} opacity must be 0–1`;
    if (f.transformOrigin !== undefined && !ORIGINS.includes(f.transformOrigin as Origin)) return `${kind}: frame ${i} transformOrigin not allowed`;
  }
  const frames = k.frames as Frame[];
  if (frames[0].at !== 0 || frames[frames.length - 1].at !== 100) return `${kind}: frames must start at 0 and end at 100`;
  if (kind === 'exit' && frames[frames.length - 1].opacity !== 0) return 'exit: the last frame must have opacity 0';
  return null;
}

/** Why `m` isn't a valid motion, or null. */
export function checkMotion(m: unknown): string | null {
  if (!isObj(m)) return 'motion: not an object';
  const exit = checkKeyframes(m.exit, 'exit');
  if (exit) return exit;
  if (m.props === undefined) return null;
  if (!Array.isArray(m.props) || m.props.length > 2) return 'motion: props must be at most 2';
  for (const p of m.props) {
    const e = checkKeyframes(p, 'prop');
    if (e) return e;
  }
  return null;
}

function frameCss(f: Frame): string {
  const decl: string[] = [];
  if (f.transform !== undefined) decl.push(`transform: ${parseTransform(f.transform)};`);
  if (f.opacity !== undefined) decl.push(`opacity: ${fmt(f.opacity)};`);
  if (f.filter !== undefined) decl.push(`filter: ${parseFilter(f.filter)};`);
  return `${fmt(f.at)}% { ${decl.join(' ')} }`;
}

const keyframesCss = (name: string, k: Keyframes) => `@keyframes ${name} { ${k.frames.map(frameCss).join(' ')} }`;
const originOf = (k: Keyframes) => k.frames.find((f) => f.transformOrigin)?.transformOrigin;

/**
 * The stylesheet for the cast's animations: per character `.quip-bye-<id>` (duration and keyframes for the quip
 * exit) and `.av-<id>-p<slot>` (prop moves, only when motion isn't reduced). Keyframe names carry an `mh-` prefix so
 * a host's id can never replace one of the stylesheet's own (`bye-fade`, the reduced-motion exit). A character whose id or motion doesn't
 * validate is left out entirely.
 */
export function castCss(chars: { id: string; motion: Motion }[]): string {
  const out: string[] = [];
  for (const c of chars) {
    if (typeof c.id !== 'string' || !ID_RE.test(c.id) || checkMotion(c.motion)) continue;
    const { exit, props = [] } = c.motion;
    out.push(`.quip-bye-${c.id} { --bye: ${fmt(exit.durationMs)}ms; --bye-anim: mh-bye-${c.id}; }`);
    const exitOrigin = originOf(exit);
    if (exitOrigin) out.push(`.quip-bye-${c.id} .quip-inner { transform-origin: ${exitOrigin}; }`);
    out.push(keyframesCss(`mh-bye-${c.id}`, exit));
    if (props.length) {
      const inner = props.map((p, i) => {
        const cls = `av-${c.id}-p${i + 1}`;
        const name = `mh-${cls}`;
        const origin = originOf(p);
        return `.fun-avatar .${cls} { ${origin ? `transform-origin: ${origin}; ` : ''}animation: ${name} ${fmt(p.durationMs)}ms ${p.easing ?? 'ease-in-out'} infinite; } ${keyframesCss(name, p)}`;
      });
      out.push(`@media (prefers-reduced-motion: no-preference) { ${inner.join(' ')} }`);
    }
  }
  return out.join('\n');
}
