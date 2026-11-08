# conversation-view

A session's conversation, read from its Claude transcript, as two session views: **Chat** (the readable thread) and
**Log** (the raw transcript with every tool call). It also defines the `log-card` slot that every card in the
conversation (file changes, git ops, `!` commands…) renders through, and it owns the features that draw in or act on the
conversation. Each is a folder here with its own README, registered from `server.ts` / `web.tsx` in the order they loaded
when they were separate plugins (enricher order matters):

| Folder | What it adds |
|---|---|
| `bash-snapshots/` | files changed by Bash commands (sed, formatters…) via a git-snapshot hook. **Off unless the `bashSnapshots` setting is on.** |
| `command-runs/` | `!` command cards (Run, queue, View script, ▶ Terminal) and the commands you ran, with output |
| `file-links/` | file paths in messages become links that open the file in a modal |
| `git-cards/` | git operations in Bash calls as cards, with each commit's diff |
| `edit-cards/` | Edit/Write changes as cards, grouped when several come in a row |
| `composer/` | the prompt box: the Chat view's footer (Send, Stop, Keys, the `composer-addon` slot); Log and Terminal have none |
| `slash-picker/` | the prompt box's `/` command picker (skills, commands, plugin commands) |
| `permissions/` | answering a background session's tool-permission menu (Yes / No…) from the prompt box |
| `questions/` | answering a background session's AskUserQuestion forms from the prompt box |

## What it does

- **`GET /api/sessions/:id/history?before|after|limit`**: `claude logs` is only the current screen, so the conversation
  comes from the transcript (`~/.claude/projects/*/<sessionId>.jsonl`), read incrementally and condensed by the core's
  `ctx.sessions.readHistory` (the core keeps the parser and the transcript enrichers that add `edit`, `edits`, `git`,
  `shell`, `questions`, `host` to entries). Returns `{ entries, start, total, host, noticeCount }` (`{ entries: [], start: 0,
  total: 0, noticeCount: 0 }` when there's no transcript). Besides messages and tool calls, entries include narration lines
  (`narration`, drawn as Claude's text), slash commands you typed (as your messages) and away summaries (`kind: 'notice'`,
  a muted "Recap" line in Chat and Log).
- **`GET /api/sessions/:id/history/live`** (WebSocket, `historyLive.ts`): sends `{"t":"ready"}` once the session's
  transcript is watched and `{"t":"changed"}` after each change to it (`transcriptWatch.ts`: one `fs.watch` per file
  shared by every viewer, writes coalesced over ~80ms, a 5s `stat` check for missed events or a replaced file; nothing
  runs once the last viewer leaves). It carries no entries: the session page answers each message with its usual
  `history?after=` fetch, so paging, ETags and enrichers stay on one path. While it's up the page polls only every 15s
  (for what enrichers add from elsewhere) instead of 3s; it isn't opened in low data (10s polling as before) or while
  the tab is hidden, and it reconnects with backoff (1s to 30s) with 3s polling meanwhile. Origin-checked like every
  WebSocket route; waits for a transcript that doesn't exist yet.
- **`GET /api/sessions/:id/activity`**: the session's hook feedback (a Stop hook sending Claude back, hook errors and
  messages) and task notifications (background commands and subagents finishing), from `ctx.sessions.readNotices`:
  `{ notices, total }`. ETag-revalidated (`ctx.revalidate`), so an unchanged poll is an empty 304. Works for
  interactive sessions too.
- **The prompt box** is the `chat` item's `footer` (`composer/Composer.tsx`): the core draws it under the scroll area only while Chat
  is active, and gives it `SessionFooterProps` (`send`, `stop`, `pressKey`, `working`…). Log and Terminal have no input of their own.
- **`session-view` item** `activity` (`Activity.tsx`, `needsHistory`): those notices, newest first, apart from the
  conversation (long output folds away). It loads when opened and again when the history poll's `noticeCount` changes,
  so it has no poll of its own (low data included), with `<AsOf>` ↻.
