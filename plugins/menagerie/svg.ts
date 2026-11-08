// Generated portraits are SVG the app renders, so the model's SVG text never reaches the page as markup. parseSvg
// reads a small, strict subset (elements, quoted attributes, self-closing tags, whitespace; nothing else) into a
// JSON node tree, rejecting anything outside the allowlists; checkNodes re-validates a stored tree (the cast file can
// be edited or imported by hand). The renderer (render.ts) creates elements from the tree, never from text.

export type SvgNode = [tag: string, attrs: Record<string, string>, children?: SvgNode[]];

export const SVG_TAGS: ReadonlySet<string> = new Set([
  'g', 'path', 'circle', 'ellipse', 'rect', 'line', 'polyline', 'polygon', 'linearGradient', 'radialGradient', 'stop', 'defs',
]);

const NUMERIC = ['cx', 'cy', 'r', 'rx', 'ry', 'x', 'y', 'x1', 'y1', 'x2', 'y2', 'width', 'height', 'fx', 'fy', 'stroke-width'];
const UNIT = ['opacity', 'fill-opacity', 'stroke-opacity', 'stop-opacity'];
const PAINT = ['fill', 'stroke', 'stop-color'];
const ENUMS: Record<string, string[]> = {
  'stroke-linecap': ['butt', 'round', 'square'],
  'stroke-linejoin': ['miter', 'round', 'bevel'],
  'fill-rule': ['nonzero', 'evenodd'],
  gradientUnits: ['userSpaceOnUse', 'objectBoundingBox'],
};

/**
 * Rig marks: the only values `class` may take. The renderer turns each into the face rig's classes (eyes glance and
 * blink, brows move, three mouths swap, props animate), so moods and reactions work on any portrait.
 */
export const RIG_MARKS: ReadonlySet<string> = new Set([
  'brows', 'eyes', 'eyes-noblink', 'shades', 'mouth', 'mouth-rest', 'mouth-smile', 'mouth-o', 'prop1', 'prop2',
]);

export const SVG_ATTRS: ReadonlySet<string> = new Set([
  ...NUMERIC, ...UNIT, ...PAINT, ...Object.keys(ENUMS), 'd', 'points', 'transform', 'gradientTransform', 'id', 'offset', 'class',
]);

export const MAX_NODES = 400;
export const MAX_PATH_BYTES = 8 * 1024;
const COORD = { min: -64, max: 128 };

