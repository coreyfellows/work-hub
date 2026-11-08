# Writing a local plugin

A local plugin is a folder outside the work-hub repo that work-hub loads like an official one: a manifest, an
optional server half and an optional web half. Keep your own plugins in your own repo; work-hub finds them through
`plugins.json`, so neither repo needs to know about the other's history.

The API is versioned: read `CHANGELOG.md` for the manifest fields, every `ctx` member and every slot.

Or let a session write it: Settings → Plugins → **Create plugin** (the plugin-author plugin) takes a description and a
destination and starts a Claude session that builds the plugin in a new workspace.

## Repo layout

```
my-work-hub-plugins/
  package.json          { "name": "my-work-hub-plugins", "private": true, "type": "module" }
  tsconfig.json         extends work-hub's (below)
  node_modules -> /path/to/work-hub/node_modules   (a symlink, for types and runtime packages)
  plugins/
    standup/
      plugin.json
      server.ts
      web.tsx
      styles.css        optional, imported with web.tsx
      standup.test.ts   optional
      README.md
```

`"type": "module"` matters: Node loads `server.ts` as an ES module with type stripping, the same way it runs work-hub.

## `plugin.json`

```json
{
  "id": "standup",
  "apiVersion": 1,
  "title": "Standup",
  "description": "What I did yesterday, from my workspaces' activity",
  "defaultEnabled": true,
  "server": "server.ts",
  "web": "web.tsx"
}
```

Pick an id no official plugin uses (`core` is reserved). Add `requires: ["github"]` if you use another plugin's
service, or `replaces: "<id>"` to stand in for an official plugin (it's then treated as off while yours is on).
`"skills": "skills"` names a folder of Claude Code skills (`skills/<name>/SKILL.md`): while your plugin is active, each
is `/work-hub:<name>` in the sessions work-hub starts (the core links them into one shared `work-hub` Claude plugin at
startup, so `/reload-plugins` in a running session picks up changes after a restart). Reference files beside a skill as
`${CLAUDE_PLUGIN_ROOT}/skills/<name>/<file>`.
`"claude": "claude"` names a bundled Claude Code plugin folder; it's informational (the core doesn't read it): pass the
folder to sessions yourself with `ctx.sessions.addLaunchArgs` (`--plugin-dir`).

## `server.ts`

```ts
import type { ServerPluginContext } from 'work-hub/plugin-api/server';

export default function register(ctx: ServerPluginContext): void {
  const days = ctx.config.get('days', 1); // WORK_HUB_STANDUP_DAYS, else plugins.json settings.standup.days

  ctx.revalidate(['/api/plugins/standup']); // polled GET JSON: ETag + empty 304 when unchanged
  ctx.app.get('/api/plugins/standup', (c) => {
    const since = Date.now() - days * 86_400_000;
    const items = ctx.store
      .listWorkspaces()
      .filter((w) => Date.parse(w.updatedAt) >= since)
      .map((w) => ({ id: w.id, title: w.title }));
    return c.json({ items });
  });
}
```

