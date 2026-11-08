# file-links (a conversation-view feature)

File paths in a session's messages become links. Click one and the file opens in a modal (line numbers and highlight.js
colours; `.md` files render as a document with a Rendered/Source toggle, remembered in localStorage `wh.mdSource`).

## How it works

- **Web** (`web.tsx`, `FileLinks.tsx`): contributes an `inline-text` item (the core `Linkify` hands it the text between URLs) and
  `markdown-override` items for `code` (inline code that is a whole path), `p`, `li` and `td`. Path-looking text (`paths.ts`: a
  slash path, `~/`, an absolute path, or a bare name with a known extension; `:12` / `#L12` suffixes are fine) is checked in
  batches of up to 50 by `POST /api/sessions/:id/files/resolve`; hits are cached per session, misses are retried after 60s. The
  pending question form is covered too, through `SessionIdContext`.
- **Server** (`server.ts`, `fileView.ts`, tested): relative paths are tried against the session's cwd, then its workspace's
  worktrees. Only real files (after symlink resolution) under those, the worktrees root, the repos folder (specs often live in a sibling repo), `~/notes`, `/tmp` or a folder another
  plugin added with `ctx.files.addRoot` (read here through `ctx.files.roots()`; the registry itself is core, `server/lib/fileRoots.ts`)
  are served. Never `.git`, `.ssh`, `.aws`, `.gnupg`, `.env*`, keys or credentials; 1 MB cap; binaries are not shown.

## Routes

- `POST /api/sessions/:id/files/resolve` body `{ paths: string[] }` (max 50) returns `{ files: { [raw]: { path, line? } | null } }`.
- `GET /api/sessions/:id/file?path=` returns `{ path, size, truncated, binary, content, line? }`, or 404.

Without this plugin paths stay plain text.
