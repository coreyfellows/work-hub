# Keyboard shortcuts

`Mod` below is **⌘ on a Mac** and **Ctrl on Windows and Linux**. The app shows each shortcut the way your platform
writes it: in the header's **⌨** cheat sheet (press `?` anywhere outside a text box to open it), in button tooltips
and on the 🔍 button. Phones have no ⌨ button.

## Anywhere

| Mac | Windows / Linux | What |
| --- | --- | --- |
| ⌘K | Ctrl+K | Jump to a page, workspace, session or PR (the palette). On a Mac Ctrl+K works too, outside a text box or terminal. On Windows/Linux a terminal keeps Ctrl+K (the shell's "kill to end of line"). |
| ⇧⌘K | Ctrl+Shift+K | Commands: the palette in `>` mode (also from inside a text box) |
| `>` | `>` | Commands, outside a text box |
| `?` | `?` | The shortcut cheat sheet, outside a text box |
| Esc | Esc | Close a menu, popover, the palette or a dialog |

## Palette

| Keys | What |
| --- | --- |
| ↑ ↓ | Move between results |
| ← → | Pick one of a workspace's sessions |
| ↩ / Enter | Open or run the selected result |

## Workspace

| Mac | Windows / Linux | What |
| --- | --- | --- |
| ⌘, ⌘. | Ctrl+, Ctrl+. | Previous / next session tab (a terminal tab steps to the first or last session) |

## Session (Chat and Log views)

| Mac | Windows / Linux | What |
| --- | --- | --- |
| ⌘F | Ctrl+F | Find in this view, after you've clicked into it (else the browser's find). In a dialog (code, a diff, output) it searches the dialog. |
| ↩ / ⇧↩ | Enter / Shift+Enter | Next / previous match, in the find box |

## Prompt box (conversation-view plugin)

| Keys | What |
| --- | --- |
| Enter | Send |
| Shift+Enter | New line |
| Esc | Stop the session while it's working |
| Tab | Jump into the prompt box when nothing on the page has focus |
| `/` then ↑ ↓, Tab, Esc | Slash commands: move, pick, dismiss |
| ↑ ↓, Space, Enter | When Claude is asking: move between options, pick one, pick and send |

## Pull requests (github plugin)

| Mac | Windows / Linux | What |
| --- | --- | --- |
| ⌘↩ | Ctrl+Enter | Send a comment or reply |

## Menus

| Keys | What |
| --- | --- |
| ↑ ↓ | Move between items |
| Esc | Close |

## For plugin authors

List your plugin's shortcuts with the `shortcut` slot, so they show in the cheat sheet:

```ts
ctx.contribute('shortcut', { group: 'My plugin', keys: ['Mod+Shift+P'], label: 'Do the thing', where: 'on its page' });
```

Handle the key yourself with `isMod(e)` (⌘ alone on a Mac, Ctrl alone elsewhere) and show it with
`keyLabel('Mod+Shift+P')` (`⇧⌘P` / `Ctrl+Shift+P`), both from `plugin-api/web.ts`. Don't test `e.metaKey` directly:
it's the Windows key on Windows and Linux. The core's own list is `web/src/shortcuts.ts`; keep it, its handlers and
this page in step.
