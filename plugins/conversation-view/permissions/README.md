# permissions (a conversation-view feature)

Answer a background session's tool-permission menu ("Do you want to proceed?") from the Chat/Log views, so a session
blocked on a permission prompt no longer needs the Terminal view, and keep an allowlist of tools that sessions work-hub
starts may use without asking. Default on.

## Allowlist (Settings → Session permissions)

Claude Code permission rules (`Read`, `Bash(git log:*)`, `mcp__server__tool`), one per line, edited in Settings and saved
in `<state>/plugins/conversation-view/allowed-tools.json` (`{}` or missing = the defaults). Every session the core starts
gets them through a launch-args fn as `--settings {"permissions":{"allow":[…]}}` (the core folds several plugins'
`--settings` into one, since Claude keeps only the last). Sessions already running keep what they started with.
`allowlist.ts` (tested) has the defaults: `wh`, ticket-workflow's `trust-worktree.sh`, `git worktree add/list`, read-only
git, `git add/commit`, `claude --bg/agents/logs`, read-only `gh pr`, `pnpm test/typecheck`, `npm test`.
`GET /api/permissions/allowed-tools` → `{ rules, defaults, custom }`; `POST` `{ rules }` saves, `{ reset: true }` restores the
defaults. Save and Reset show a toast with Undo.

## Server

- `GET /api/sessions/:id/permission` → `{ prompt: { title, body[], question, options: [{ n, label }] } | null }`, read from
  Claude's current screen (`claude logs` → `ansiToHtml` → `parsePermissionPrompt` in `prompt.ts`, tested). ETag-revalidated.
- The GET also returns `rule`: the allowlist rule "Yes, always allow" would save (`rule.ts`, tested). Only a Bash prompt that is
  one plain command gets one: `git log:*` style prefixes (two words for git/gh/pnpm/npm…), the exact command for risky programs
  (`rm`, `curl`, `sudo`…), none for pipes, `&&`, redirects or env prefixes. Other tools' prompts get no button (use Claude's own
  "don't ask again" choice, or Settings).
- `POST /api/sessions/:id/permission` `{ option, label, always? }` types the option's number. With `always` (on choice 1) it first
  adds the rule to the allowlist (making it customised; sessions started later don't ask) and presses Claude's own "Yes, and don't
  ask again" choice instead when the menu has one, so the running session remembers too. It re-reads the screen first and
  refuses (409) unless the menu is still there with that label under that number. Background sessions only.

## Web

`PermissionPrompt.tsx` is a `composer-addon` (order 5). It shows while the session's `waitingFor` (from `claude agents`)
is `"permission prompt"`, polling the GET every 4s (15s in Low data) so a second prompt right after the first appears.
One button per choice; the first is primary, a "No…" choice is red. When `rule` is set, a "Yes, always allow `<rule>`" button follows (toast with the saved rule).