Import the API **as types only** (`import type`): Node strips type imports, so nothing has to resolve
`work-hub/plugin-api/server` at runtime. Everything you'd call (store, sessions, exec, git, headless `claude`, jobs,
events) is on `ctx`. Your own files are imported by relative path with their extension (`./standup.ts`). Your editor shows
what each `ctx` member offers from its type (`ctx.store` is the workspace store's functions). A few you'll want often:

- `ctx.sessions.find(id)`: a session by id or short id (the routes' `:id`), refreshing the list once on a miss; use it
  instead of searching `ctx.sessions.list()` yourself.
- `ctx.sessions.trustWorktree(path)`: trust a new worktree under the worktrees root so `claude --bg` starts there
  (sessions you prompt can run `<work-hub>/bin/wh trust <path>` for the same thing).
- `ctx.isAcceptedOrigin(origin)`: the Origin check every WebSocket route needs (`if (!ctx.isAcceptedOrigin(c.req.header('origin'))) return c.text('forbidden origin', 403)`).
- A POST route's body: answer a missing or broken one with a 400, never let `c.req.json()` throw into a 500. Official
  plugins use `readJson(c)` from plugin-api/server.ts (400 `{ error: 'JSON body required' }`); with the API imported
  as types only, do the same yourself: `const b = await c.req.json().catch(() => null); if (!b || typeof b !== 'object') return c.json({ error: 'JSON body required' }, 400);`.

Rules the loader enforces (a plugin that breaks one is skipped, with the reason on the Status page, and what it had
registered is taken back):

- **Routes go under `/api/plugins/<id>/...`** (or an `/api/...` path of your own). That namespace is always free: no core
  route lives below `/api/plugins/<x>/`. A route that would also match one of the core's routes (`CORE_ROUTES` in
  `server/coreRoutes.ts`, e.g. `GET /api/state` or `POST /api/sessions/:id/send`) throws: plugins load before the core's
  routes, so it would shadow them. Methods must agree unless either side is `all`, parameter names don't count, and your
  `:param`, `:param?` and `*` match any core segment(s): `POST /api/sessions/:id/:action` and `ALL /api/sessions/*` are
  refused, `GET /api/sessions/:id/send` (the core's is a POST) is not. Chained calls (`ctx.app.get(…).post(…)`) and
  `ctx.app.basePath(…)` are checked the same way.
- **Source ids are unique**: `ctx.registry.add` throws for an id the core or another plugin already added.
- **`register()` must finish in time**: 30s by default (`WORK_HUB_PLUGIN_TIMEOUT_MS`), else "register() did not finish
  in 30s". Do slow work in `ctx.onStart` (or lazily), not in `register()`. `onStart` hooks of all plugins run at the same
  time once the server listens, each with the same timeout; one that throws or hangs is logged and the rest carry on.

## `web.tsx`

```tsx
import type { WebPluginContext } from 'work-hub/plugin-api/web';
import { get } from 'work-hub/plugin-api/web';
import { useEffect, useState } from 'react';
import './styles.css';

function StandupPage() {
  const [items, setItems] = useState<Array<{ id: string; title: string }> | null>(null);
  useEffect(() => {
    void get<{ items: Array<{ id: string; title: string }> }>('/api/plugins/standup').then((r) => setItems(r.items));
  }, []);
  return (
    <div className="page standup">
      <h2>Standup</h2>
      {items?.map((i) => <div key={i.id}>{i.title}</div>)}
    </div>
  );
}

export default function register(ctx: WebPluginContext): void {
  ctx.contribute('page', { path: '/standup', nav: { label: 'Standup', secondary: true }, component: StandupPage });
}
```

Web code is bundled by work-hub's Vite, which maps `work-hub/plugin-api/web` to the API module, so it may import values
from it (hooks, `get`/`post`, the components kit, `loadHighlightCode()` for highlight.js loaded on demand). `react` and other npm packages come from work-hub's `node_modules`.
The `page` slot is one of many: `plugin-api/web.ts` (`SlotItems`) has every slot and its item type. A slot whose items
carry hooks (`useItem`, `useTabs`, `useActivity`…) is read once when the reader mounts, so contribute in `register`
(module init), never later.

### Palette commands

The ⌘K palette (Ctrl+K off a Mac) has a command mode: a query starting with `>`, or `>` pressed outside an input, or ⇧⌘K (Ctrl+Shift+K) anywhere. A
plugin adds commands in two ways.

**The `palette-commands` slot**, for commands that make sense wherever the user is. `commands(ctx)` is called while the
palette is open: return only what applies. `ctx` has `path`, `workspaceId` (the workspace's page or one of its sessions'
pages, else null), `sessionId` (a session's own page) and `sources`. `group` is the row's kind column (default
"Command"); `hint` is shown dimmed and matched too. A throw or a rejected promise from `run` becomes an error toast.

```tsx
import { navigate, post, type WebPluginContext } from 'work-hub/plugin-api/web';

export default function register(ctx: WebPluginContext): void {
  ctx.contribute('palette-commands', {
    commands: ({ workspaceId }) => [
      { id: 'standup:open', label: 'Open standup', group: 'Standup', run: () => navigate('/standup') },
      ...(workspaceId
        ? [{ id: 'standup:add', label: 'Add this workspace to standup', group: 'Standup', run: () => post('/api/plugins/standup/add', { workspaceId }) }]
        : []),
    ],
  });
}
```

**`usePaletteCommands(list | null)`**, for commands tied to something on screen (a panel's own actions). They're offered
while the calling component is mounted, and the latest list is read whenever the palette renders, so closures stay fresh.
On an id clash, the component mounted last wins.

```tsx
import { usePaletteCommands } from 'work-hub/plugin-api/web';

function StandupPanel({ refresh }: { refresh(): void }) {
  usePaletteCommands([{ id: 'standup:refresh', label: 'Refresh standup', group: 'Standup', run: refresh }]);
  return <div className="standup-panel">…</div>;
}
```

Items you add to a session's or workspace's ⋯ menu (`session-action`, `workspace-action`) or to the workspace tab strip's
+ menu (`tabstrip-action`, a tab kind's `menu`) become commands by themselves (submenus as "Item › Sub-item"; hidden and
disabled items left out). Mark a menu item `palette: false` to keep it out, e.g. when you register a better command for it.
`openPalette('>')` opens the palette on the commands from your own button.

## `plugins.json`

In work-hub's config dir (`~/.config/work-hub/plugins.json`, or `$WORK_HUB_CONFIG_DIR`):

```json
{
  "local": ["/Users/you/my-work-hub-plugins/plugins"],
  "enabled": { "standup": true },
  "settings": { "standup": { "days": 3 } }
}
```

A `local` entry is a plugin folder (it has `plugin.json`) or a folder of plugin folders. Settings → Plugins can edit
`local` and `enabled` too. Then `pnpm build` and restart work-hub (in `pnpm dev`, restart it: a new local folder needs a
fresh dev server). The Status page lists your plugin as active, or skipped with the reason.

## The import rule

A plugin may import only npm packages (and `node:` builtins), files inside its own folder, and
`work-hub/plugin-api/server` / `work-hub/plugin-api/web`. Never anything else from work-hub (`server/…`, `web/src/…`):
those are internals and change without notice; the plugin API is what's kept stable. If you need something the API
doesn't offer, propose adding it to `plugin-api/` in work-hub (an additive change).

Check a plugin folder against this rule with `pnpm check-plugin <folder>` (run in work-hub; exit 1 and a list of the
offending imports when something reaches into the core). work-hub also runs the same check on every local plugin at
startup and logs a warning per offending import (`[plugin <id>] imports outside plugin-api: …`); it still loads it.

A local plugin can't add npm dependencies to work-hub's build: use packages work-hub already has.

## tsconfig and checks

```json
{
  "extends": "/path/to/work-hub/tsconfig.json",
  "compilerOptions": {
    "paths": { "work-hub/plugin-api/*": ["/path/to/work-hub/plugin-api/*.ts"] }
  },
  "include": ["plugins", "/path/to/work-hub/web/src/vite-env.d.ts"]
}
```

- `extends` brings the same strictness and module settings (NodeNext, `allowImportingTsExtensions`,
  `erasableSyntaxOnly`, `verbatimModuleSyntax`, `jsx: react-jsx`).
- `paths` must be repeated with absolute paths, because a `paths` entry resolves relative to the config that declares
  it.
- `vite-env.d.ts` gives the types for CSS imports and Vite globals that the API's web module uses.
- `node_modules` as a symlink to work-hub's lets `tsc` find React, Node and Hono types, and lets Node resolve any
  runtime npm import in `server.ts`.

Then `tsc --noEmit` (add `"typecheck": "tsc --noEmit"` to your `package.json`) and
`node --test 'plugins/**/*.test.ts'` for tests.

## `apiVersion`

Declare the version you wrote against (`1`). If work-hub moves to another version, your plugin is skipped at startup
with "needs plugin API v<n> (declares v<m>): see CHANGELOG.md, "Plugin API <n>" → "Migration steps""; the rest of the app keeps working. `CHANGELOG.md` has
the migration steps for each version, written for an agent to follow: ask yours to migrate the plugin, then bump
`apiVersion`. Additive changes (new slots, new `ctx` members) never bump the version.
