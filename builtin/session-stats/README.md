# session-stats

A line under each session's header: tokens used, what that usage would cost at Claude API list prices, and a
"Files changed (N)" button.

- **Tokens**: input + output + cache write + cache read, summed over every response in the transcript (hover for the
  breakdown and the response count).
- **Cost** ("≈ $1.23 API-equivalent"): per response, from the model's list price (`pricing.ts`). A subscription isn't billed
  per token, so this is an estimate, not a bill. Responses from a model without a known rate are left out and named in the
  tooltip; with none priced the cost is hidden.
- **Files changed**: the files the session changed with Claude's Edit/Write tools and (via the Bash snapshot hook) shell
  commands. The button opens a modal: a file tree beside the selected file's net change; each file's edits are fetched on
  open from the core route `GET /api/sessions/:id/file-edits?path=`.

## Route

`GET /api/sessions/:id/stats` (ETag-revalidated through `ctx.revalidate`): `{ tokens, costUsd, unpricedModels, responses,
files }` (`SessionStats` in `types.ts`), or `null` if the transcript can't be read. Built by `stats.ts` from
`ctx.sessions.sessionUsage` (model + usage per response) and `ctx.sessions.sessionEdits` (every recorded file change).

## Slot

`session-header` item `stats`; the core renders the slot between the session header and the view tabs. Polls every 15s
while the tab is visible. In Low data it loads on opening and on tap only, and shows `<AsOf>` ("as of 3m ago ↻").

## Pricing table

`pricing.ts` holds `RATES`: USD per million tokens (input, output, cache read) by model id (a `[1m]` suffix is ignored).
Cache writes are 1.25x input for the 5-minute TTL and 2x for the 1-hour TTL. To update when prices change or a model
ships, edit `RATES` (and the source note at the top of the file) and run `pnpm test` (`stats.test.ts` pins the arithmetic).
There are no settings.
