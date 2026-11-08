# live-terminal

A session's **Terminal** view. For a background job (`claude --bg`) it's a real terminal: while the session page is
open, the server keeps one `claude attach <id>` running in a pseudo-terminal and streams it over a WebSocket into
xterm.js, and the prompt box and key buttons type straight into it. Interactive sessions (and a live connection that
keeps failing) get a snapshot of the screen instead. The plugin also tells the Chat view's working bubble how fast
Claude's screen is changing.

## How it works

- **Live** (`live.ts`, `LiveTerminal.tsx`): WS `GET /api/sessions/:id/term?cols&rows`. The browser sends JSON
  (`{t:'in', d}` to type, `{t:'resize', cols, rows}`); the server sends output as binary frames and `{t:'exit'}` when
  the attach ends. Closing the socket closes the bridge's stdin, a clean detach: the job keeps running.
  - Only background sessions (409 otherwise). Browsers don't apply same-origin rules to WebSockets, so the route
    checks `Origin` with `isAcceptedOrigin` (plugin-api/server.ts: the hostname's origin, or 127.0.0.1/localhost in localhost mode) and answers 403 to anything else; host and
    sign-in were already checked by the core's guard.
  - Several viewers can attach at once. The terminal size is shared: the last resize wins for every attached client.
  - Claude runs full-screen with mouse reporting, so the wheel (and the ⇞ ⇟ ⤓ buttons: PgUp, PgDn, Ctrl+End) scroll
    Claude's own view of the whole conversation, and that scroll position is shared by every viewer. On touch, a finger
    drag sends wheel steps (with a little inertia).
  - On attach Claude asks the terminal what it is (`\e[c`, `\e[>q`) and shows "Attaching…" until it gets a DA1 reply.
    xterm.js answers by itself; the core's short server-side attaches (`server/lib/attach.ts`) answer it explicitly.
  - The pty comes from the core's `server/lib/ptybridge.py` (spawned by path, not imported; `python3`, `python` on
    Windows, or `WORK_HUB_PYTHON`; on Windows it needs `pip install pywinpty`, for ConPTY). It checks for its fd-3
    resize channel before creating the pty; otherwise the pty master can land on fd 3 and be misread as the control
    channel (this once swallowed output and Enter keys).
  - Up to 5 reconnects (1s, 2s… 5s apart); then the view falls back to the snapshot.
- **Input sink**: while live, the view registers an input sink (`registerInput`), so Send types the text, then Enter
  separately, and the key buttons send their bytes (`KEY_BYTES`: Enter, Esc, arrows, Tab, ⇧Tab, Ctrl-X Ctrl-S). Esc is
  Claude's own interrupt (the ■ Stop button). When the connection isn't open the sink answers "not delivered" and the
  core falls back to `POST /api/sessions/:id/send` / `/key`. The view stays mounted (and connected) while Chat or Log
  shows, so it keeps taking input and switching back is instant.
- **Snapshot** (`GET /api/sessions/:id/screen?lines=N`, ETag-revalidated): `claude logs` (raw ANSI) replayed through a
  headless xterm into HTML-escaped spans by the core's `server/lib/termhtml.ts` (`ansiToHtml`, exported from
  `plugin-api/server.ts`; the core's `/answer` uses it too). `{ source: 'logs', exact: true, html }` for background
  jobs, `{ source: 'none', exact: false, html: '' }` otherwise. The view polls it every 1.5s (5s for interactive
  sessions) while it uses the snapshot.
- **Working bubble** (`activity.ts`, `screenText.ts`, slot `working-activity`): while Claude works and the Chat or Log
  view shows, `/screen?lines=40` is polled every 1.5s; the spinner word becomes the bubble's quip and the size of each
  change feeds its pace. The core turns it off in low data, for interactive sessions and while the Terminal view shows.
  Without this plugin the bubble keeps a still pace and its own words.

## Low data

The live terminal doesn't connect by itself: the view shows "▶ Go live" (per visit) and the snapshot meanwhile. The
snapshot is polled every 10s and only while the Terminal view shows; the working bubble doesn't poll `/screen` at all.
Session pages open on Chat in low data (core, `wh.sessionTab`).

## Slots

- `session-view` `terminal` (label Terminal, `default`, `liveDot`, order 10 so it stays first): reports its status with
  `setLiveStatus` (the tab's dot: connecting, live, reconnecting, failed, ended; null while it shows the snapshot), sizes
  itself to `viewHeight` and calls `stickToBottom` when the snapshot changes.
- `working-activity`: `useActivity(sessionId, enabled)` for the working bubble.

## Settings

None.

## Files

- `server.ts`: `/screen` and the WS route. `live.ts`: the WS route.
- `web.tsx`, `TerminalView.tsx` (go-live, snapshot, sink), `LiveTerminal.tsx` (xterm.js), `activity.ts`, `screenText.ts`
  (+ test), `styles.css` (`.live-term`, `.live-wrap`, `.scroll-ctl`, `.go-live`). The tab's `.live-dot` and the
  `.session-scroll.live` frame rules stay in the core.
