# health

Local connection health, checked without spending tokens, feeding the header's connection dot and the Status page.

## What it does

- **Source `health`** ("Connections", every 5 minutes by default; polled through the registry like every source, so
  only while someone is watching). `GET /api/state` lists it as `{ id: "health", data: { checks: [...], mcp: [...] } }`.
  - `checks[]` (`HealthCheck`: `id`, `label`, `ok`, `level`, `detail`):
    - `claude-auth`: `claude auth status --json` says you're signed in.
    - `gh-auth`: `gh auth status --hostname <githubHost>` succeeds.
  - `mcp[]` (`McpServer`: `name`, `state` connected / needs-auth / failed / unknown, `detail`, `watched`): parsed from
    `claude mcp list` (which connects to each server), run in the cache dir so no project's `.mcp.json` is picked up.
    A `!` mark is a warning, not necessarily auth: "! Connected · tools fetch failed" counts as connected; only
    "Needs authentication" is `needs-auth`. If the command itself fails, one `claude mcp list` entry (`unknown`,
    watched) carries the error.
  - `level` says how much a failed check matters: `fire` turns the dot red, `warn` is listed on the Status page,
    `info` is listed only.
- **`health-issues` slot** (order 0, ahead of the other contributors): a failed check that isn't `info`, and every
  watched MCP server that isn't connected (`fire`, "run /mcp in Claude Code to reconnect"). The core's
  `collectIssues` (`web/src/health.ts`) merges these with its own "source can't update" issues and the other
  plugins'; any `fire` issue turns the connection dot red.
- **`status-block` slot**: "This machine" (order 20, between Plugins and the data sources): one ✓/✗ row per check and per MCP
  server; unwatched servers are dimmed.

Types (`HealthData`, `HealthCheck`, `McpServer`) live in `types.ts`, shared by both halves and re-exported from `web.tsx`.

## Settings

Read with `ctx.config.get`: env `WORK_HUB_HEALTH_<KEY>` first, then `plugins.json` `settings.health.<key>`.

| key | default | what |
| --- | --- | --- |
| `intervalMs` | `300000` (`WORK_HUB_HEALTH_INTERVAL_MS`) | how often the source refreshes |
| `watchedMcp` | empty: none (old env `WORK_HUB_WATCHED_MCP` still honoured) | MCP servers whose failure turns the dot red; others are just listed. Comma-separated, or a list in plugins.json |
| `githubHost` | `WORK_HUB_GH_HOST`, else the `github` plugin's host (its `host` setting, else the host `gh auth status` reports), else `github.com` while that plugin is off | host for the `gh auth status` check |

## Not here

- The HTTPS certificate expiry check (`tls`) that the core used to run is left out: it belongs to the opt-in auth
  plugin (TODO there), and only applies when a public hostname with its own certificate is configured.