const COLOR_NAMES = new Set([
  'none', 'currentColor', 'black', 'silver', 'gray', 'white', 'maroon', 'red', 'purple', 'fuchsia', 'green', 'lime', 'olive', 'yellow',
  'navy', 'blue', 'teal', 'aqua',
]);
const HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
const URL_REF = /^url\(#([A-Za-z][A-Za-z0-9_-]{0,31})\)$/;
const ID = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/;
const NUMBER = /^-?(?:\d+\.?\d*|\.\d+)$/;
const NUMBERS = /-?(?:\d+\.?\d*|\.\d+)/g;

const inCoord = (n: number) => Number.isFinite(n) && n >= COORD.min && n <= COORD.max;

/** SVG's own transform syntax (unitless): translate, rotate (angle or angle cx cy), scale, skewX, skewY. */
function checkSvgTransform(s: string): string | null {
  const rules: Record<string, { args: number[]; min: number; max: number }> = {
    translate: { args: [1, 2], min: COORD.min, max: COORD.max },
    rotate: { args: [1, 3], min: -720, max: 720 },
    scale: { args: [1, 2], min: -4, max: 4 },
    skewX: { args: [1], min: -60, max: 60 },
    skewY: { args: [1], min: -60, max: 60 },
  };
  let rest = s.trim();
  if (!rest) return 'empty transform';
  while (rest) {
    const m = /^([a-zA-Z]+)\(([^()]*)\)\s*,?\s*/.exec(rest);
    if (!m) return `transform not allowed: ${s.slice(0, 40)}`;
    const rule = Object.hasOwn(rules, m[1]) ? rules[m[1]] : undefined;
    if (!rule) return `transform function not allowed: ${m[1]}`;
    const args = m[2].split(/[\s,]+/).filter(Boolean);
    if (!rule.args.includes(args.length)) return `transform ${m[1]}: wrong number of arguments`;
    for (const a of args) {
      if (!NUMBER.test(a)) return `transform ${m[1]}: bad number ${a}`;
      // rotate's centre point is a coordinate; its angle and the other functions use their own bounds.
      const n = Number(a);
      if (n < Math.min(rule.min, COORD.min) || n > Math.max(rule.max, COORD.max)) return `transform ${m[1]}: ${a} out of range`;
    }
    rest = rest.slice(m[0].length);
  }
  return null;
}

/** Why the attribute value is not allowed, or null. `refs` collects url(#id) references for checking afterwards. */
function checkAttr(tag: string, name: string, value: string, refs: Set<string>): string | null {
  if (!SVG_ATTRS.has(name)) return `attribute not allowed: ${name}`;
  if (value.length > MAX_PATH_BYTES) return `${name}: too long`;
  if (/[&<>"'\\]/.test(value)) return `${name}: characters not allowed`;
  if (NUMERIC.includes(name)) {
    if (!NUMBER.test(value.trim())) return `${name}: not a number`;
    if (!inCoord(Number(value))) return `${name}: out of range`;
    return null;
  }
  if (UNIT.includes(name) || (name === 'offset' && tag === 'stop')) {
    const v = value.trim().endsWith('%') ? Number(value.trim().slice(0, -1)) / 100 : Number(value.trim());
    return NUMBER.test(value.trim().replace(/%$/, '')) && v >= 0 && v <= 1 ? null : `${name}: must be 0–1`;
  }
  if (PAINT.includes(name)) {
    const v = value.trim();
    if (HEX.test(v) || COLOR_NAMES.has(v)) return null;
    const ref = URL_REF.exec(v);
    if (ref && name !== 'stop-color') {
      refs.add(ref[1]);
      return null;
    }
    return `${name}: colour not allowed`;
  }
  if (Object.hasOwn(ENUMS, name)) return ENUMS[name].includes(value.trim()) ? null : `${name}: not allowed`;
  if (name === 'd') {
    // No exponents: path commands and plain numbers only. Arc angles may reach ±360, so the bound is a little wider.
    if (!/^[MmLlHhVvCcSsQqTtAaZz0-9.,\s+-]*$/.test(value)) return 'd: path data characters not allowed';
    for (const n of value.match(NUMBERS) ?? []) if (!(Math.abs(Number(n)) <= 360)) return `d: ${n} out of range`;
    return null;
  }
  if (name === 'points') {
    if (!/^[0-9.,\s-]*$/.test(value)) return 'points: characters not allowed';
    for (const n of value.match(NUMBERS) ?? []) if (!inCoord(Number(n))) return `points: ${n} out of range`;
    return null;
  }
  if (name === 'transform' || name === 'gradientTransform') return checkSvgTransform(value);
  if (name === 'id') return ID.test(value) ? null : 'id: not allowed';
  if (name === 'class') return RIG_MARKS.has(value.trim()) ? null : `class: only rig marks (${[...RIG_MARKS].join(', ')})`;
  return `attribute not allowed: ${name}`;
}

const NAME = /^[a-zA-Z][a-zA-Z:-]*/;

/** Parses the strict subset; any construct outside it (text, comments, CDATA, entities, PIs) is an error. */
export function parseSvg(text: string): { ok: true; nodes: SvgNode[] } | { ok: false; error: string } {
  if (typeof text !== 'string') return { ok: false, error: 'not text' };
  const root: SvgNode[] = [];
  const stack: { tag: string; children: SvgNode[] }[] = [{ tag: '', children: root }];
  const refs = new Set<string>();
  const ids = new Set<string>();
  let count = 0;
  let pathBytes = 0;
  let i = 0;
  const fail = (error: string) => ({ ok: false as const, error });
  while (i < text.length) {
    const ws = /^\s+/.exec(text.slice(i));
    if (ws) {
      i += ws[0].length;
      continue;
    }
    if (text[i] !== '<') return fail(`text content not allowed near "${text.slice(i, i + 20)}"`);
    if (text.startsWith('</', i)) {
      const m = /^<\/([a-zA-Z][a-zA-Z:-]*)\s*>/.exec(text.slice(i));
      if (!m) return fail('bad closing tag');
      const top = stack.pop();
      if (!top || stack.length === 0 || top.tag !== m[1]) return fail(`mismatched closing tag </${m[1]}>`);
      i += m[0].length;
      continue;
    }
    const name = NAME.exec(text.slice(i + 1));
    if (!name) return fail(`markup not allowed near "${text.slice(i, i + 12)}"`);
    const tag = name[0];
    if (!SVG_TAGS.has(tag)) return fail(`element not allowed: <${tag}>`);
    i += 1 + tag.length;
    const attrs: Record<string, string> = {};
    for (;;) {
      const attr = /^\s+([a-zA-Z][a-zA-Z0-9:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/.exec(text.slice(i));
      if (attr) {
        const key = attr[1];
        const value = attr[2] ?? attr[3];
        if (Object.hasOwn(attrs, key)) return fail(`duplicate attribute: ${key}`);
        const err = checkAttr(tag, key, value, refs);
        if (err) return fail(err);
        if (key === 'd') pathBytes += value.length;
        if (key === 'id') ids.add(value);
        attrs[key] = value.trim();
        i += attr[0].length;
        continue;
      }
      const end = /^\s*(\/?)>/.exec(text.slice(i));
      if (!end) return fail(`bad attribute syntax in <${tag}> near "${text.slice(i, i + 30).trim()}" (quote every value)`);
      i += end[0].length;
      if (++count > MAX_NODES) return fail(`more than ${MAX_NODES} elements`);
      if (pathBytes > MAX_PATH_BYTES) return fail('too much path data');
      const node: SvgNode = [tag, attrs];
      stack[stack.length - 1].children.push(node);
      if (!end[1]) {
        node[2] = [];
        stack.push({ tag, children: node[2] });
      }
      break;
    }
  }
  if (stack.length !== 1) return fail(`unclosed <${stack[stack.length - 1].tag}>`);
  for (const r of refs) if (!ids.has(r)) return fail(`url(#${r}) names no gradient in this part`);
  return { ok: true, nodes: prune(root) };
}

/** Drops empty child arrays so trees compare cleanly (`<g></g>` and `<g/>` read the same). */
function prune(nodes: SvgNode[]): SvgNode[] {
  return nodes.map(([tag, attrs, children]) => (children && children.length ? [tag, attrs, prune(children)] : [tag, attrs]));
}

/** Every node carrying rig mark `mark`, depth first. */
export function findMarked(nodes: SvgNode[], mark: string, into: SvgNode[] = []): SvgNode[] {
  for (const n of nodes) {
    if (n[1].class === mark) into.push(n);
    if (n[2]) findMarked(n[2], mark, into);
  }
  return into;
}

/** The gradient ids a tree defines. */
export function definedIds(nodes: SvgNode[], into = new Set<string>()): Set<string> {
  for (const [, attrs, children] of nodes) {
    if (attrs.id) into.add(attrs.id);
    if (children) definedIds(children, into);
  }
  return into;
}

/**
 * Why a stored tree is not valid, or null. `gradientIds` are ids defined elsewhere in the same portrait (a gradient
 * in one layer may paint another); ids this tree defines count too.
 */
export function checkNodes(nodes: unknown, gradientIds: Set<string> = new Set()): string | null {
  if (!Array.isArray(nodes)) return 'not a node list';
  const refs = new Set<string>();
  let count = 0;
  let pathBytes = 0;
  const walk = (list: unknown[]): string | null => {
    for (const n of list) {
      if (!Array.isArray(n) || n.length < 2 || n.length > 3) return 'bad node';
      const [tag, attrs, children] = n as [unknown, unknown, unknown];
      if (typeof tag !== 'string' || !SVG_TAGS.has(tag)) return `element not allowed: ${String(tag)}`;
      if (typeof attrs !== 'object' || attrs === null || Array.isArray(attrs)) return 'bad attributes';
      for (const [k, v] of Object.entries(attrs)) {
        if (typeof v !== 'string') return `${k}: not a string`;
        const err = checkAttr(tag, k, v, refs);
        if (err) return err;
        if (k === 'd') pathBytes += v.length;
      }
      if (++count > MAX_NODES) return `more than ${MAX_NODES} elements`;
      if (children !== undefined) {
        if (!Array.isArray(children)) return 'bad children';
        const err = walk(children);
        if (err) return err;
      }
    }
    return null;
  };
  const err = walk(nodes);
  if (err) return err;
  if (pathBytes > MAX_PATH_BYTES) return 'too much path data';
  const ids = definedIds(nodes as SvgNode[], new Set(gradientIds));
  for (const r of refs) if (!ids.has(r)) return `url(#${r}) names no gradient`;
  return null;
}
