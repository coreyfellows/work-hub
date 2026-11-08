import type { Motion } from './keyframes.ts';
import type { Character, Portrait } from './cast.ts';

/** What the UI needs to draw a host (served by GET /api/menagerie/hosts, built by toFunHost in cast.ts). */
export interface FunHost {
  id: string;
  name: string;
  emoji: string;
  color: string;
  letters: string[];
  mode: 'wave' | 'flicker' | 'stack' | 'fade' | 'marquee' | 'still';
  borderColors: string[];
  trim?: string;
  trimColors?: string[];
  text: string;
  /** Words the host swaps in for Claude's spinner while a turn runs. */
  spinner: string[];
  /** Said above a question, in the host's voice. */
  asks: string[];
  portrait: Portrait;
  motion: Motion;
  origin: Character['origin'];
  /** A short label before the name on the aside card. */
  badge?: string;
  /** Shows up only now and then. */
  rare?: boolean;
  /** The last regenerate can be undone. */
  canUndo?: boolean;
}

/** A host's closing aside, peeled off an assistant message (splitAside). */
export interface Aside {
  host: FunHost;
  text: string;
}
