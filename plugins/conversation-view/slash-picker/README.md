# slash-picker (a conversation-view feature)

The prompt box's `/` picker. A draft that is just `/word` lists the session's commands (skills, commands, plugin commands,
built-ins), fuzzy-filtered with `fuzzyRank` as you type. ↑↓ move, Tab/Enter fill `/name ` into the box, Esc closes; Enter sends
if the name is already exact. A "Loading commands…" row shows during the first fetch (about 3s). Nothing is fetched until the
first `/`; the list is then remembered per session in the browser.

## Server (`server.ts`, `commands.ts`)

- `GET /api/sessions/:id/commands` -> `{ commands: SlashCommand[] }` (ETag-revalidated via `ctx.revalidate`; 404 if the session is unknown). 10 minute
  cache per cwd, concurrent requests share one probe.
- `probeCommandNames` starts a headless `claude -p --output-format stream-json --no-session-persistence` in the session's cwd,
  reads the `init` event's `slash_commands` + `terminal_slash_commands` (~3s, before any model call) and kills it.
- Descriptions come from the files (cwd and `~/.claude` skills/commands, enabled plugins' as `plugin:name`), plus a hand-kept
  built-in list (interactive-only ones like /help, /resume that init omits) and `BUNDLED` descriptions.
- `shared/types.ts` holds `SlashCommand`, imported by both halves.

## Web (`web.tsx`, `SlashMenu.tsx`, `styles.css`)

Contributes one `composer-addon` item (`SlashPicker`). Core renders addons inside the prompt box (where the menu opens above
it) and passes `ComposerAddonProps` (`session`, `sessionId`, `draft`, `setDraft`, `send`, `inputRef`, `registerKeyHandler`).
Key handling: the addon's open/highlight state lives in its component, so it calls `registerKeyHandler(fn)` on every render and
`registerKeyHandler(null)` on unmount; the box calls registered handlers first on `keydown`, and the first to return true wins
(the box then skips its Esc-to-stop and Enter-to-send). The picker's handler returns false when it's closed, so Enter and Esc
behave as usual then.

## Settings

None.
