import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { toFunHost } from './cast.ts';
import { fixtureCharacter } from './fixtures.ts';
import { nodesToElements, portraitElements } from './render.ts';
import { splitAside } from './aside.ts';

const svg = (children: ReturnType<typeof nodesToElements>) => renderToStaticMarkup(createElement('svg', null, ...children));

test('nodesToElements: drops attributes and tags outside the allowlist', () => {
  const html = svg(nodesToElements([['circle', { cx: '1', onclick: 'x', style: 'y' }], ['script', {}] as never], 'a'));
  assert.equal(html, '<svg><circle cx="1"></circle></svg>');
});

test('nodesToElements: kebab-case attributes come out as SVG attributes', () => {
  assert.match(svg(nodesToElements([['path', { d: 'M0 0', 'stroke-width': '2', 'stroke-linecap': 'round' }]], 'a')), /stroke-width="2" stroke-linecap="round"/);
});

test('nodesToElements: gradient ids are prefixed per host', () => {
  const html = svg(nodesToElements([['linearGradient', { id: 'g' }], ['rect', { fill: 'url(#g)' }]], 'zed'));
  assert.match(html, /id="zed-g"/);
  assert.match(html, /fill="url\(#zed-g\)"/);
});

test('portraitElements: rig marks become the face classes', () => {
  const html = svg(portraitElements(toFunHost(fixtureCharacter())));
  for (const cls of ['av-brows', 'av-eyes', 'av-blink', 'av-mouth', 'm-rest', 'm-smile', 'm-o', 'av-zed-p1']) assert.ok(html.includes(`class="${cls}"`), cls);
  assert.match(html, /class="m-smile" opacity="0"/);
  assert.doesNotMatch(html, /class="(eyes|brows|mouth|prop1)"/);
});

test('portraitElements: eyes-noblink and shades', () => {
  const host = toFunHost(fixtureCharacter());
  host.portrait = { nodes: [['g', { class: 'eyes-noblink' }, [['circle', { r: '1' }]]], ['g', { class: 'shades' }, [['circle', { r: '1' }]]]] };
  const html = svg(portraitElements(host));
  assert.match(html, /class="av-eyes"/);
  assert.doesNotMatch(html, /av-blink/);
  assert.match(html, /class="av-shades"/);
});

test('splitAside: an aside from a host no longer in the cast stays plain Markdown', () => {
  const hosts = [toFunHost(fixtureCharacter())];
  assert.equal(splitAside('Done.\n\n> 🐙 *ink everywhere*', hosts), null);
  assert.equal(splitAside('Done.\n\n> 🗼 *lamp lit*', hosts)?.aside.text, 'lamp lit');
});
