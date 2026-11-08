/**
 * Keyboard shortcuts on every platform: `Mod` is ⌘ on a Mac and Ctrl on Windows and Linux. Shortcuts are written once as
 * combos such as `Mod+Shift+K` and shown the platform's way (`⇧⌘K` on a Mac, `Ctrl+Shift+K` elsewhere).
 */

type Nav = { platform?: string; userAgent?: string; userAgentData?: { platform?: string } };

/** Is this browser on a Mac (or an iPad/iPhone with a keyboard, which use ⌘ too)? */
export function detectMac(nav: Nav | undefined = typeof navigator === 'undefined' ? undefined : (navigator as unknown as Nav)): boolean {
  if (!nav) return false;
  return /mac|iphone|ipad|ipod/i.test(nav.userAgentData?.platform || nav.platform || nav.userAgent || '');
}

export const IS_MAC = detectMac();

type Mods = { metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean };

/** Only the primary modifier is down (⌘ on a Mac, Ctrl elsewhere), with or without Shift as asked; never Alt. */
export function isMod(e: Mods, opts: { shift?: boolean; mac?: boolean } = {}): boolean {
  const mac = opts.mac ?? IS_MAC;
  const primary = mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
  return primary && !e.altKey && e.shiftKey === !!opts.shift;
}

const MAC_GLYPH: Record<string, string> = { Mod: '⌘', Cmd: '⌘', Ctrl: '⌃', Alt: '⌥', Shift: '⇧', Enter: '↩', Escape: 'Esc', Tab: '⇥', Up: '↑', Down: '↓', Left: '←', Right: '→', ' ': 'Space' };
const OTHER_NAME: Record<string, string> = { Mod: 'Ctrl', Cmd: 'Ctrl', Escape: 'Esc', Up: '↑', Down: '↓', Left: '←', Right: '→', ' ': 'Space' };
// The order a Mac shows modifiers in: ⌃⌥⇧⌘.
const MAC_ORDER = ['Ctrl', 'Alt', 'Shift', 'Mod', 'Cmd'];

/** `Mod+Shift+K` → `⇧⌘K` on a Mac, `Ctrl+Shift+K` elsewhere. A plain key (`?`, `Enter`) is shown as such. */
export function keyLabel(combo: string, mac = IS_MAC): string {
  const parts = combo.split('+').filter(Boolean);
  if (combo.endsWith('++')) parts.push('+');
  const key = parts.pop() ?? '';
  const mods = parts;
  const k = key.length === 1 && key !== ' ' ? key.toUpperCase() : key;
  if (mac) {
    const sorted = [...mods].sort((a, b) => MAC_ORDER.indexOf(a) - MAC_ORDER.indexOf(b));
    return sorted.map((m) => MAC_GLYPH[m] ?? m).join('') + (MAC_GLYPH[k] ?? k);
  }
  return [...mods.map((m) => OTHER_NAME[m] ?? m), OTHER_NAME[k] ?? k].join('+');
}
