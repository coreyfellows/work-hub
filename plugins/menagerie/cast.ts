// The cast file's schema: one validator for every read and write (generated, imported, hand-edited), so nothing
// gets into the app that hasn't been checked. The mod (claude/hooks/logic.ts parseCast) applies the basic rules
// (id, name and voice length, unique id and emoji) itself, as it can't import this file. Pure: shared by the server and the web half.
import { checkMotion, ID_RE, type Motion } from './keyframes.ts';
import { checkNodes, findMarked, type SvgNode } from './svg.ts';
import type { FunHost } from './types.ts';

export type { Motion, SvgNode };

export type Mode = 'wave' | 'flicker' | 'stack' | 'fade' | 'marquee' | 'still';
export const MODES: readonly Mode[] = ['wave', 'flicker', 'stack', 'fade', 'marquee', 'still'];

/**
 * A 64×64 portrait as one SVG tree. Nodes carry rig marks in `class` (svg.ts RIG_MARKS): one `eyes`, `eyes-noblink`
 * or `shades` group; at most one `brows`; at most one `mouth` holding a `mouth-rest`, `mouth-smile` and `mouth-o`;
 * at most one `prop1` and one `prop2`, animated by `motion.props`. Marks can nest (a glint inside shades, eyes on a
 * flapping wing), which is why this is a tree with marks and not a fixed list of parts.
 */
export interface Portrait {
  nodes: SvgNode[];
  /** Caps how far eyes and brows travel on small faces when the eyes sit in a frame (glasses, shades). */
  ampCap?: number;
}

export interface Palette {
  letters: string[];
  borderColors: string[];
  trim?: string;
  trimColors?: string[];
  text: string;
}

export interface Character {
  id: string;
  name: string;
  emoji: string;
  origin: { named: string; kind: 'play' | 'inspired' };
  rare?: boolean;
  voice: string;
  color: string;
  palette: Palette;
  mode: Mode;
  badge?: string;
  asks: string[];
  spinner: string[];
  portrait: Portrait;
  motion: Motion;
  /** The character before its last regenerate: one step of undo. */
  previous?: Omit<Character, 'previous'>;
  createdAt: number;
  updatedAt: number;
}

export interface CastFile {
  version: 1;
  characters: Character[];
}

export const LIMITS = {
  name: 40,
  named: 60,
  voice: 600,
  badge: 12,
  asks: { min: 1, max: 8, len: 40 },
  spinner: { min: 1, max: 12, len: 40 },
  colors: 8,
  trim: 40,
} as const;

const HEX6 = /^#[0-9a-fA-F]{6}$/;
const EMOJI = /\p{Extended_Pictographic}/u;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown, max: number, min = 1): v is string => typeof v === 'string' && v.trim().length >= min && v.length <= max;
const strList = (v: unknown, min: number, max: number, len: number): v is string[] =>
  Array.isArray(v) && v.length >= min && v.length <= max && v.every((s) => str(s, len));
const hexList = (v: unknown, min = 1): v is string[] =>
  Array.isArray(v) && v.length >= min && v.length <= LIMITS.colors && v.every((c) => typeof c === 'string' && HEX6.test(c));

/**
 * Why the portrait is invalid (a list), empty when it's fine. `complete` (generated portraits) also requires brows
 * and a mouth; stored and imported ones may do without (a moth has neither).
 */
