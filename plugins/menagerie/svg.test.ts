import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkNodes, parseSvg } from './svg.ts';

const ok = (text: string) => {
  const r = parseSvg(text);
  assert.ok(r.ok, `expected ok, got ${!r.ok && r.error}`);
  return r.nodes;
};
const bad = (text: string) => {
  const r = parseSvg(text);
  assert.ok(!r.ok, `expected rejection: ${text}`);
  assert.ok(r.error.length > 0);
};

test('parseSvg: a self-closing path', () => {
  assert.deepEqual(ok('<path d="M0 0 L10 10" fill="#fff"/>'), [['path', { d: 'M0 0 L10 10', fill: '#fff' }]]);
});

test('parseSvg: nested children and whitespace', () => {
  assert.deepEqual(ok(' <g opacity=".5">\n  <circle cx="1" cy="2" r="3" />\n</g> '), [
    ['g', { opacity: '.5' }, [['circle', { cx: '1', cy: '2', r: '3' }]]],
  ]);
});

test('parseSvg: attribute names with digits (line x1 y1 x2 y2)', () => {
  assert.deepEqual(ok('<line x1="1" y1="2" x2="3" y2="4" stroke="#000"/>'), [['line', { x1: '1', y1: '2', x2: '3', y2: '4', stroke: '#000' }]]);
});

test('parseSvg: errors show where they happened', () => {
  const r = parseSvg('<g><circle r="1" fill=red/></g>');
  assert.ok(!r.ok);
  assert.match(r.error, /fill=red/);
});

test('parseSvg: single-quoted attributes', () => {
  assert.deepEqual(ok("<rect x='1' y='2' width='3' height='4'/>"), [['rect', { x: '1', y: '2', width: '3', height: '4' }]]);
});

test('parseSvg: a gradient defined in the input may be referenced', () => {
  ok('<defs><linearGradient id="a"><stop offset="0" stop-color="#000"/></linearGradient></defs><rect width="4" height="4" fill="url(#a)"/>');
});

test('parseSvg: an undefined gradient reference is rejected', () => {
  bad('<rect width="4" height="4" fill="url(#b)"/>');
});

test('parseSvg: transforms from the allowlist pass', () => {
  ok('<g transform="translate(2 3) rotate(10)"><circle r="1"/></g>');
  ok('<g transform="rotate(-8 32 30)"><circle r="1"/></g>');
});

for (const [name, text] of [
  ['script', '<script>alert(1)</script>'],
  ['event handler', '<circle r="1" onload="x"/>'],
  ['style attribute', '<circle r="1" style="fill:red"/>'],
  ['href', '<circle r="1" href="#x"/>'],
  ['xlink:href', '<circle r="1" xlink:href="#x"/>'],
  ['foreignObject', '<foreignObject width="1" height="1"></foreignObject>'],
  ['image', '<image width="1" height="1"/>'],
  ['use', '<use x="1"/>'],
  ['text', '<text x="1">hi</text>'],
  ['external url', '<circle r="1" fill="url(http://x)"/>'],
  ['javascript url', '<circle r="1" fill="javascript:alert(1)"/>'],
  ['entity', '<circle r="1" fill="&amp;"/>'],
  ['CDATA', '<g><![CDATA[x]]></g>'],
  ['comment', '<g><!-- x --></g>'],
  ['class other than a rig mark', '<circle r="1" class="x"/>'],
  ['class with two marks', '<g class="eyes brows"/>'],
  ['huge coordinate', '<circle r="1" cx="1e9"/>'],
  ['negative coordinate', '<circle r="1" cx="-500"/>'],
  ['unclosed', '<g><circle r="1"/>'],
  ['mismatched', '<g><circle r="1"></g></circle>'],
  ['matrix transform', '<g transform="matrix(1,0,0,1,0,0)"><circle r="1"/></g>'],
  ['text content', '<g>hello</g>'],
  ['processing instruction', '<?xml version="1.0"?><circle r="1"/>'],
  ['unknown paint', '<circle r="1" fill="expression(x)"/>'],
  ['duplicate attribute', '<circle r="1" r="2"/>'],
  ['path data letters', '<path d="M0 0 javascript"/>'],
] as const) {
  test(`parseSvg rejects: ${name}`, () => bad(text));
}

test('parseSvg: rig marks are the only classes allowed', () => {
  assert.deepEqual(ok('<g class="eyes"><circle r="1"/></g>'), [['g', { class: 'eyes' }, [['circle', { r: '1' }]]]]);
  ok('<g class="mouth"><g class="mouth-rest"/><g class="mouth-smile"/><g class="mouth-o"/></g>');
  ok('<path d="M0 0" class="prop2"/>');
});

test('parseSvg rejects more than 400 nodes', () => {
  bad('<circle r="1"/>'.repeat(401));
  ok('<circle r="1"/>'.repeat(400));
});

test('parseSvg rejects a part with over 8 KB of path data', () => {
  bad(`<path d="M0 0 ${'L1 1 '.repeat(1700)}"/>`);
});

test('checkNodes: a parsed tree is valid', () => {
  assert.equal(checkNodes(ok('<g><circle r="1" fill="#abc"/></g>')), null);
});

test('checkNodes rejects stored trees parseSvg would never produce', () => {
  assert.ok(checkNodes([['script', {}]]));
  assert.ok(checkNodes([['circle', { onclick: 'x' }]]));
  assert.ok(checkNodes([['circle', { fill: 'url(#nope)' }]]));
  assert.ok(checkNodes('nope'));
  assert.ok(checkNodes([['g', {}, 'x']]));
});

test('checkNodes accepts a reference to a gradient defined elsewhere in the portrait', () => {
  assert.equal(checkNodes([['circle', { fill: 'url(#g)' }]], new Set(['g'])), null);
});
