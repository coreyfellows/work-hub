// A tiny valid character for tests (not one of anybody's cast). Not a test file itself: tests import it.
import type { Character } from './cast.ts';

export function fixtureCharacter(over: Partial<Character> = {}): Character {
  return {
    id: 'zed',
    name: 'Zed the Lighthouse Keeper',
    emoji: '🗼',
    origin: { named: 'a lighthouse keeper', kind: 'inspired' },
    voice: 'A weathered lighthouse keeper who narrates everything like a sports commentator.',
    color: '#3a86ff',
    palette: { letters: ['#3a86ff', '#ffbe0b'], borderColors: ['#3a86ff', '#ffbe0b'], text: '#f4f4f4' },
    mode: 'wave',
    asks: ['Which way, skipper?', 'Signal me, sailor.', 'Fog rolling in. Pick:', 'Lamp or log?'],
    spinner: ['Polishing the lens', 'Counting gulls', 'Winding the clock', 'Logging the tide', 'Scanning the swell', 'Trimming the wick'],
    portrait: {
      nodes: [
        ['rect', { width: '64', height: '64', fill: '#1d3557' }],
        ['circle', { cx: '32', cy: '28', r: '12', fill: '#f1c27d' }],
        ['g', { class: 'brows' }, [['path', { d: 'M24 23 Q27 22 30 23', stroke: '#333', fill: 'none' }]]],
        ['g', { class: 'eyes' }, [['circle', { cx: '27', cy: '27', r: '1.6', fill: '#111' }], ['circle', { cx: '37', cy: '27', r: '1.6', fill: '#111' }]]],
        [
          'g',
          { class: 'mouth' },
          [
            ['g', { class: 'mouth-rest' }, [['path', { d: 'M29 38 Q32 40 35 38', stroke: '#111', fill: 'none' }]]],
            ['g', { class: 'mouth-smile' }, [['path', { d: 'M28 38 Q32 42 36 38', stroke: '#111', fill: 'none' }]]],
            ['g', { class: 'mouth-o' }, [['ellipse', { cx: '32', cy: '39', rx: '1.3', ry: '1.5', fill: '#111' }]]],
          ],
        ],
        ['rect', { class: 'prop1', x: '44', y: '40', width: '6', height: '12', fill: '#ffbe0b' }],
      ],
    },
    motion: {
      exit: { durationMs: 1500, frames: [{ at: 0, transform: 'none' }, { at: 100, transform: 'translateY(-40%)', opacity: 0 }] },
      props: [{ durationMs: 3000, frames: [{ at: 0, opacity: 1 }, { at: 50, opacity: 0.4 }, { at: 100, opacity: 1 }] }],
    },
    createdAt: 1,
    updatedAt: 1,
    ...over,
  };
}
