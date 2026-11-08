// Draws a portrait from its stored node tree with createElement: never from SVG text. Tag and attribute names are
// re-checked against svg.ts's allowlists (the server validated them already; this is the second line). Rig marks
// become the face rig's classes, which styles.css animates by mood and reaction.
import { createElement, type ReactNode } from 'react';
import type { FunHost } from './types.ts';
import { SVG_ATTRS, SVG_TAGS, type SvgNode } from './svg.ts';

/** SVG attribute → React prop (`stroke-width` → `strokeWidth`). */
const prop = (name: string) => (name === 'class' ? 'className' : name.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase()));

const MARK_CLASS: Record<string, string> = {
  brows: 'av-brows',
  eyes: 'av-eyes',
  'eyes-noblink': 'av-eyes',
  shades: 'av-shades',
  mouth: 'av-mouth',
  'mouth-rest': 'm-rest',
  'mouth-smile': 'm-smile',
  'mouth-o': 'm-o',
};

function propsOf(attrs: Record<string, string>, prefix: string, key: number): Record<string, unknown> {
  const out: Record<string, unknown> = { key };
  for (const [k, v] of Object.entries(attrs)) {
    if (!SVG_ATTRS.has(k) || k === 'class') continue;
    if (k === 'id') out.id = `${prefix}-${v}`;
    else out[prop(k)] = v.replace(/url\(#([A-Za-z][A-Za-z0-9_-]*)\)/g, `url(#${prefix}-$1)`);
  }
  return out;
}

/** React elements for `nodes`. `prefix` (the host id) keeps gradient ids from colliding across portraits. */
export function nodesToElements(nodes: SvgNode[], prefix: string): ReactNode[] {
  return nodes.map(([tag, attrs, children], i) => {
    if (!SVG_TAGS.has(tag)) return null;
    const props = propsOf(attrs ?? {}, prefix, i);
    const kids = children ? nodesToElements(children, prefix) : [];
    const mark = attrs?.class;
    if (mark === 'prop1' || mark === 'prop2') return createElement(tag, { ...props, className: `av-${prefix}-p${mark.slice(4)}` }, ...kids);
    if (!mark || !MARK_CLASS[mark]) return createElement(tag, props, ...kids);
    const className = MARK_CLASS[mark];
    // The resting mouth shows; the other two start hidden and CSS swaps them by mood.
    const hidden = mark === 'mouth-smile' || mark === 'mouth-o' ? { opacity: 0 } : {};
    if (mark !== 'eyes') return createElement(tag, { ...props, className, ...hidden }, ...kids);
    // Blinking eyes: glance on the outer group, blink on an inner one (so the two transforms don't fight).
    const inner = tag === 'g' ? kids : [createElement(tag, { ...props, key: 0 }, ...kids)];
    const outer = tag === 'g' ? props : { key: i };
    return createElement('g', { ...outer, className }, createElement('g', { className: 'av-blink' }, ...inner));
  });
}

/** The portrait's elements, to go inside a 64×64 `<svg>`. */
export const portraitElements = (host: FunHost): ReactNode[] => nodesToElements(host.portrait?.nodes ?? [], host.id);