- **`session-view` items** `chat` (`default`, `needsHistory`, `readable`) and `log` (`needsHistory`), one shared component
  (so switching between them keeps one instance). The core still loads and polls the history (pushed by the live socket above) and hands it to views as
  `SessionViewProps.history` (`entries`, `hasMore`, `earlier`, `loading`, `loadEarlier()`, `resident`) plus the turn state
  (`pending`, `working`, `stopping`, `pressKey`, `stop`); the core's 🔍 find box and ⌘F work on both views (`needsHistory`).
  - **Chat**: Claude's messages share one bubble on the left until you reply, yours share one on the right; tool work is
    folded into "⋯ N steps"; answered questions are a Claude message (the question and its options) followed by your
    answer as your message; the question you're being asked now is left out (the form below the prompt box has it, for
    background sessions). Messages you sent that the transcript doesn't show yet are drawn as "sending…"/"sent ✓", or
    "queued" with **Send now** (Ctrl-X Ctrl-S) while Claude works; the working bubble has a **■ Stop** pill (Esc).
    Each bubble has MD and Text copy buttons (hover; always on touch) that copy its text as the Markdown it was written in or as
    plain text (`plainText.ts`: emphasis, headings, quotes, links and fences stripped, tables tab-separated).
  - **Log**: Claude's TUI look: `>` your messages, ⏺ replies (Markdown) and tool calls (a collapsible row with the
    result after ⎿), the answer under each answered question (`↳`). A one-line `!` block is plain code here (no
    Run/Terminal card; those are Chat only).
  - "Load earlier (N more)" at the top, and scrolling near the top, prepend the previous page.
  - With a `host-provider` (the menagerie plugin) asides become host cards and bubbles, questions and the working bubble are
    themed; without one everything renders plainly.

## Slots it reads

- **`log-card`** (defined here, typed in `plugin-api/web.ts` as `LogCardItem`):
  `{ id, order?, match(entry), render(entry, ctx), run?: { key(entry): string | null, render(entries, ctx) }, label?, Wrap? }`
  with `ctx: LogCardContext = { sessionId, readable, index }`.
  - Every item whose `match` says yes contributes, in slot order (one Bash call can show its file changes, then its git
    card). Entries nobody matches get the default rendering.
  - Chat: a tool entry's cards sit on Claude's side, any other entry's on its own side (in place of its default part;
    `label` names the bubble when the card opens one on your side, e.g. "You ran"). Consecutive contributions of one
    item with an equal, non-null `run.key` collapse into one `run.render`; tool steps folded in between don't break a
    run, anything else drawn does (text, messages, questions, another card), and steps taken during a run come after its
    card. The layout is `planChat` in `chatPlan.ts` (tested).
  - Log: no runs. A tool entry keeps its row with the cards inside it above the result; any other entry's row is the cards.
  - `Wrap` goes around the whole conversation (mounted while the view is, shown or not), e.g. a context the cards read.
- **`markdown-override`**: merged into the Markdown of Claude's messages (the core `Markdown`); this plugin's own default
  is only `a` (links open in a new tab). Overrides that differ between Chat and Log read `LogViewContext`
  (`{ sessionId, readable }`, provided around the log).
- **`host-provider`** via `useHostProvider()`.

The features contribute the renderers: `log-card` items from edit-cards (file changes + their run), git-cards
(git + its run) and command-runs (`!` shell runs), `markdown-override` items from file-links (`code`/`p`/`li`/`td`) and
command-runs (`!` command cards in `pre`).

## Settings

- `bashSnapshots` (boolean, default `false`; env `WORK_HUB_CONVERSATION_VIEW_BASH_SNAPSHOTS`): the bash-snapshots feature.
  Its own knobs are `bashSnapshotsDir` (snapshot folder; env `WORK_HUB_BASH_SNAP_DIR`) and `bashSnapshotsClaudeSettings`.
  The other features are always on with the plugin; the web half of a feature has no switch of its own.

The view tab you last chose (`wh.sessionTab`) and the tab order (`views` in `/api/layout`) belong to the core.
