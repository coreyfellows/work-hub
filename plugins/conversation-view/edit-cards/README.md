# edit-cards (a conversation-view feature)

File changes as cards in a session's Chat and Log views, instead of folding them into "⋯ N steps".

- **One change** (`EditCard.tsx`): a one-line row (file, +/− counts) that opens the change in a native `<dialog>` modal,
  portalled to body, so the chat never shifts. The modal shows an LCS line diff with 2 lines of context; unchanged lines
  get the file's syntax colours (`highlightLines`: each hunk's new text highlighted whole, split per line with spans
  re-balanced), added/removed lines keep their green/red. A brand-new file (`created`: a Write whose result says
  "File created", or a file a command made) isn't drawn as a diff but as the file: line numbers + highlight.js colours
  (language by extension or shebang, plain text otherwise). A Write that overwrote a file stays a diff.
- **A run of changes** (Chat only): two or more changes in a row collapse into one `FileGroupCard`: "Modified N files" + 3
  names "and N more files…". Steps folded in between don't break the run; text, messages, questions and other cards (git)
  do, and the run's hidden steps are shown after it. It opens a modal with a directory tree beside the selected file's net
  change (a name in the summary opens it on that file; stacked on phones). Several edits to one file are replayed into one
  before→after diff (`composeEdits`), and a run touching only one file is just that one card.
- In the raw Log every change is its own card inside its tool row.

The diff/file bodies, the tree browser, `composeEdits`, the word-wrap toggle (`wh.wrapFiles`, per device) and the lazy
highlight.js chunk are core components (`FilesBrowser`, `NewFileBody`, `Modal`, `highlightCode`), shared with the git
cards, the file viewer and session stats; this plugin owns the cards and the run grouping.

## Transcript field

`edit` on Edit/MultiEdit/Write/NotebookEdit tool entries (enricher `edits`, `edits.ts`): `{ path, tool, at, hunks: [{ old,
new }] }` for edits (each side capped at 6000 chars), `{ path, tool, at, content, lines, created }` for a Write. Commands'
changes (`edits`, a list of the same shape) come from the bash-snapshots plugin; these cards draw both.

## Route

None. `GET /api/sessions/:id/file-edits?path=<file>` (every recorded change to one file, oldest first) is core; it returns the
`edit`/`edits` fields this plugin's enricher (and bash-snapshots') put on the transcript, so with this plugin off it carries
only the commands' changes (bash-snapshots) and the session-stats Files changed modal shows no diffs of Edit/Write changes.

## Slot

`log-card` item `edits`, order 10 (before the git cards' 20 and `!` runs' 30, so one Bash call shows its file changes, then
its git card), with a `run` keyed `edits` for the Chat grouping.

## Settings

None.

## Tests

`edits.test.ts`: the enricher (Write created vs overwritten, Edit/MultiEdit/NotebookEdit hunks, other tools ignored, the
6000-char cap). How the core folds these fields into `sessionEdits` is tested in `server/lib/transcript.test.ts`.
