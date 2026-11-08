# menagerie (official plugin, off by default)

Resident "hosts" you pick: name a few characters you like, and the plugin generates each one a voice, lines, a
cartoon portrait and animations of its own. In the Chat view a host's asides become cards with their portrait,
questions are framed in their voice, the working bubble takes their look, and each one leaves the screen in its own
way. In sessions the app starts, a small bundled Claude mod moves a host in and has Claude sign off some replies in
their voice.

Nothing depends on another repo: the cast is a file in the plugin's state dir, generated, imported or edited through
the plugin's settings page.

## Turning it on

On the app's first-run page (manifest `firstRunOffer`): tick Menagerie and name a few characters (the `seed` setting).
After the rebuild and restart, the plugin generates them as "play them" at its first start, if the cast is empty then
(`seed.ts`; a `seed-used` marker in its state dir means it never happens again: not on a restart, an emptied cast or an
edited seed). The offer only rides along on a first-run page that's open anyway, and isn't shown to users who turned
the plugin off on purpose. Or later: Settings →
Plugins → Menagerie (on; it applies after a rebuild and restart). With the plugin on and no cast yet, a
banner under the header offers **Set up** (dismissable per device, `wh.menagerieSetupDismissed`), which opens the
settings page. There, name up to six characters, each with **Play them** (the host *is* that character: their name,
a parody voice, original lines and an original cartoon) or **Invent someone like them** (a new character riffing on
them), then **Generate**.

## The settings page (`/settings/plugins/menagerie`)

