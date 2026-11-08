import assert from 'node:assert/strict';
import { test } from 'node:test';
import { castCss, checkKeyframes, parseFilter, parseTransform, type Keyframes } from './keyframes.ts';

test('parseTransform: allowed functions are normalised', () => {
  assert.equal(parseTransform('translateX(-130%) skewX(-22deg)'), 'translateX(-130%) skewX(-22deg)');
  assert.equal(parseTransform('translate(2px,  -3px) scale(0.5)'), 'translate(2px, -3px) scale(0.5)');
  assert.equal(parseTransform('none'), 'none');
});

test('parseTransform: rejects out of bounds, unknown functions and injection', () => {
  for (const s of ['rotate(1e5deg)', 'matrix(1,0,0,1,0,0)', 'translate(1px;}body{x)', 'url(x)', 'rotate(10)', 'scale(9)', '', 'translate(1px', 'rotate(10deg) }']) {
    assert.equal(parseTransform(s), null, s);
  }
});

test('parseFilter: allowed functions pass, others fail', () => {
  assert.equal(parseFilter('sepia(1) saturate(6) brightness(1.3)'), 'sepia(1) saturate(6) brightness(1.3)');
  assert.equal(parseFilter('blur(2px) hue-rotate(-40deg)'), 'blur(2px) hue-rotate(-40deg)');
  assert.equal(parseFilter('drop-shadow(0 0 2px red)'), null);
  assert.equal(parseFilter('url(#f)'), null);
});

const exit = (over: Partial<Keyframes> = {}): Keyframes => ({
  durationMs: 1500,
  frames: [{ at: 0, transform: 'none' }, { at: 100, transform: 'scale(0.5)', opacity: 0 }],
  ...over,
});

test('checkKeyframes: a valid exit', () => {
  assert.equal(checkKeyframes(exit(), 'exit'), null);
});

test('checkKeyframes: an exit must end invisible', () => {
  assert.ok(checkKeyframes(exit({ frames: [{ at: 0 }, { at: 100, opacity: 0.5 }] }), 'exit'));
});

test('checkKeyframes: durations are bounded per kind', () => {
  assert.ok(checkKeyframes(exit({ durationMs: 3000 }), 'exit'));
  assert.ok(checkKeyframes(exit({ durationMs: 500 }), 'exit'));
  assert.ok(checkKeyframes({ durationMs: 500, frames: [{ at: 0 }, { at: 100 }] }, 'prop'));
  assert.equal(checkKeyframes({ durationMs: 1100, frames: [{ at: 0 }, { at: 100 }] }, 'prop'), null);
  assert.equal(checkKeyframes({ durationMs: 4000, frames: [{ at: 0 }, { at: 100 }] }, 'prop'), null);
});

test('checkKeyframes: frames in range and in order', () => {
  assert.ok(checkKeyframes(exit({ frames: [{ at: -1 }, { at: 100, opacity: 0 }] }), 'exit'));
  assert.ok(checkKeyframes(exit({ frames: [{ at: 60 }, { at: 30 }, { at: 100, opacity: 0 }] }), 'exit'));
  assert.ok(checkKeyframes(exit({ frames: [{ at: 0, transform: 'evil()' }, { at: 100, opacity: 0 }] }), 'exit'));
  assert.ok(checkKeyframes(exit({ easing: 'cubic-bezier(1,1,1,1)' as never }), 'exit'));
  assert.ok(checkKeyframes(exit({ frames: [{ at: 0, transformOrigin: 'evil' as never }, { at: 100, opacity: 0 }] }), 'exit'));
  assert.ok(checkKeyframes('nope', 'exit'));
});

test('checkKeyframes: steps(1) easing and sepia filter are allowed', () => {
  assert.equal(checkKeyframes({ durationMs: 3900, easing: 'steps(1)', frames: [{ at: 0, filter: 'sepia(1)' }, { at: 100 }] }, 'prop'), null);
});

test('castCss: exit variables and keyframes per character', () => {
  const css = castCss([{ id: 'zed', motion: { exit: exit() } }]);
  assert.ok(css.includes('.quip-bye-zed { --bye: 1500ms; --bye-anim: mh-bye-zed; }'), css);
  assert.ok(css.includes('@keyframes mh-bye-zed'));
});

test('castCss: prop moves per slot', () => {
  const css = castCss([{ id: 'zed', motion: { exit: exit(), props: [{ durationMs: 2000, frames: [{ at: 0, transformOrigin: 'bottom' }, { at: 50, transform: 'rotate(8deg)' }, { at: 100 }] }] } }]);
  assert.ok(css.includes('.fun-avatar .av-zed-p1'));
  assert.ok(css.includes('@keyframes mh-av-zed-p1'));
  assert.ok(css.includes('transform-origin: bottom'));
});

test('castCss: invalid characters and motions are left out entirely', () => {
  const good = castCss([{ id: 'zed', motion: { exit: exit() } }]);
  const hostile = castCss([
    { id: 'zed', motion: { exit: exit() } },
    { id: 'x}body{', motion: { exit: exit() } },
    { id: 'evil', motion: { exit: exit({ frames: [{ at: 0, transform: 'rotate(1deg)} body {color:red' }, { at: 100, opacity: 0 }] }) } },
  ]);
  assert.equal(hostile, good);
});

test('castCss: random junk never escapes the template', () => {
  const junk = ['}', '{', ';', '<', '@', '/*', '\\', '"', "'", ')', '('];
  for (let i = 0; i < 200; i++) {
    const s = Array.from({ length: 6 }, () => junk[Math.floor(Math.random() * junk.length)]).join('');
    const css = castCss([{ id: 'zed', motion: { exit: exit({ frames: [{ at: 0, transform: `rotate(1deg)${s}`, filter: s }, { at: 100, opacity: 0 }] }) } }]);
    assert.equal(css, '');
  }
});

test('castCss: keyframe names are namespaced, so a host called "fade" cannot replace bye-fade (review minor 1)', () => {
  const css = castCss([{ id: 'fade', motion: { exit: exit() } }]);
  assert.ok(!css.includes('@keyframes bye-fade'), css);
  assert.ok(css.includes('.quip-bye-fade { --bye: 1500ms; --bye-anim: mh-bye-fade; }'));
  assert.ok(css.includes('@keyframes mh-bye-fade'));
});