export function portraitErrors(p: unknown, opts: { complete?: boolean } = {}): string[] {
  if (!isObj(p)) return ['portrait: missing'];
  const err = checkNodes(p.nodes);
  if (err) return [`portrait: ${err}`];
  const nodes = p.nodes as SvgNode[];
  const errors: string[] = [];
  const n = (mark: string) => findMarked(nodes, mark).length;
  if (n('eyes') + n('eyes-noblink') + n('shades') !== 1) errors.push('portrait: needs exactly one eyes, eyes-noblink or shades group');
  if (n('brows') > 1 || (opts.complete && n('brows') !== 1)) errors.push(`portrait: needs ${opts.complete ? 'exactly' : 'at most'} one brows group`);
  if (n('mouth') > 1 || (opts.complete && n('mouth') !== 1)) errors.push(`portrait: needs ${opts.complete ? 'exactly' : 'at most'} one mouth group`);
  const mouth = findMarked(nodes, 'mouth')[0];
  for (const m of ['mouth-rest', 'mouth-smile', 'mouth-o']) {
    const inside = mouth ? findMarked(mouth[2] ?? [], m).length : 0;
    if (n(m) !== (mouth ? 1 : 0) || inside !== n(m)) errors.push(`portrait: ${m} must appear once, inside the mouth group`);
  }
  for (const m of ['prop1', 'prop2']) if (n(m) > 1) errors.push(`portrait: at most one ${m}`);
  if (p.ampCap !== undefined && (typeof p.ampCap !== 'number' || p.ampCap < 0.5 || p.ampCap > 3)) errors.push('portrait: ampCap must be 0.5–3');
  return errors;
}

/** Copies only the known fields, so stray keys from a model or a hand edit never ride along. */
function pick(c: Record<string, unknown>): Omit<Character, 'previous'> {
  const p = c.palette as Record<string, unknown>;
  const portrait = c.portrait as Record<string, unknown>;
  const origin = c.origin as Record<string, unknown>;
  return {
    id: c.id as string,
    name: (c.name as string).trim(),
    emoji: (c.emoji as string).trim(),
    origin: { named: (origin.named as string).trim(), kind: origin.kind as 'play' | 'inspired' },
    ...(c.rare === true && { rare: true }),
    voice: (c.voice as string).trim(),
    color: c.color as string,
    palette: {
      letters: p.letters as string[],
      borderColors: p.borderColors as string[],
      ...(p.trim !== undefined && { trim: p.trim as string }),
      ...(p.trimColors !== undefined && { trimColors: p.trimColors as string[] }),
      text: p.text as string,
    },
    mode: c.mode as Mode,
    ...(c.badge !== undefined && { badge: c.badge as string }),
    asks: (c.asks as string[]).map((s) => s.trim()),
    spinner: (c.spinner as string[]).map((s) => s.trim()),
    portrait: { nodes: portrait.nodes as SvgNode[], ...(portrait.ampCap !== undefined && { ampCap: portrait.ampCap as number }) },
    motion: c.motion as Motion,
    createdAt: c.createdAt as number,
    updatedAt: c.updatedAt as number,
  };
}

function characterErrors(c: Record<string, unknown>): string[] {
  const e: string[] = [];
  if (typeof c.id !== 'string' || !ID_RE.test(c.id)) e.push('id: must match [a-z0-9-]{1,24}');
  if (!str(c.name, LIMITS.name)) e.push(`name: 1–${LIMITS.name} characters`);
  if (typeof c.emoji !== 'string' || c.emoji.length > 16 || !EMOJI.test(c.emoji) || /[\s>*]/.test(c.emoji.trim())) e.push('emoji: one emoji');
  const o = c.origin;
  if (!isObj(o) || !str(o.named, LIMITS.named) || (o.kind !== 'play' && o.kind !== 'inspired')) e.push('origin: { named, kind: play | inspired }');
  if (c.rare !== undefined && typeof c.rare !== 'boolean') e.push('rare: a boolean');
  if (!str(c.voice, LIMITS.voice)) e.push(`voice: 1–${LIMITS.voice} characters`);
  if (typeof c.color !== 'string' || !HEX6.test(c.color)) e.push('color: #rrggbb');
  const p = c.palette;
  if (
    !isObj(p) ||
    !hexList(p.letters) ||
    !hexList(p.borderColors) ||
    typeof p.text !== 'string' ||
    !HEX6.test(p.text) ||
    (p.trim !== undefined && !str(p.trim, LIMITS.trim)) ||
    (p.trimColors !== undefined && !hexList(p.trimColors))
  )
    e.push('palette: letters, borderColors, text as #rrggbb (trim ≤ 40 chars, trimColors optional)');
  if (!MODES.includes(c.mode as Mode)) e.push(`mode: one of ${MODES.join(', ')}`);
  if (c.badge !== undefined && !str(c.badge, LIMITS.badge)) e.push(`badge: 1–${LIMITS.badge} characters`);
  if (!strList(c.asks, LIMITS.asks.min, LIMITS.asks.max, LIMITS.asks.len)) e.push(`asks: ${LIMITS.asks.min}–${LIMITS.asks.max} lines of ≤ ${LIMITS.asks.len} characters`);
  if (!strList(c.spinner, LIMITS.spinner.min, LIMITS.spinner.max, LIMITS.spinner.len))
    e.push(`spinner: ${LIMITS.spinner.min}–${LIMITS.spinner.max} entries of ≤ ${LIMITS.spinner.len} characters`);
  e.push(...portraitErrors(c.portrait));
  const m = checkMotion(c.motion);
  if (m) e.push(m);
  if (typeof c.createdAt !== 'number' || typeof c.updatedAt !== 'number') e.push('createdAt/updatedAt: numbers');
  return e;
}