- **Your cast** (`CastEditor.tsx`): a card per host (portrait, name, "Playing X" / "Inspired by X", two of its
  question lines) with **Reroll ▾** (Portrait, Lines, Animations, Recreate: each takes an optional note, e.g. "make
  him grumpier"), **Undo last reroll**, and **Remove** (confirm). Generations in flight show as pulsing cards; a failed
  one shows why, with **Retry**, or **Invent someone like them** when the model declined to play a character.
  **+ Add a character**, **Export** / **Import…** (shows each incoming character's name and voice first; add to the
  cast, or replace it, with a confirm; a replace with no valid characters is refused) and a link to `/settings/faces`.
  Remove waits for a running reroll of that character (409 meanwhile), so a finishing reroll can't bring it back.
- **An imported cast is trusted text**: each character's `voice` goes verbatim into the prompt of every session the
  app starts (sessions with tool access). Import only files you'd paste into a prompt yourself.
- **Generation model** (`model`, select: opus (default), fable, sonnet). Read per job.
- **Characters to start with** (`seed`, comma-separated): what the first-run page asked; used only at the first start (see above).

Rerolls only regenerate; nothing is hand-edited in the UI. A reroll replaces:

| Part | Replaces | Keeps |
| --- | --- | --- |
| Lines | `voice`, `asks`, `spinner`, `badge` | everything else |
| Portrait | `portrait`, `color`, `palette`, `mode` (the look) | voice, lines, motion |
| Animations | `motion` | everything else |
| Recreate | everything | `id`, `emoji`, `origin`, `createdAt`; the name too unless the host is "inspired" |

`id` and `emoji` never change after creation: old transcripts match asides by emoji, and `/fun host` and the CSS go by
id. The version before the last reroll is kept as `previous` (one step of undo).

## Generation (`generate.ts`, `prompt.ts`)

- Only from a user's request: `POST /api/plugins/menagerie/characters` or `…/characters/:id/regenerate`, each `202
  { jobId }`, or the names the user gave on the first-run page (only at the plugin's first start, if the cast is empty). Never on
  a timer or on a page load.
- One job (`menagerie-generate`, in the header tray as 🎭 Menagerie) per character or reroll: a headless `claude -p`
  through `ctx.headless.askClaudeJson` with the `model` setting, no tools, no MCP (`--strict-mcp-config --tools ''`),
  `--no-session-persistence` in the app's scratch dir, 10-minute timeout. At most two run at once; the rest wait
  ("Waiting for another character to finish…").
- The prompt (`buildPrompt`) asks for one JSON object with only the keys the part replaces, and carries the rules:
  original lines only (no quotes or verbatim catchphrases), a flat cartoon and not a likeness of any photo, real public
  figures only as gentle affectionate parody (no political attacks, never private individuals), and
  `{"declined": "<reason>"}` instead of a watered-down character. It describes the portrait rig, the allowlists and
  the keyframe format, and lists the emoji already taken.
- The answer is parsed, sanitized and validated (`buildCharacter`); on problems, one retry with the problems listed,
  then the job fails with them. A decline fails at once (no paid retry). An answer that isn't JSON counts as bad
  output; a CLI failure doesn't retry.
- Cost: one character took about 95s and $0.08 (as `claude -p` reported it) on opus in testing.
- No resumer: a generation running at a restart comes back failed in the tray.

## The cast file (`<pluginState>/cast.json`, `cast.ts`, `castStore.ts`)

`{ "version": 1, "characters": [Character…] }`, written only by the server (validated, temp file + rename, one write at
a time, mode 0600). Every read goes through the same validator as generated output (`validateCast`): an invalid
character is dropped with a log line, not the file; a file that doesn't parse reads as an empty cast and is left alone
until the next write. Before the first write over a file that didn't parse or held a dropped character, it is copied
to `cast.json.bad-<time>`, so a hand edit with a typo isn't lost. The fields are in `cast.ts` (`Character`); the limits are in `LIMITS` (name ≤ 40, voice ≤ 600,
asks ≤ 8 lines of ≤ 40, spinner ≤ 12, badge ≤ 12; generated characters also need ≥ 4 asks and ≥ 6 spinner entries).

### Portraits (`svg.ts`, `render.ts`)

A portrait is one SVG node tree (`[tag, attrs, children?]`) in a 64×64 viewBox, stored as JSON and drawn with
`createElement`: never `dangerouslySetInnerHTML`. Nodes carry **rig marks** in `class`, which the renderer turns into
the face rig's classes:

| Mark | Becomes | Moves |
| --- | --- | --- |
| `eyes` | `av-eyes` > `av-blink` | glance and blink (exactly one of `eyes`, `eyes-noblink`, `shades`) |
| `eyes-noblink` | `av-eyes` | glance |
| `shades` | `av-shades` | glance (eyes behind glasses) |
| `brows` | `av-brows` | raise, furrow, cock (at most one; required in generated ones) |
| `mouth` with `mouth-rest`, `mouth-smile`, `mouth-o` inside | `av-mouth`, `m-rest`, `m-smile`, `m-o` | three mouths swapped by mood (at most one; required in generated ones) |
| `prop1`, `prop2` | `av-<id>-p1`, `av-<id>-p2` | the host's own loops (`motion.props`) |

Marks may nest (a glint inside shades, eyes on a flapping wing). Model output is SVG text parsed by a strict
tokenizer for a small subset (`parseSvg`): elements, quoted attributes, self-closing tags and whitespace only (no
text, comments, CDATA, entities or processing instructions). Allowed: elements `g path circle ellipse rect line
polyline polygon defs linearGradient radialGradient stop`; geometry, paint, opacity, `fill-rule`, `transform`
(SVG's translate/rotate/scale/skewX/skewY), gradient attributes, `id`, and `class` with a rig mark. Paint is hex, a
basic colour name, `none`, `currentColor` or `url(#id)` naming a gradient defined in the portrait. Numbers −64…128
(path data ±360), no exponents; at most 400 elements and 8 KB of path data. Gradient ids are prefixed with the host
id when drawn. The renderer re-checks tags and attributes against the same lists.

### Animations (`keyframes.ts`)

`motion = { exit, props? }`, keyframes as data: `{ durationMs, easing?, frames: [{ at, transform?, opacity?, filter?,
transformOrigin? }] }` (2–20 frames, `at` 0…100 strictly increasing). `exit` is 800–2500ms and ends at opacity 0;
a prop loop is 800–8000ms. Transforms: translate(X/Y) ±200px/%, rotate ±720deg, scale(X/Y) 0–4, skew(X/Y) ±60deg.
Filters: blur 0–20px, brightness/saturate/sepia 0–8, grayscale 0–1, hue-rotate ±360deg. Easing: linear, ease,
ease-in, ease-out, ease-in-out, steps(1). `castCss` writes the stylesheet from the parsed values only (a host whose
motion doesn't validate is left out and just fades), and `SetupBanner` mounts it as one `<style data-menagerie>` on
every page: `.quip-bye-<id> { --bye; --bye-anim }`, `@keyframes mh-bye-<id>` (the `mh-` prefix keeps a host id from replacing `bye-fade`), and the prop loops inside
`prefers-reduced-motion: no-preference`.

**Invariant:** `BYE_MS` in `parts.tsx` (2.6s) must stay ≥ the longest exit (2.5s, the validator's cap).

## Routes

| Route | What |
| --- | --- |
| `GET /api/menagerie/hosts` | the cast as `FunHost[]` (`toFunHost`: no voice), `[]` when empty; ETag-revalidated |
| `POST /api/plugins/menagerie/characters` `{ named, kind, feedback? }` | add one: 202 `{ jobId }` |
| `POST …/characters/:id/regenerate` `{ part, feedback? }` | 202, 404 unknown, 409 while another job for it runs |
| `POST …/characters/:id/undo` | restore `previous`: 200 or 404 |
| `DELETE …/characters/:id` | remove: 200 or 404 |
| `GET …/export` | the cast file as a download |
| `POST …/import` `{ cast, mode: 'replace' \| 'merge' }` | validated like generated output: `{ added, skipped: [{ id?, reason }] }` |
| `GET …/pending` | generations running or queued in this process (the editor's placeholders); ETag-revalidated |

Bodies are JSON (`readJson`); `named` ≤ 60 chars, `feedback` ≤ 300.

## The bundled Claude mod (`claude/`, `work-hub-menagerie`)

Loaded into every session the app starts (`menagerieLaunchArgs`): `--plugin-dir <plugin>/claude` and an inline
`--settings` with `env.WORK_HUB_MENAGERIE_CAST` (the cast file's path). If the user has a user-scope `menagerie`
Claude plugin installed (the old full one), the same inline settings turn it off for those sessions
(`enabledPlugins: { "<its id>": false }`, the id from `ctx.claude.pluginId('menagerie')`), so asides don't double up
and the generated cast wins. Nothing is written to `~/.claude`.

What it does (`hooks/register.tsx`, pure parts in `hooks/logic.ts`, tested by `mod.test.ts`):

- `session.start`: reads the cast file (missing or empty: the mod does nothing at all; entries breaking the
  validator's basic rules, i.e. id pattern, name ≤ 40, voice ≤ 600, unique id and emoji, are skipped), picks a host (a `rare` one
  about 1 in 20, else a regular one other than last session's), and appends the greeting
  `` `${emoji}  ${name} has moved into your terminal.` `` as a system entry.
- `prompt.compose`: the "# The resident character" section with the host's `voice`: roughly one final reply in three
  ends with `` > <emoji> *the aside* `` as the last line, never in code, files, commits, PRs, tool inputs, plans or
  questions, nor in subagents.
- The spinner word: one of the host's `spinner` entries per turn.
- `/fun`: lists the cast; `/fun host <id>` swaps (`` `${emoji} ${name} has taken over.` ``, shown as
  `work-hub-menagerie: …`); `/fun off` / `/fun on` stop or bring back the asides (kept in the mod's store).

The work-hub side reads those strings back, so change them together: `HOST_MARK` (`hostEnricher.ts`, tested) matches
the greeting and the swap reply (with the `menagerie: ` or `work-hub-menagerie: ` prefix), and `splitAside` (`aside.ts`)
takes an aside only when the reply's last non-empty line is a blockquote holding a known host's emoji (first match in
cast order wins, which is why emoji are unique). `claude/` is Claude's code, not the app's: `tsconfig.json` excludes
`plugins/*/claude/**`; check it with `claude plugin validate plugins/menagerie/claude`.

Caveats: the mod reads the cast once per session, so a session already running keeps a host removed meanwhile (its
asides then show as plain Markdown). If `claude plugin list` fails, the user-scope `menagerie` isn't turned off and
asides can double up in that session.

## Where hosts appear (web)

- `host-provider` slot item (`web.tsx`): `{ useHosts, useMenagerieOn, lastHost, splitAside, askLine, hostVars, frame,
  AsideCard, WorkingPulse, AskHeader, HostInContext, useQuipPhase, QuipScope }`, read by the conversation view, the
  question form and the core's session page through `useHostProvider()`. With the plugin off there is none: asides stay
  plain Markdown and nothing is themed. With no cast, `useHosts()` is `[]`: the same, plus the setup banner.
- **Aside card** (`AsideCard`, `parts.tsx`): the aside peeled off the message with the host's trim, border gradient,
  44px portrait and italic text; `fun-aside fun-<id> fun-<mode>` with the palette from `hostVars()`.
- **Bubble tint**, **questions** (`AskHeader`: portrait, `badge` + name, one `asks` line by `askLine`), the **working
  bubble** (portrait, letters, spinner word in the gradient) and the **quip box** timing (one at a time, `QUIP_MS` 10s,
  then the host's exit for up to `BYE_MS`, expired quips kept in `wh.quipsExpired`): as before; see the comments in
  `parts.tsx` and conversation-view's `History.tsx`.
- **Modes** (`styles.css`, "Each host's motion"): `wave`, `marquee`, `fade`, `flicker`, `stack`, `still`.
- **Faces** (`HostAvatar.tsx`): moods `idle`, `thinking`, `curious`, `pleased`; reactions `nod`, `alarm`, `delight`;
  `--av-amp` (capped by the portrait's `ampCap`), `av-small`, `--av-phase`. `/settings/faces` (`FacesPage.tsx`) shows
  every host in every mood and reaction, with sizes, speed and an "In context" mock log.
- Everything animated is off under `prefers-reduced-motion` (exits become a 0.4s fade).

## Low data and mobile

Nothing in the plugin polls. The cast is one revalidated GET per page load and again after a menagerie job finishes
or the cast changes; job progress rides the `jobs` source on the SSE stream (`castJobs.ts`); `…/pending` is fetched
only when a menagerie job this page doesn't know about shows up. Generation is user-triggered only. The editor's cards
fall to one column at ≤ 700px and every row wraps.

## Tests

`svg.test.ts` (the subset, hostile input), `keyframes.test.ts` (parsing, bounds, CSS only from parsed values),
`cast.test.ts` (schema, rig marks), `castStore.test.ts` (atomic writes, undo, import, corrupt file), `render.test.ts`
(rig classes, attribute filtering, gradient prefixes), `generate.test.ts` (retry, decline, identity pinning, queueing,
busy), `routes.test.ts`, `editorState.test.ts` (placeholders), `mod.test.ts` (the mod's logic and strings),
`hostEnricher.test.ts`, `server.test.ts` (launch args).
