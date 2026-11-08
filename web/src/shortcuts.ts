import type { ShortcutItem } from '../../plugin-api/web.ts';
import { IS_MAC } from './lib/keys.ts';

/**
 * The core's keyboard shortcuts, as the ⌨ cheat sheet lists them (plugins add theirs to the `shortcut` slot). Keep this in
 * step with the handlers (CommandPalette, WorkspacePage, SessionView, Modal, ConversationSearch, Menu, ShortcutSheet) and
 * with docs/keyboard-shortcuts.md. `Mod` is ⌘ on a Mac, Ctrl elsewhere.
 */
export const CORE_SHORTCUTS: Omit<ShortcutItem, 'plugin'>[] = [
  { group: 'Anywhere', keys: ['Mod+K'], label: 'Jump to a page, workspace, session or PR', where: IS_MAC ? 'Ctrl+K too, outside a text box or terminal' : "not inside a terminal, where Ctrl+K stays the shell's" },
  { group: 'Anywhere', keys: ['Mod+Shift+K'], label: 'Commands (the palette in > mode)' },
  { group: 'Anywhere', keys: ['>'], label: 'Commands', where: 'outside a text box' },
  { group: 'Anywhere', keys: ['?'], label: 'This cheat sheet', where: 'outside a text box' },
  { group: 'Anywhere', keys: ['Escape'], label: 'Close a menu, popover or dialog' },
  { group: 'Palette', keys: ['Up', 'Down'], label: 'Move between results' },
  { group: 'Palette', keys: ['Left', 'Right'], label: "Pick one of a workspace's sessions" },
  { group: 'Palette', keys: ['Enter'], label: 'Open or run the selected result' },
  { group: 'Workspace', keys: ['Mod+,', 'Mod+.'], label: 'Previous / next session tab' },
  { group: 'Session', keys: ['Mod+F'], label: 'Find in the Chat or Log view', where: 'after clicking into the view; in a dialog, searches the dialog' },
  { group: 'Session', keys: ['Enter', 'Shift+Enter'], label: 'Next / previous match', where: 'in the find box' },
  { group: 'Menus', keys: ['Up', 'Down'], label: 'Move between items' },
];
