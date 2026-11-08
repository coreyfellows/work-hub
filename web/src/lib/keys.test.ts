import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectMac, isMod, keyLabel } from './keys.ts';

const ev = (m: Partial<{ metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }>) => ({ metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...m });

test('detectMac from userAgentData, platform or the user agent', () => {
  assert.equal(detectMac({ userAgentData: { platform: 'macOS' } }), true);
  assert.equal(detectMac({ platform: 'MacIntel' }), true);
  assert.equal(detectMac({ platform: 'Win32' }), false);
  assert.equal(detectMac({ platform: 'Linux x86_64' }), false);
  assert.equal(detectMac({ userAgent: 'Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X)' }), true);
  assert.equal(detectMac({}), false);
});

test('isMod: ⌘ on a Mac, Ctrl elsewhere; Shift only when asked; never with Alt or both', () => {
  assert.equal(isMod(ev({ metaKey: true }), { mac: true }), true);
  assert.equal(isMod(ev({ ctrlKey: true }), { mac: true }), false);
  assert.equal(isMod(ev({ ctrlKey: true }), { mac: false }), true);
  assert.equal(isMod(ev({ metaKey: true }), { mac: false }), false);
  assert.equal(isMod(ev({ ctrlKey: true, shiftKey: true }), { mac: false }), false);
  assert.equal(isMod(ev({ ctrlKey: true, shiftKey: true }), { mac: false, shift: true }), true);
  assert.equal(isMod(ev({ metaKey: true, altKey: true }), { mac: true }), false);
  assert.equal(isMod(ev({ metaKey: true, ctrlKey: true }), { mac: true }), false);
});

test('keyLabel per platform', () => {
  assert.equal(keyLabel('Mod+K', true), '⌘K');
  assert.equal(keyLabel('Mod+K', false), 'Ctrl+K');
  assert.equal(keyLabel('Mod+Shift+K', true), '⇧⌘K');
  assert.equal(keyLabel('Shift+Mod+K', false), 'Shift+Ctrl+K');
  assert.equal(keyLabel('Mod+Enter', true), '⌘↩');
  assert.equal(keyLabel('Mod+Enter', false), 'Ctrl+Enter');
  assert.equal(keyLabel('Mod+,', false), 'Ctrl+,');
  assert.equal(keyLabel('Shift+Enter', true), '⇧↩');
  assert.equal(keyLabel('?', true), '?');
  assert.equal(keyLabel('Escape', false), 'Esc');
  assert.equal(keyLabel('Ctrl+K', true), '⌃K');
  assert.equal(keyLabel(' ', false), 'Space');
});