/**
 * Checks a character (and that its id and emoji differ from `others`'). Returns a clean copy with only the known
 * fields. An invalid `previous` snapshot is dropped rather than failing the character.
 */
export function validateCharacter(c: unknown, others: Character[] = []): { ok: true; value: Character } | { ok: false; errors: string[] } {
  if (!isObj(c)) return { ok: false, errors: ['not an object'] };
  const errors = characterErrors(c);
  if (!errors.length) {
    if (others.some((o) => o.id === c.id)) errors.push(`id: "${String(c.id)}" is already in the cast`);
    if (others.some((o) => o.emoji === (c.emoji as string).trim())) errors.push(`emoji: ${String(c.emoji)} is already used by another character`);
  }
  if (errors.length) return { ok: false, errors };
  const value: Character = pick(c);
  if (isObj(c.previous) && !characterErrors(c.previous).length && c.previous.id === c.id) value.previous = pick(c.previous);
  return { ok: true, value };
}

/** A cast from parsed JSON: the valid characters in order (first wins on a clash), and what was dropped and why. */
export function validateCast(raw: unknown): { cast: CastFile; dropped: { id?: string; errors: string[] }[] } {
  const cast: CastFile = { version: 1, characters: [] };
  const dropped: { id?: string; errors: string[] }[] = [];
  if (!isObj(raw) || !Array.isArray(raw.characters)) return { cast, dropped };
  for (const c of raw.characters) {
    const r = validateCharacter(c, cast.characters);
    if (r.ok) cast.characters.push(r.value);
    else dropped.push({ id: isObj(c) && typeof c.id === 'string' ? c.id : undefined, errors: r.errors });
  }
  return { cast, dropped };
}

/** An id from a name: lowercase slug, ≤ 24 chars, `-2`, `-3`… when taken. */
export function slugId(name: string, taken: Set<string>): string {
  const base =
    name
      .normalize('NFKD')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 20)
      .replace(/-+$/, '') || 'host';
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
}

/** What the UI draws a host with (the voice stays on the server and in the mod). */
export function toFunHost(c: Character): FunHost {
  return {
    id: c.id,
    name: c.name,
    emoji: c.emoji,
    color: c.color,
    letters: c.palette.letters,
    mode: c.mode,
    borderColors: c.palette.borderColors,
    trim: c.palette.trim,
    trimColors: c.palette.trimColors,
    text: c.palette.text,
    spinner: c.spinner,
    asks: c.asks,
    portrait: c.portrait,
    motion: c.motion,
    origin: c.origin,
    ...(c.badge && { badge: c.badge }),
    ...(c.rare && { rare: true }),
    ...(c.previous && { canUndo: true }),
  };
}
